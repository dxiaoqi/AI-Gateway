import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayConfig } from "../../config.js";
import type { AuthService } from "../../auth/service.js";
import type { CanonicalChatRequest } from "../../core/canonical-schema.js";
import type { CanonicalStreamEvent } from "../../core/canonical-schema.js";
import { toGatewayError } from "../../core/errors.js";
import type { RequestContext } from "../../core/request-context.js";
import { estimateReservationTokens } from "../../quota/estimator.js";
import type { QuotaService } from "../../quota/service.js";
import type { QuotaReservation } from "../../quota/types.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ModelDeployment } from "../../providers/registry.js";
import type { ModelRouter } from "../../routing/model-router.js";
import type { GovernanceService } from "../../governance/service.js";
import {
  ChatCompletionRequestSchema,
  type ChatCompletionRequest,
} from "../schemas.js";

interface RouteDependencies {
  config: GatewayConfig;
  authService: AuthService;
  quotaService: QuotaService;
  registry: ProviderRegistry;
  router: ModelRouter;
  governanceService?: GovernanceService;
}

const enforceGovernance = async (request: FastifyRequest<{ Body: ChatCompletionRequest }>, service?: GovernanceService) => {
  if (!service || !request.authContext) return;
  const content = request.body.messages.map((message) => message.content).join("\n");
  await service.inspect(request.authContext, content);
  await service.assertBudget(request.authContext);
};

const recordUsageSafely = async (request: FastifyRequest, service: GovernanceService | undefined, model: string, inputTokens: number, outputTokens: number) => {
  if (!service || !request.authContext) return;
  try { await service.recordUsage(request.authContext, model, inputTokens, outputTokens); }
  catch (error) { request.log.error({ err: error, requestId: request.id, traceId: request.traceContext?.traceId }, "governance usage recording failed"); }
};

const toCanonicalRequest = (
  body: ChatCompletionRequest,
  defaultMaxOutputTokens: number,
): CanonicalChatRequest => {
  const request: CanonicalChatRequest = {
    logicalModel: body.model,
    messages: body.messages,
  };
  if (body.temperature !== undefined) request.temperature = body.temperature;
  request.maxOutputTokens = body.max_tokens ?? defaultMaxOutputTokens;
  if (body.metadata !== undefined) request.metadata = body.metadata;
  return request;
};

const settleQuotaSafely = async (
  request: FastifyRequest,
  quotaService: QuotaService,
  reservation: QuotaReservation | undefined,
  actualTokens: number,
): Promise<void> => {
  try {
    await quotaService.settle(reservation, actualTokens);
  } catch (error) {
    request.log.error(
      {
        err: error,
        requestId: request.id,
        traceId: request.traceContext?.traceId,
      },
      "quota settlement failed; reservation remains conservative",
    );
  }
};

const cancelQuotaSafely = async (
  request: FastifyRequest,
  quotaService: QuotaService,
  reservation: QuotaReservation | undefined,
): Promise<void> => {
  try {
    await quotaService.cancel(reservation);
  } catch (error) {
    request.log.error(
      {
        err: error,
        requestId: request.id,
        traceId: request.traceContext?.traceId,
      },
      "quota cancellation failed; reservation will expire",
    );
  }
};

interface RequestLifetime {
  context: RequestContext;
  dispose: () => void;
}

const createRequestLifetime = (
  request: FastifyRequest,
  reply: FastifyReply,
  timeoutMs: number,
): RequestLifetime => {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const timeout = setTimeout(abort, timeoutMs);
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);

  return {
    context: {
      requestId: request.id,
      startedAt: performance.now(),
      signal: controller.signal,
      ...(request.traceContext
        ? {
            traceId: request.traceContext.traceId,
            traceparent: request.traceContext.traceparent,
          }
        : {}),
    },
    dispose: () => {
      clearTimeout(timeout);
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    },
  };
};

const toOpenAIStreamChunk = (
  event: CanonicalStreamEvent,
  responseId: string,
  logicalModel: string,
  created: number,
  providerId: string,
  deploymentId?: string,
  routeAttempts?: number,
): Record<string, unknown> => {
  if (event.type === "response_start") {
    return {
      id: event.responseId,
      object: "chat.completion.chunk",
      created,
      model: logicalModel,
      choices: [
        { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
      ],
      gateway: {
        provider: providerId,
        provider_model: event.providerModel,
        deployment: deploymentId,
        route_attempts: routeAttempts,
      },
    };
  }
  if (event.type === "content_delta") {
    return {
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model: logicalModel,
      choices: [
        { index: 0, delta: { content: event.content }, finish_reason: null },
      ],
    };
  }
  if (event.type === "usage") {
    return {
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model: logicalModel,
      choices: [],
      usage: {
        prompt_tokens: event.usage.inputTokens,
        completion_tokens: event.usage.outputTokens,
        total_tokens: event.usage.totalTokens,
      },
      gateway: { usage_estimated: event.usage.estimated },
    };
  }
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created,
    model: logicalModel,
    choices: [
      { index: 0, delta: {}, finish_reason: event.finishReason },
    ],
  };
};

const writeSse = async (
  reply: FastifyReply,
  payload: string,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) throw signal.reason;
  if (!reply.raw.write(`data: ${payload}\n\n`)) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        reply.raw.off("drain", onDrain);
        reply.raw.off("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("The downstream client closed the response stream"));
      };
      const onAbort = (): void => {
        cleanup();
        reject(signal.reason);
      };
      reply.raw.once("drain", onDrain);
      reply.raw.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (reply.raw.destroyed) onClose();
      else if (signal.aborted) onAbort();
    });
  }
  if (signal.aborted) throw signal.reason;
};

const streamCompletion = async (
  request: FastifyRequest<{ Body: ChatCompletionRequest }>,
  reply: FastifyReply,
  dependencies: RouteDependencies,
): Promise<FastifyReply> => {
  if (!request.authContext) {
    throw new Error("Authenticated request context is missing");
  }
  dependencies.authService.assertModelAccess(
    request.authContext,
    request.body.model,
  );
  const canonicalRequest = toCanonicalRequest(
    request.body,
    dependencies.config.defaultMaxOutputTokens,
  );
  const reservation = await dependencies.quotaService.reserve(
    request.authContext,
    request.id,
    estimateReservationTokens(canonicalRequest),
  );
  let lifetime: RequestLifetime | undefined;
  let iterator: AsyncIterator<CanonicalStreamEvent> | undefined;
  let deployment: ModelDeployment | undefined;
  let streamAttemptStartedAt: number | undefined;
  let streamAttemptFinished = false;
  const created = Math.floor(Date.now() / 1000);
  let headersSent = false;
  let actualTokens: number | undefined;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    lifetime = createRequestLifetime(
      request,
      reply,
      dependencies.config.providerTimeoutMs,
    );
    // The router may switch deployments only before this first event is sent.
    const routed = await dependencies.router.startStream(
      canonicalRequest,
      lifetime.context,
    );
    iterator = routed.iterator;
    deployment = routed.deployment;
    streamAttemptStartedAt = routed.attemptStartedAt;
    const first = routed.first;
    request.log.info(
      {
        logicalModel: request.body.model,
        deploymentId: deployment.id,
        providerId: deployment.provider.id,
        routeAttempts: routed.attempts,
        traceId: request.traceContext?.traceId,
      },
      "model deployment selected",
    );

    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("cache-control", "no-cache, no-transform");
    reply.raw.setHeader("x-request-id", request.id);
    if (request.traceContext) {
      reply.raw.setHeader("traceparent", request.traceContext.traceparent);
    }
    reply.raw.flushHeaders();
    headersSent = true;

    await writeSse(
      reply,
      JSON.stringify(
        toOpenAIStreamChunk(
          first,
          first.responseId,
          request.body.model,
          created,
          deployment.provider.id,
          deployment.id,
          routed.attempts,
        ),
      ),
      lifetime.context.signal,
    );

    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      if (result.value.type === "usage") {
        actualTokens = result.value.usage.totalTokens;
        inputTokens = result.value.usage.inputTokens;
        outputTokens = result.value.usage.outputTokens;
        dependencies.router.recordStreamTokens(
          deployment,
          result.value.usage.inputTokens,
          result.value.usage.outputTokens,
          result.value.usage.estimated,
        );
      }
      await writeSse(
        reply,
        JSON.stringify(
          toOpenAIStreamChunk(
            result.value,
            first.responseId,
            request.body.model,
            created,
            deployment.provider.id,
          ),
        ),
        lifetime.context.signal,
      );
    }
    dependencies.router.finishStreamSuccess(deployment, streamAttemptStartedAt);
    streamAttemptFinished = true;
    await settleQuotaSafely(
      request,
      dependencies.quotaService,
      reservation,
      actualTokens ?? reservation?.reservedTokens ?? 0,
    );
    await recordUsageSafely(request, dependencies.governanceService, request.body.model, inputTokens, outputTokens);
    await writeSse(reply, "[DONE]", lifetime.context.signal);
    reply.raw.end();
    return reply;
  } catch (error) {
    if (
      deployment &&
      streamAttemptStartedAt !== undefined &&
      !streamAttemptFinished
    ) {
      dependencies.router.finishStreamFailure(
        deployment,
        streamAttemptStartedAt,
        error,
      );
      streamAttemptFinished = true;
    }
    await cancelQuotaSafely(request, dependencies.quotaService, reservation);
    if (!headersSent) throw error;
    const gatewayError = toGatewayError(error);
    request.log.warn(
      {
        err: error,
        errorCode: gatewayError.code,
        requestId: request.id,
        traceId: request.traceContext?.traceId,
      },
      "stream terminated with an error",
    );
    if (!reply.raw.writableEnded && !reply.raw.destroyed) {
      await writeSse(
        reply,
        JSON.stringify({
          error: {
            message: gatewayError.message,
            type: gatewayError.code,
            code: gatewayError.code,
            retryable: gatewayError.retryable,
            request_id: request.id,
          },
        }),
        new AbortController().signal,
      );
      reply.raw.end();
    }
    return reply;
  } finally {
    await iterator?.return?.();
    lifetime?.dispose();
  }
};

export const registerChatCompletionRoutes = async (
  app: FastifyInstance,
  dependencies: RouteDependencies,
): Promise<void> => {
  app.post<{ Body: ChatCompletionRequest }>(
    "/v1/chat/completions",
    { schema: { body: ChatCompletionRequestSchema } },
    async (request, reply) => {
      await enforceGovernance(request, dependencies.governanceService);
      if (request.body.stream === true) {
        return streamCompletion(request, reply, dependencies);
      }

      if (!request.authContext) {
        throw new Error("Authenticated request context is missing");
      }
      dependencies.authService.assertModelAccess(
        request.authContext,
        request.body.model,
      );
      const canonicalRequest = toCanonicalRequest(
        request.body,
        dependencies.config.defaultMaxOutputTokens,
      );
      const reservation = await dependencies.quotaService.reserve(
        request.authContext,
        request.id,
        estimateReservationTokens(canonicalRequest),
      );
      const lifetime = createRequestLifetime(
        request,
        reply,
        dependencies.config.providerTimeoutMs,
      );

      try {
        const routed = await dependencies.router.complete(
          canonicalRequest,
          lifetime.context,
        );
        const response = routed.value;
        request.log.info(
          {
            logicalModel: request.body.model,
            deploymentId: routed.deployment.id,
            providerId: routed.deployment.provider.id,
            routeAttempts: routed.attempts,
            traceId: request.traceContext?.traceId,
          },
          "model deployment selected",
        );

        await settleQuotaSafely(
          request,
          dependencies.quotaService,
          reservation,
          response.usage.totalTokens,
        );
        await recordUsageSafely(request, dependencies.governanceService, request.body.model, response.usage.inputTokens, response.usage.outputTokens);

        return {
          id: response.id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: request.body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: response.content },
              finish_reason: response.finishReason,
            },
          ],
          usage: {
            prompt_tokens: response.usage.inputTokens,
            completion_tokens: response.usage.outputTokens,
            total_tokens: response.usage.totalTokens,
          },
          gateway: {
            provider: routed.deployment.provider.id,
            deployment: routed.deployment.id,
            provider_model: response.providerModel,
            route_attempts: routed.attempts,
            usage_estimated: response.usage.estimated,
            request_id: request.id,
          },
        };
      } catch (error) {
        await cancelQuotaSafely(
          request,
          dependencies.quotaService,
          reservation,
        );
        throw error;
      } finally {
        lifetime.dispose();
      }
    },
  );
};
