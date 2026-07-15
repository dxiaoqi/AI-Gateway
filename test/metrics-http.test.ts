import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server/app.js";

describe("Prometheus metrics endpoint", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  const createApp = async () => {
    const app = await buildApp({
      config: loadConfig({
        GATEWAY_API_KEY: "business-key",
        METRICS_BEARER_TOKEN: "observability-key",
        LOG_LEVEL: "silent",
      }),
    });
    apps.push(app);
    return app;
  };

  it("rejects missing and business credentials", async () => {
    const app = await createApp();
    const missing = await app.inject({ method: "GET", url: "/metrics" });
    const business = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer business-key" },
    });
    expect(missing.statusCode).toBe(401);
    expect(business.statusCode).toBe(401);
  });

  it("exports low-cardinality HTTP, provider and token metrics", async () => {
    const app = await createApp();
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer business-key" },
      payload: { model: "general", messages: [{ role: "user", content: "hello" }] },
    });
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer business-key" },
      payload: {
        model: "general",
        stream: true,
        messages: [{ role: "user", content: "stream hello" }],
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer observability-key" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("# TYPE aigw_http_requests_total counter");
    expect(response.body).toContain('aigw_provider_requests_total{logical_model="general",deployment="mock-general",provider="mock",stream="false",outcome="success",error_code="none"} 1');
    expect(response.body).toContain('aigw_tokens_total{logical_model="general",deployment="mock-general",estimated="true",direction="input"}');
    expect(response.body).toContain('deployment="mock-general",provider="mock",stream="true",outcome="success",error_code="none"');
    expect(response.body).toContain('aigw_provider_requests_active{logical_model="general",deployment="mock-general",provider="mock",stream="true"} 0');
    expect(response.body).not.toContain("business-key");
    expect(response.body).not.toContain("hello");
  });

  it("can be disabled", async () => {
    const app = await buildApp({
      config: loadConfig({ METRICS_ENABLED: "false", LOG_LEVEL: "silent" }),
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer local-development-key" },
    });
    expect(response.statusCode).toBe(404);
  });
});
