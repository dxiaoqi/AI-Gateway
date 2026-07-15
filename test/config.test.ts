import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads defaults", () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.providerTimeoutMs).toBe(30000);
  });

  it("rejects invalid numeric configuration", () => {
    expect(() => loadConfig({ PORT: "zero" })).toThrow(
      "PORT must be a positive integer",
    );
  });

  it("rejects invalid metrics boolean configuration", () => {
    expect(() => loadConfig({ METRICS_ENABLED: "yes" })).toThrow(
      "METRICS_ENABLED must be true or false",
    );
  });

  it("requires a complete OpenAI-compatible provider configuration", () => {
    expect(() =>
      loadConfig({ OPENAI_COMPAT_BASE_URL: "https://example.test/v1" }),
    ).toThrow("must be configured together");
  });

  it("parses multiple OpenAI-compatible deployments without embedding secrets", () => {
    const config = loadConfig({
      PRIMARY_PROVIDER_KEY: "secret-from-env",
      OPENAI_COMPAT_DEPLOYMENTS_JSON: JSON.stringify([
        {
          id: "primary",
          logicalModel: "general",
          baseUrl: "https://example.test/v1",
          providerModel: "model-a",
          apiKeyEnv: "PRIMARY_PROVIDER_KEY",
          priority: 1,
          weight: 80,
        },
      ]),
    });
    expect(config.openAICompatibleDeployments[0]).toMatchObject({
      id: "primary",
      apiKey: "secret-from-env",
      priority: 1,
      weight: 80,
    });
  });

  it("rejects a deployment that references a missing secret", () => {
    expect(() => loadConfig({
      OPENAI_COMPAT_DEPLOYMENTS_JSON: JSON.stringify([{
        id: "primary",
        logicalModel: "general",
        baseUrl: "https://example.test/v1",
        providerModel: "model-a",
        apiKeyEnv: "MISSING_KEY",
      }]),
    })).toThrow("referenced by deployment 'primary' is missing");
  });

  it("parses multi-tenant virtual key configuration", () => {
    const config = loadConfig({
      GATEWAY_VIRTUAL_KEYS_JSON: JSON.stringify([
        {
          keyId: "key-1",
          key: "aigw_secret",
          tenantId: "tenant-1",
          projectId: "project-1",
          applicationId: "app-1",
          allowedModels: ["general"],
        },
      ]),
    });
    expect(config.virtualKeys[0]).toMatchObject({
      keyId: "key-1",
      tenantId: "tenant-1",
      allowedModels: ["general"],
    });
  });

  it("rejects malformed virtual key configuration", () => {
    expect(() =>
      loadConfig({ GATEWAY_VIRTUAL_KEYS_JSON: "not-json" }),
    ).toThrow("must be valid JSON");
  });

  it("requires a key pepper in production", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", GATEWAY_API_KEY: "production-key" }),
    ).toThrow("GATEWAY_KEY_PEPPER is required in production");
  });

  it("requires a dedicated metrics token in production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      GATEWAY_API_KEY: "k".repeat(32),
      GATEWAY_KEY_PEPPER: "p".repeat(32),
    })).toThrow("METRICS_BEARER_TOKEN is required");
  });

  it("rejects weak production key material", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        GATEWAY_API_KEY: "short-key",
        GATEWAY_KEY_PEPPER: "x".repeat(32),
      }),
    ).toThrow("Every gateway API key must contain at least 32 characters");
  });

  it("parses hierarchical quota policies", () => {
    const config = loadConfig({
      GATEWAY_QUOTA_POLICIES_JSON: JSON.stringify([
        {
          id: "tenant-budget",
          scope: "tenant",
          scopeId: "local-tenant",
          limits: {
            requestsPerMinute: 60,
            tokensPerMinute: 10_000,
            maxConcurrent: 5,
          },
        },
      ]),
    });
    expect(config.quotaPolicies).toEqual([
      {
        id: "tenant-budget",
        scope: "tenant",
        scopeId: "local-tenant",
        limits: {
          requestsPerMinute: 60,
          tokensPerMinute: 10_000,
          maxConcurrent: 5,
        },
      },
    ]);
  });

  it("rejects invalid quota limits", () => {
    expect(() =>
      loadConfig({
        GATEWAY_QUOTA_POLICIES_JSON: JSON.stringify([
          {
            id: "broken",
            scope: "key",
            scopeId: "key-a",
            limits: { tokensPerMinute: 0 },
          },
        ]),
      }),
    ).toThrow("tokensPerMinute must be a positive integer");
  });

  it("requires Redis for production quota policies", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        GATEWAY_API_KEY: "k".repeat(32),
        GATEWAY_KEY_PEPPER: "p".repeat(32),
        GATEWAY_QUOTA_POLICIES_JSON: JSON.stringify([
          {
            id: "production",
            scope: "key",
            scopeId: "local-development-key",
            limits: { requestsPerMinute: 10 },
          },
        ]),
      }),
    ).toThrow("REDIS_URL is required");
  });

  it("loads PostgreSQL control-plane settings", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/aigateway",
      ADMIN_BEARER_TOKEN: "admin-test-token",
      DATABASE_AUTO_MIGRATE: "true",
      CONTROL_PLANE_SEED_FROM_ENV: "true",
      DATABASE_POOL_MAX: "4",
    });
    expect(config).toMatchObject({
      databaseUrl: "postgres://localhost/aigateway",
      adminAuth: { mode: "static", bearerToken: "admin-test-token" },
      databaseAutoMigrate: true,
      controlPlaneSeedFromEnv: true,
      databasePoolMax: 4,
      rotationApprovalRequired: false,
    });
  });

  it("defaults to first-owner local authentication in development", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://localhost/aigateway" }).adminAuth.mode).toBe("local");
  });

  it("requires explicit local-auth secrets in production", () => {
    const base = { NODE_ENV: "production", ADMIN_AUTH_MODE: "local", DATABASE_URL: "postgres://localhost/aigateway", GATEWAY_KEY_PEPPER: "p".repeat(32), METRICS_ENABLED: "false" };
    expect(() => loadConfig(base)).toThrow("ADMIN_LOCAL_TOKEN_SECRET");
    expect(() => loadConfig({ ...base, ADMIN_LOCAL_TOKEN_SECRET: "s".repeat(32) })).toThrow("ADMIN_LOCAL_BOOTSTRAP_TOKEN");
    expect(loadConfig({ ...base, ADMIN_LOCAL_TOKEN_SECRET: "s".repeat(32), ADMIN_LOCAL_BOOTSTRAP_TOKEN: "b".repeat(32) }).adminAuth.mode).toBe("local");
  });

  it("allows database-backed production without environment-seeded keys", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://localhost/aigateway",
      ADMIN_AUTH_MODE: "oidc",
      ADMIN_OIDC_ISSUER: "https://identity.example/tenant",
      ADMIN_OIDC_AUDIENCE: "ai-gateway-admin",
      ADMIN_OIDC_JWKS_URL: "https://identity.example/tenant/jwks",
      GATEWAY_KEY_PEPPER: "p".repeat(32),
      METRICS_ENABLED: "false",
    });
    expect(config.databaseUrl).toBeDefined();
    expect(config.rotationApprovalRequired).toBe(true);
  });

  it("rejects static administrator tokens in production unless explicitly acknowledged", () => {
    const production = {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://localhost/aigateway",
      ADMIN_BEARER_TOKEN: "a".repeat(32),
      GATEWAY_KEY_PEPPER: "p".repeat(32),
      METRICS_ENABLED: "false",
    };
    expect(() => loadConfig(production)).toThrow("Static administrator tokens are disabled in production");
    expect(loadConfig({ ...production, ADMIN_ALLOW_STATIC_IN_PRODUCTION: "true" }).adminAuth.mode).toBe("static");
  });

  it("loads OIDC administrator verification and role mapping", () => {
    const config = loadConfig({
      ADMIN_AUTH_MODE: "oidc",
      ADMIN_OIDC_ISSUER: "https://identity.example/tenant-a",
      ADMIN_OIDC_AUDIENCE: "ai-gateway-admin",
      ADMIN_OIDC_JWKS_URL: "https://identity.example/tenant-a/jwks",
      ADMIN_OIDC_ROLE_CLAIM: "realm_access.roles",
      ADMIN_OIDC_TENANT_CLAIM: "tenant_access.ids",
      ADMIN_OIDC_ROLE_MAP_JSON: JSON.stringify({ platform_reader: "viewer", platform_ops: "operator" }),
      ADMIN_OIDC_ALLOWED_ALGORITHMS: "RS256,ES256",
    });
    expect(config.adminAuth).toMatchObject({
      mode: "oidc",
      issuer: "https://identity.example/tenant-a",
      audience: "ai-gateway-admin",
      roleClaim: "realm_access.roles",
      tenantClaim: "tenant_access.ids",
      roleMap: { platform_reader: "viewer", platform_ops: "operator" },
      allowedAlgorithms: ["RS256", "ES256"],
      requiredTyp: "JWT",
    });
  });

  it("rejects symmetric JWT algorithms and insecure production JWKS", () => {
    const base = {
      ADMIN_AUTH_MODE: "oidc",
      ADMIN_OIDC_ISSUER: "https://identity.example",
      ADMIN_OIDC_AUDIENCE: "ai-gateway-admin",
      ADMIN_OIDC_JWKS_URL: "https://identity.example/jwks",
    };
    expect(() => loadConfig({ ...base, ADMIN_OIDC_ALLOWED_ALGORITHMS: "HS256" }))
      .toThrow("approved asymmetric JWT algorithms");
    expect(() => loadConfig({
      ...base,
      NODE_ENV: "production",
      ADMIN_OIDC_JWKS_URL: "http://identity.example/jwks",
    })).toThrow("must use HTTPS in production");
  });
});
