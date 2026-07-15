import { describe, expect, it } from "vitest";
import type {
  CanonicalChatRequest,
  CanonicalChatResponse,
  CanonicalStreamEvent,
} from "../src/core/canonical-schema.js";
import { GatewayError } from "../src/core/errors.js";
import type { RequestContext } from "../src/core/request-context.js";
import type { ModelProvider } from "../src/providers/provider.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { ModelRouter } from "../src/routing/model-router.js";
import { MetricsRegistry } from "../src/observability/metrics.js";

const request: CanonicalChatRequest = {
  logicalModel: "general",
  messages: [{ role: "user", content: "hello" }],
};
const context: RequestContext = {
  requestId: "request-1",
  startedAt: 0,
  signal: new AbortController().signal,
};
const response = (providerModel: string): CanonicalChatResponse => ({
  id: `response-${providerModel}`,
  providerModel,
  content: "ok",
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: false },
});

class TestProvider implements ModelProvider {
  constructor(
    readonly id: string,
    private readonly completeHandler: () => Promise<CanonicalChatResponse>,
    private readonly streamHandler: () => AsyncIterable<CanonicalStreamEvent> = async function* () {
      yield { type: "response_start", responseId: "stream-1", providerModel: id };
    },
  ) {}

  complete(): Promise<CanonicalChatResponse> {
    return this.completeHandler();
  }

  stream(): AsyncIterable<CanonicalStreamEvent> {
    return this.streamHandler();
  }
}

const unavailable = () =>
  new GatewayError({
    message: "provider down",
    statusCode: 503,
    code: "provider_unavailable",
    retryable: true,
  });

const policy = {
  maxAttempts: 3,
  rateLimitCooldownMs: 1_000,
  circuitFailureThreshold: 2,
  circuitOpenMs: 1_000,
};

describe("ModelRouter", () => {
  it("falls back from a failed primary deployment to a secondary", async () => {
    const registry = new ProviderRegistry();
    registry.register("general", new TestProvider("primary", async () => { throw unavailable(); }), { priority: 1 });
    registry.register("general", new TestProvider("secondary", async () => response("secondary")), { priority: 2 });
    const result = await new ModelRouter(registry, policy).complete(request, context);
    expect(result.deployment.id).toBe("secondary");
    expect(result.attempts).toBe(2);
  });

  it("does not retry a non-provider request error", async () => {
    let secondaryCalls = 0;
    const registry = new ProviderRegistry();
    registry.register("general", new TestProvider("primary", async () => {
      throw new GatewayError({ message: "bad input", statusCode: 400, code: "invalid_request_error" });
    }), { priority: 1 });
    registry.register("general", new TestProvider("secondary", async () => {
      secondaryCalls += 1;
      return response("secondary");
    }), { priority: 2 });
    await expect(new ModelRouter(registry, policy).complete(request, context)).rejects.toMatchObject({ code: "invalid_request_error" });
    expect(secondaryCalls).toBe(0);
  });

  it("uses weights inside the same priority tier", async () => {
    const registry = new ProviderRegistry();
    registry.register("general", new TestProvider("small", async () => response("small")), { priority: 1, weight: 1 });
    registry.register("general", new TestProvider("large", async () => response("large")), { priority: 1, weight: 3 });
    const small = await new ModelRouter(registry, policy, Date.now, () => 0.1).complete(request, context);
    const large = await new ModelRouter(registry, policy, Date.now, () => 0.5).complete(request, context);
    expect(small.deployment.id).toBe("small");
    expect(large.deployment.id).toBe("large");
  });

  it("temporarily cools down a rate-limited deployment", async () => {
    let primaryCalls = 0;
    const registry = new ProviderRegistry();
    registry.register("general", new TestProvider("primary", async () => {
      primaryCalls += 1;
      throw new GatewayError({ message: "busy", statusCode: 429, code: "provider_rate_limited", retryable: true });
    }), { priority: 1 });
    registry.register("general", new TestProvider("secondary", async () => response("secondary")), { priority: 2 });
    const router = new ModelRouter(registry, policy, () => 100);
    await router.complete(request, context);
    await router.complete(request, context);
    expect(primaryCalls).toBe(1);
  });

  it("opens a circuit and allows one half-open recovery probe", async () => {
    let now = 100;
    let primaryCalls = 0;
    let primaryHealthy = false;
    const registry = new ProviderRegistry();
    registry.register("general", new TestProvider("primary", async () => {
      primaryCalls += 1;
      if (!primaryHealthy) throw unavailable();
      return response("primary");
    }), { priority: 1 });
    registry.register("general", new TestProvider("secondary", async () => response("secondary")), { priority: 2 });
    const metrics = new MetricsRegistry();
    const router = new ModelRouter(registry, policy, () => now, Math.random, metrics);
    await router.complete(request, context);
    await router.complete(request, context);
    await router.complete(request, context);
    expect(primaryCalls).toBe(2);
    now += 1_001;
    primaryHealthy = true;
    const recovered = await router.complete(request, context);
    expect(recovered.deployment.id).toBe("primary");
    expect(primaryCalls).toBe(3);
    expect(metrics.render()).toContain('deployment="primary",event="circuit_open"');
    expect(metrics.render()).toContain('deployment="primary",event="half_open"');
    expect(metrics.render()).toContain('deployment="primary",event="recovered"');
  });

  it("falls back when a stream fails before its first event", async () => {
    const registry = new ProviderRegistry();
    registry.register("general", new TestProvider(
      "primary",
      async () => response("primary"),
      async function* () { throw unavailable(); },
    ), { priority: 1 });
    registry.register("general", new TestProvider(
      "secondary",
      async () => response("secondary"),
      async function* () {
        yield { type: "response_start", responseId: "stream-2", providerModel: "secondary" };
      },
    ), { priority: 2 });
    const result = await new ModelRouter(registry, policy).startStream(request, context);
    expect(result.deployment.id).toBe("secondary");
    expect(result.attempts).toBe(2);
    await result.iterator.return?.();
  });
});
