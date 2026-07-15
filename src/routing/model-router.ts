import type {
  CanonicalChatRequest,
  CanonicalChatResponse,
  CanonicalStreamEvent,
} from "../core/canonical-schema.js";
import { GatewayError, toGatewayError } from "../core/errors.js";
import type { RequestContext } from "../core/request-context.js";
import type { ModelDeployment } from "../providers/registry.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ProviderAttemptMetadata, RoutingObserver } from "../observability/types.js";
import { noopRoutingObserver } from "../observability/types.js";

export interface RoutingPolicy {
  maxAttempts: number;
  rateLimitCooldownMs: number;
  circuitFailureThreshold: number;
  circuitOpenMs: number;
}

export interface RoutingResult<T> {
  value: T;
  deployment: ModelDeployment;
  attempts: number;
}

export interface StreamRoutingResult {
  first: CanonicalStreamEvent & { type: "response_start" };
  iterator: AsyncIterator<CanonicalStreamEvent>;
  deployment: ModelDeployment;
  attempts: number;
  attemptStartedAt: number;
}

interface HealthState {
  consecutiveFailures: number;
  cooldownUntil: number;
  openUntil: number;
  halfOpenInFlight: boolean;
}

const fallbackCodes = new Set([
  "provider_authentication_error",
  "provider_invalid_response",
  "provider_rate_limited",
  "provider_timeout",
  "provider_unavailable",
]);

const circuitFailureCodes = new Set([
  "provider_authentication_error",
  "provider_invalid_response",
  "provider_timeout",
  "provider_unavailable",
]);

export class ModelRouter {
  private readonly health = new Map<string, HealthState>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly policy: RoutingPolicy,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
    private readonly observer: RoutingObserver = noopRoutingObserver,
  ) {}

  private metadata(deployment: ModelDeployment, stream: boolean): ProviderAttemptMetadata {
    return {
      logicalModel: deployment.logicalModel,
      deploymentId: deployment.id,
      providerId: deployment.provider.id,
      stream,
    };
  }

  private state(deployment: ModelDeployment): HealthState {
    const key = `${deployment.logicalModel}:${deployment.id}`;
    const existing = this.health.get(key);
    if (existing) return existing;
    const created: HealthState = {
      consecutiveFailures: 0,
      cooldownUntil: 0,
      openUntil: 0,
      halfOpenInFlight: false,
    };
    this.health.set(key, created);
    return created;
  }

  private acquire(deployment: ModelDeployment, stream: boolean): boolean {
    const state = this.state(deployment);
    const now = this.now();
    if (state.cooldownUntil > now || state.openUntil > now) return false;
    if (state.consecutiveFailures >= this.policy.circuitFailureThreshold) {
      if (state.halfOpenInFlight) return false;
      state.halfOpenInFlight = true;
      this.observer.routingEvent(this.metadata(deployment, stream), "half_open");
    }
    return true;
  }

  private isSelectable(deployment: ModelDeployment): boolean {
    const state = this.state(deployment);
    const now = this.now();
    if (state.cooldownUntil > now || state.openUntil > now) return false;
    return !(
      state.consecutiveFailures >= this.policy.circuitFailureThreshold &&
      state.halfOpenInFlight
    );
  }

  private choose(
    logicalModel: string,
    attempted: Set<string>,
    stream: boolean,
  ): ModelDeployment | undefined {
    const candidates = this.registry
      .getDeployments(logicalModel)
      .filter((deployment) => !attempted.has(deployment.id))
      .filter((deployment) => this.isSelectable(deployment));
    if (candidates.length === 0) return undefined;
    const priority = Math.min(...candidates.map((item) => item.priority));
    const tier = candidates.filter((item) => item.priority === priority);
    const totalWeight = tier.reduce((sum, item) => sum + item.weight, 0);
    let cursor = this.random() * totalWeight;
    for (const deployment of tier) {
      cursor -= deployment.weight;
      if (cursor < 0) return this.acquire(deployment, stream) ? deployment : undefined;
    }
    const last = tier[tier.length - 1];
    return last && this.acquire(last, stream) ? last : undefined;
  }

  recordSuccess(deployment: ModelDeployment, stream = false): void {
    const state = this.state(deployment);
    const recovered =
      state.consecutiveFailures > 0 ||
      state.cooldownUntil > 0 ||
      state.openUntil > 0 ||
      state.halfOpenInFlight;
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
    state.openUntil = 0;
    state.halfOpenInFlight = false;
    if (recovered) {
      this.observer.routingEvent(this.metadata(deployment, stream), "recovered");
    }
  }

  recordFailure(deployment: ModelDeployment, error: unknown, stream = false): void {
    const state = this.state(deployment);
    const gatewayError = toGatewayError(error);
    state.halfOpenInFlight = false;
    if (gatewayError.code === "provider_rate_limited") {
      state.cooldownUntil = this.now() + this.policy.rateLimitCooldownMs;
      this.observer.routingEvent(this.metadata(deployment, stream), "cooldown");
      return;
    }
    if (!circuitFailureCodes.has(gatewayError.code)) return;
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.policy.circuitFailureThreshold) {
      state.openUntil = this.now() + this.policy.circuitOpenMs;
      this.observer.routingEvent(this.metadata(deployment, stream), "circuit_open");
    }
  }

  private shouldFallback(error: unknown): boolean {
    return fallbackCodes.has(toGatewayError(error).code);
  }

  private noHealthyDeployment(logicalModel: string, cause?: unknown): GatewayError {
    return new GatewayError({
      message: `No healthy deployment is currently available for '${logicalModel}'`,
      statusCode: 503,
      code: "provider_unavailable",
      retryable: true,
      cause,
    });
  }

  async complete(
    request: CanonicalChatRequest,
    context: RequestContext,
  ): Promise<RoutingResult<CanonicalChatResponse>> {
    const attempted = new Set<string>();
    let lastError: unknown;
    while (attempted.size < this.policy.maxAttempts) {
      const deployment = this.choose(request.logicalModel, attempted, false);
      if (!deployment) break;
      attempted.add(deployment.id);
      const metadata = this.metadata(deployment, false);
      const attemptStartedAt = this.now();
      this.observer.providerStarted(metadata);
      try {
        const value = await deployment.provider.complete(request, context);
        this.recordSuccess(deployment);
        this.observer.providerFinished(metadata, this.now() - attemptStartedAt, "success");
        this.observer.tokens(
          metadata,
          value.usage.inputTokens,
          value.usage.outputTokens,
          value.usage.estimated,
        );
        return { value, deployment, attempts: attempted.size };
      } catch (error) {
        lastError = error;
        this.recordFailure(deployment, error);
        this.observer.providerFinished(
          metadata,
          this.now() - attemptStartedAt,
          "error",
          toGatewayError(error).code,
        );
        if (!this.shouldFallback(error)) throw error;
      }
    }
    if (lastError) throw lastError;
    throw this.noHealthyDeployment(request.logicalModel, lastError);
  }

  async startStream(
    request: CanonicalChatRequest,
    context: RequestContext,
  ): Promise<StreamRoutingResult> {
    const attempted = new Set<string>();
    let lastError: unknown;
    while (attempted.size < this.policy.maxAttempts) {
      const deployment = this.choose(request.logicalModel, attempted, true);
      if (!deployment) break;
      attempted.add(deployment.id);
      const metadata = this.metadata(deployment, true);
      const attemptStartedAt = this.now();
      this.observer.providerStarted(metadata);
      let iterator: AsyncIterator<CanonicalStreamEvent> | undefined;
      try {
        iterator = deployment.provider.stream(request, context)[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done || first.value.type !== "response_start") {
          throw new GatewayError({
            message: "The provider stream did not start with response metadata",
            statusCode: 502,
            code: "provider_invalid_response",
            retryable: true,
          });
        }
        return {
          first: first.value,
          iterator,
          deployment,
          attempts: attempted.size,
          attemptStartedAt,
        };
      } catch (error) {
        await iterator?.return?.();
        lastError = error;
        this.recordFailure(deployment, error, true);
        this.observer.providerFinished(
          metadata,
          this.now() - attemptStartedAt,
          "error",
          toGatewayError(error).code,
        );
        if (!this.shouldFallback(error)) throw error;
      }
    }
    if (lastError) throw lastError;
    throw this.noHealthyDeployment(request.logicalModel);
  }

  finishStreamSuccess(deployment: ModelDeployment, attemptStartedAt: number): void {
    this.recordSuccess(deployment, true);
    this.observer.providerFinished(
      this.metadata(deployment, true),
      this.now() - attemptStartedAt,
      "success",
    );
  }

  finishStreamFailure(
    deployment: ModelDeployment,
    attemptStartedAt: number,
    error: unknown,
  ): void {
    this.recordFailure(deployment, error, true);
    this.observer.providerFinished(
      this.metadata(deployment, true),
      this.now() - attemptStartedAt,
      "error",
      toGatewayError(error).code,
    );
  }

  recordStreamTokens(
    deployment: ModelDeployment,
    inputTokens: number,
    outputTokens: number,
    estimated: boolean,
  ): void {
    this.observer.tokens(
      this.metadata(deployment, true),
      inputTokens,
      outputTokens,
      estimated,
    );
  }
}
