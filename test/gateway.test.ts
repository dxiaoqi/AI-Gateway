import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server/app.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

const createApp = async () => {
  const app = await buildApp({
    config: loadConfig({
      GATEWAY_API_KEY: "test-key",
      LOG_LEVEL: "silent",
    }),
  });
  apps.push(app);
  return app;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("AI Gateway iteration 1", () => {
  it("exposes unauthenticated health checks", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("rejects missing credentials", async () => {
    const app = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "general", messages: [{ role: "user", content: "Hi" }] },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("authentication_error");
  });

  it("returns an OpenAI-compatible completion from the mock provider", async () => {
    const app = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer test-key" },
      payload: {
        model: "general",
        messages: [{ role: "user", content: "Explain AI gateways" }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("general");
    expect(body.choices[0].message.content).toBe(
      "Mock response: Explain AI gateways",
    );
    expect(body.gateway.provider).toBe("mock");
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it("continues an incoming W3C trace with a new gateway span", async () => {
    const app = await createApp();
    const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const incoming = `00-${traceId}-bbbbbbbbbbbbbbbb-01`;
    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
      headers: { traceparent: incoming },
    });
    expect(response.headers.traceparent).toMatch(
      new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`, "u"),
    );
    expect(response.headers.traceparent).not.toBe(incoming);
  });

  it("returns a normalized error for an unknown model", async () => {
    const app = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer test-key" },
      payload: { model: "unknown", messages: [{ role: "user", content: "Hi" }] },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("model_not_found");
  });

  it("streams an OpenAI-compatible SSE response", async () => {
    const app = await createApp();
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
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.payload).toContain('"object":"chat.completion.chunk"');
    expect(response.payload).toContain('"content":"Mock res"');
    expect(response.payload).toContain('"finish_reason":"stop"');
    expect(response.payload).toContain("data: [DONE]");
  });
});
