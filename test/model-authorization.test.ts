import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { MockProvider } from "../src/providers/mock-provider.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { buildApp } from "../src/server/app.js";

describe("model authorization", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  const createApp = async () => {
    const registry = new ProviderRegistry();
    registry.register("general", new MockProvider());
    registry.register("external", new MockProvider());
    const app = await buildApp({
      config: loadConfig({
        LOG_LEVEL: "silent",
        GATEWAY_KEY_PEPPER: "test-pepper",
        GATEWAY_VIRTUAL_KEYS_JSON: JSON.stringify([
          {
            keyId: "limited-key",
            key: "aigw_limited",
            tenantId: "tenant-a",
            projectId: "project-a",
            applicationId: "app-a",
            allowedModels: ["general"],
          },
        ]),
      }),
      registry,
    });
    apps.push(app);
    return app;
  };

  it("only lists models visible to the caller", async () => {
    const app = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer aigw_limited" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "general",
          object: "model",
          created: 0,
          owned_by: "enterprise-ai-gateway",
        },
      ],
    });
  });

  it("rejects access to a model outside the virtual key ACL", async () => {
    const app = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer aigw_limited" },
      payload: {
        model: "external",
        messages: [{ role: "user", content: "Hi" }],
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("authorization_error");
  });
});
