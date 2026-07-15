import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type {
  CanonicalChatRequest,
  CanonicalChatResponse,
  CanonicalStreamEvent,
} from "../src/core/canonical-schema.js";
import { GatewayError } from "../src/core/errors.js";
import type { RequestContext } from "../src/core/request-context.js";
import type { ModelProvider } from "../src/providers/provider.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { buildApp } from "../src/server/app.js";

const successfulResponse = (model: string): CanonicalChatResponse => ({
  id: "response-1",
  providerModel: model,
  content: "fallback worked",
  finishReason: "stop",
  usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4, estimated: false },
});

class FailingProvider implements ModelProvider {
  readonly id = "primary-provider";
  complete(): Promise<CanonicalChatResponse> {
    return Promise.reject(new GatewayError({
      message: "primary unavailable",
      statusCode: 503,
      code: "provider_unavailable",
      retryable: true,
    }));
  }
  async *stream(): AsyncIterable<CanonicalStreamEvent> {
    throw new GatewayError({
      message: "primary unavailable",
      statusCode: 503,
      code: "provider_unavailable",
      retryable: true,
    });
  }
}

class SuccessfulProvider implements ModelProvider {
  readonly id = "secondary-provider";
  calls = 0;
  complete(_request: CanonicalChatRequest, _context: RequestContext): Promise<CanonicalChatResponse> {
    this.calls += 1;
    return Promise.resolve(successfulResponse("secondary-model"));
  }
  async *stream(): AsyncIterable<CanonicalStreamEvent> {
    this.calls += 1;
    yield { type: "response_start", responseId: "stream-secondary", providerModel: "secondary-model" };
    yield { type: "response_end", finishReason: "stop" };
  }
}

class LateFailingStreamProvider implements ModelProvider {
  readonly id = "late-failing-provider";
  complete(): Promise<CanonicalChatResponse> {
    return Promise.resolve(successfulResponse("late-model"));
  }
  async *stream(): AsyncIterable<CanonicalStreamEvent> {
    yield { type: "response_start", responseId: "stream-primary", providerModel: "late-model" };
    yield { type: "content_delta", content: "partial" };
    throw new GatewayError({
      message: "connection lost after first token",
      statusCode: 503,
      code: "provider_unavailable",
      retryable: true,
    });
  }
}

describe("routing through HTTP", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  const createApp = async (registry: ProviderRegistry) => {
    const app = await buildApp({
      config: loadConfig({ GATEWAY_API_KEY: "test-key", LOG_LEVEL: "silent" }),
      registry,
    });
    apps.push(app);
    return app;
  };

  it("returns the selected fallback deployment in response metadata", async () => {
    const registry = new ProviderRegistry();
    registry.register("general", new FailingProvider(), { id: "primary", priority: 1 });
    registry.register("general", new SuccessfulProvider(), { id: "secondary", priority: 2 });
    const app = await createApp(registry);
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer test-key" },
      payload: { model: "general", messages: [{ role: "user", content: "Hi" }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().gateway).toMatchObject({
      deployment: "secondary",
      route_attempts: 2,
      provider: "secondary-provider",
    });
    const metrics = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer local-development-metrics-key" },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('deployment="primary",provider="primary-provider",stream="false",outcome="error",error_code="provider_unavailable"');
    expect(metrics.body).toContain('deployment="secondary",provider="secondary-provider",stream="false",outcome="success",error_code="none"');
  });

  it("does not switch deployments after stream headers and first event", async () => {
    const registry = new ProviderRegistry();
    const secondary = new SuccessfulProvider();
    registry.register("general", new LateFailingStreamProvider(), { id: "primary", priority: 1 });
    registry.register("general", secondary, { id: "secondary", priority: 2 });
    const app = await createApp(registry);
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer test-key" },
      payload: { model: "general", messages: [{ role: "user", content: "Hi" }], stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"deployment":"primary"');
    expect(response.body).toContain('"code":"provider_unavailable"');
    expect(secondary.calls).toBe(0);
  });
});
