import Fastify, { LogController, type FastifyInstance } from "fastify";
import { AuthService } from "../auth/service.js";
import { createAdminAuthorizationService } from "../admin-auth/factory.js";
import type { AdminAuthorizationService } from "../admin-auth/service.js";
import type { GatewayConfig } from "../config.js";
import { GatewayError, toGatewayError } from "../core/errors.js";
import { createControlPlaneRuntime } from "../control-plane/runtime.js";
import type { VirtualKeyControlPlaneService } from "../control-plane/service.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { createTraceContext } from "../observability/trace.js";
import { MockProvider } from "../providers/mock-provider.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible/provider.js";
import { ProviderRegistry } from "../providers/registry.js";
import { ModelRouter } from "../routing/model-router.js";
import { createQuotaRuntime } from "../quota/factory.js";
import type { QuotaService } from "../quota/service.js";
import type { GovernanceService } from "../governance/service.js";
import { registerChatCompletionRoutes } from "./routes/chat-completions.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerAdminVirtualKeyRoutes } from "./routes/admin-virtual-keys.js";
import { registerAdminGovernanceRoutes } from "./routes/admin-governance.js";
import "./fastify.js";

export interface AppDependencies {
  config: GatewayConfig;
  authService?: AuthService;
  quotaService?: QuotaService;
  registry?: ProviderRegistry;
  metricsRegistry?: MetricsRegistry;
  controlPlaneService?: VirtualKeyControlPlaneService;
  readiness?: () => Promise<void>;
  adminAuthorizationService?: AdminAuthorizationService;
  governanceService?: GovernanceService;
}

const unauthenticatedPaths = new Set(["/health/live", "/health/ready"]);

const isValidationError = (
  error: unknown,
): error is Error & { validation: unknown[] } =>
  error instanceof Error &&
  "validation" in error &&
  Array.isArray(error.validation);

const isFrameworkClientError = (
  error: unknown,
): error is Error & { statusCode: number } =>
  error instanceof Error &&
  !(error instanceof GatewayError) &&
  "statusCode" in error &&
  typeof error.statusCode === "number" &&
  error.statusCode >= 400 &&
  error.statusCode < 500;

export const buildApp = async (
  dependencies: AppDependencies,
): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: { level: dependencies.config.logLevel },
    requestIdHeader: "x-request-id",
    logController: new LogController({ disableRequestLogging: true }),
  });

  const registry = dependencies.registry ?? new ProviderRegistry();
  const metricsRegistry = dependencies.metricsRegistry ?? new MetricsRegistry();
  const controlPlaneRuntime = dependencies.controlPlaneService
    ? undefined
    : await createControlPlaneRuntime(dependencies.config, (error) => {
        app.log.error({ err: error }, "postgres control-plane pool error");
      }, registry);
  if (controlPlaneRuntime) {
    app.log.info("postgres virtual-key control plane initialized");
    app.addHook("onClose", async () => controlPlaneRuntime.close());
  }
  const authService =
    dependencies.authService ??
    controlPlaneRuntime?.authService ??
    AuthService.fromSeeds(dependencies.config.virtualKeys, dependencies.config.keyPepper);
  const quotaRuntime = dependencies.quotaService
    ? undefined
    : await createQuotaRuntime(dependencies.config, (error) => {
        app.log.error({ err: error }, "redis quota backend error");
      });
  const quotaService = dependencies.quotaService ?? quotaRuntime?.service;
  if (!quotaService) throw new Error("Quota service initialization failed");
  if (quotaRuntime) {
    app.log.info(
      { backend: quotaRuntime.backend },
      "quota service initialized",
    );
    app.addHook("onClose", async () => quotaRuntime.close());
  }
  if (!dependencies.registry) {
    registry.register("general", new MockProvider(), { id: "mock-general" });
    for (const external of dependencies.config.openAICompatibleDeployments) {
      registry.register(
        external.logicalModel,
        new OpenAICompatibleProvider({
          id: external.id,
          baseUrl: external.baseUrl,
          apiKey: external.apiKey,
          providerModel: external.providerModel,
        }),
        {
          id: external.id,
          priority: external.priority,
          weight: external.weight,
        },
      );
    }
  }
  const router = new ModelRouter(
    registry,
    dependencies.config.routing,
    Date.now,
    Math.random,
    metricsRegistry,
  );

  app.decorateRequest("authContext", undefined);
  app.decorateRequest("traceContext", undefined);
  app.decorateRequest("adminIdentity", undefined);

  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers.traceparent;
    request.traceContext = createTraceContext(
      typeof incoming === "string" ? incoming : undefined,
    );
    reply.header("traceparent", request.traceContext.traceparent);
  });

  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (unauthenticatedPaths.has(path)) return;
    if (dependencies.config.metricsEnabled && path === "/metrics") return;
    if (path.startsWith("/admin/v1/")) return;
    request.authContext = await authService.authenticate(
      request.headers.authorization,
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    metricsRegistry.recordHttp(
      request.method,
      request.routeOptions.url ?? "unmatched",
      reply.statusCode,
      reply.elapsedTime,
    );
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        path: request.routeOptions.url,
        statusCode: reply.statusCode,
        responseTimeMs: reply.elapsedTime,
        keyId: request.authContext?.keyId,
        tenantId: request.authContext?.tenantId,
        projectId: request.authContext?.projectId,
        applicationId: request.authContext?.applicationId,
        adminActorId: request.adminIdentity?.actorId,
        adminRoles: request.adminIdentity?.roles,
        traceId: request.traceContext?.traceId,
      },
      "request completed",
    );
  });

  app.setErrorHandler((error, request, reply) => {
    const gatewayError = toGatewayError(error);
    const clientError = isValidationError(error) || isFrameworkClientError(error);
    const responseError = clientError
      ? new GatewayError({
          message: "The request body is invalid",
          statusCode: 400,
          code: "invalid_request_error",
          cause: error,
        })
      : gatewayError;
    metricsRegistry.recordGatewayError(responseError.code);

    request.log[responseError.statusCode >= 500 ? "error" : "warn"](
      {
        err: error,
        requestId: request.id,
        errorCode: responseError.code,
        retryable: responseError.retryable,
        traceId: request.traceContext?.traceId,
      },
      responseError.message,
    );

    return reply.status(responseError.statusCode).send({
      error: {
        message: responseError.message,
        type: responseError.code,
        code: responseError.code,
        retryable: responseError.retryable,
        request_id: request.id,
      },
    });
  });

  await registerHealthRoutes(app, {
    ...(dependencies.readiness
      ? { readiness: dependencies.readiness }
      : controlPlaneRuntime
        ? { readiness: controlPlaneRuntime.readiness }
        : {}),
  });
  if (dependencies.config.metricsEnabled) {
    await registerMetricsRoutes(app, {
      registry: metricsRegistry,
      bearerToken: dependencies.config.metricsBearerToken,
    });
  }
  const controlPlaneService = dependencies.controlPlaneService ?? controlPlaneRuntime?.service;
  const governanceService = dependencies.governanceService ?? controlPlaneRuntime?.governanceService;
  const adminAuthorization = dependencies.adminAuthorizationService ?? createAdminAuthorizationService(dependencies.config);
  if (controlPlaneService && adminAuthorization) {
    await registerAdminVirtualKeyRoutes(app, {
      service: controlPlaneService,
      authorization: adminAuthorization,
      rotationApprovalRequired: dependencies.config.rotationApprovalRequired,
    });
  }
  if (governanceService && adminAuthorization) {
    quotaService.setDynamicPolicySource((context) => governanceService.quotaPolicies(context));
    await registerAdminGovernanceRoutes(app, { service: governanceService, authorization: adminAuthorization });
  }
  await registerModelRoutes(app, { authService, registry });
  await registerChatCompletionRoutes(app, {
    config: dependencies.config,
    authService,
    quotaService,
    registry,
    router,
    ...(governanceService ? { governanceService } : {}),
  });

  return app;
};
