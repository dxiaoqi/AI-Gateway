import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { InMemoryQuotaStore } from "../src/quota/in-memory-store.js";
import { QuotaService } from "../src/quota/service.js";
import { buildApp } from "../src/server/app.js";

describe("HTTP quota pipeline", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  const authHeaders = {
    authorization: "Bearer test-key",
    "content-type": "application/json",
  };

  const createApp = async (limits: {
    requestsPerMinute?: number;
    tokensPerMinute?: number;
    maxConcurrent?: number;
  }) => {
    const config = loadConfig({
      GATEWAY_API_KEY: "test-key",
      DEFAULT_MAX_OUTPUT_TOKENS: "10",
      LOG_LEVEL: "silent",
    });
    const store = new InMemoryQuotaStore();
    const quotaService = new QuotaService(
      [
        {
          id: "test-policy",
          scope: "key",
          scopeId: "local-development-key",
          limits,
        },
      ],
      store,
      60_000,
      () => 1_000,
    );
    const app = await buildApp({ config, quotaService });
    apps.push(app);
    return { app, store };
  };

  const payload = {
    model: "general",
    messages: [{ role: "user", content: "Hi" }],
  };

  it("rejects a second request when RPM is exhausted", async () => {
    const { app } = await createApp({ requestsPerMinute: 1 });
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeaders,
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeaders,
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("quota_requests_exceeded");
  });

  it("rejects before provider invocation when the token reservation is too large", async () => {
    const { app } = await createApp({ tokensPerMinute: 5 });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeaders,
      payload,
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("quota_tokens_exceeded");
  });

  it("settles a streaming request using actual usage", async () => {
    const { app, store } = await createApp({ tokensPerMinute: 100 });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeaders,
      payload: { ...payload, stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain("data: [DONE]");
    const snapshot = store.snapshot("test-policy", 1_000);
    expect(snapshot.concurrent).toBe(0);
    expect(snapshot.tokens).toBeGreaterThan(0);
    expect(snapshot.tokens).toBeLessThan(20);
  });
});
