import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type {
  CanonicalChatRequest,
  CanonicalChatResponse,
  CanonicalStreamEvent,
} from "../src/core/canonical-schema.js";
import type { RequestContext } from "../src/core/request-context.js";
import type { ModelProvider } from "../src/providers/provider.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { buildApp } from "../src/server/app.js";

class SlowProvider implements ModelProvider {
  readonly id = "slow";

  async complete(
    _request: CanonicalChatRequest,
    _context: RequestContext,
  ): Promise<CanonicalChatResponse> {
    throw new Error("not used");
  }

  async *stream(
    _request: CanonicalChatRequest,
    context: RequestContext,
  ): AsyncIterable<CanonicalStreamEvent> {
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(context.signal.reason), {
        once: true,
      });
    });
  }
}

describe("stream lifetime", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("returns a normalized timeout before SSE headers are committed", async () => {
    const registry = new ProviderRegistry();
    registry.register("general", new SlowProvider());
    const app = await buildApp({
      config: loadConfig({
        GATEWAY_API_KEY: "test-key",
        PROVIDER_TIMEOUT_MS: "10",
        LOG_LEVEL: "silent",
      }),
      registry,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer test-key" },
      payload: {
        model: "general",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(504);
    expect(response.json().error).toMatchObject({
      code: "provider_timeout",
      retryable: true,
    });
  });
});
