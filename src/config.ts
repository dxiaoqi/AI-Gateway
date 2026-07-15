import type { VirtualKeySeed } from "./auth/types.js";
import { createHash } from "node:crypto";
import type { AdminRole } from "./admin-auth/types.js";
import type { QuotaLimits, QuotaPolicy, QuotaScope } from "./quota/types.js";

export interface GatewayConfig {
  environment: string;
  host: string;
  port: number;
  logLevel: string;
  keyPepper: string;
  virtualKeys: VirtualKeySeed[];
  providerTimeoutMs: number;
  defaultMaxOutputTokens: number;
  quotaReservationTtlMs: number;
  quotaPolicies: QuotaPolicy[];
  redisUrl?: string;
  routing: {
    maxAttempts: number;
    rateLimitCooldownMs: number;
    circuitFailureThreshold: number;
    circuitOpenMs: number;
  };
  openAICompatibleDeployments: OpenAICompatibleDeploymentConfig[];
  metricsEnabled: boolean;
  metricsBearerToken: string;
  databaseUrl?: string;
  databasePoolMax: number;
  databaseConnectionTimeoutMs: number;
  databaseAutoMigrate: boolean;
  controlPlaneSeedFromEnv: boolean;
  rotationApprovalRequired: boolean;
  rotationApprovalTtlMs: number;
  adminAuth: AdminAuthConfig;
  openAICompatible?: {
    baseUrl: string;
    apiKey: string;
    providerModel: string;
    logicalModel: string;
  };
}

export type AdminAuthConfig =
  | { mode: "disabled" }
  | { mode: "static"; bearerToken: string }
  | AdminLocalConfig
  | AdminOidcConfig;

export interface AdminLocalConfig {
  mode: "local";
  issuer: "aigateway-local";
  audience: "aigateway-admin";
  tokenSecret: string;
  accountFile: string;
  bootstrapToken?: string;
  accessTokenTtlSeconds: number;
  production: boolean;
}

export interface AdminOidcConfig {
  mode: "oidc";
  issuer: string;
  audience: string;
  jwksUrl: string;
  roleClaim: string;
  tenantClaim: string;
  roleMap: Readonly<Record<string, AdminRole>>;
  allowedAlgorithms: readonly string[];
  requiredTyp: string;
  clockToleranceSeconds: number;
  jwksTimeoutMs: number;
  jwksCooldownMs: number;
  jwksCacheMaxAgeMs: number;
}

export interface OpenAICompatibleDeploymentConfig {
  id: string;
  logicalModel: string;
  baseUrl: string;
  apiKey: string;
  providerModel: string;
  priority: number;
  weight: number;
}

const requireString = (
  value: unknown,
  field: string,
  index: number,
): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`GATEWAY_VIRTUAL_KEYS_JSON[${index}].${field} must be a non-empty string`);
  }
  return value;
};

const quotaScopes = new Set<QuotaScope>([
  "tenant",
  "project",
  "application",
  "key",
]);

const parseQuotaLimit = (
  limits: Record<string, unknown>,
  name: keyof QuotaLimits,
  index: number,
): number | undefined => {
  const value = limits[name];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(
      `GATEWAY_QUOTA_POLICIES_JSON[${index}].limits.${name} must be a positive integer`,
    );
  }
  return value as number;
};

const parseQuotaPolicies = (value: string): QuotaPolicy[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("GATEWAY_QUOTA_POLICIES_JSON must be valid JSON", {
      cause: error,
    });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("GATEWAY_QUOTA_POLICIES_JSON must be a non-empty array");
  }
  const policies = parsed.map((item, index): QuotaPolicy => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`GATEWAY_QUOTA_POLICIES_JSON[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw new Error(
        `GATEWAY_QUOTA_POLICIES_JSON[${index}].id must be a non-empty string`,
      );
    }
    const id = record.id;
    const scope = record.scope;
    if (typeof scope !== "string" || !quotaScopes.has(scope as QuotaScope)) {
      throw new Error(
        `GATEWAY_QUOTA_POLICIES_JSON[${index}].scope must be tenant, project, application or key`,
      );
    }
    const scopeId = record.scopeId;
    if (typeof scopeId !== "string" || scopeId.length === 0) {
      throw new Error(
        `GATEWAY_QUOTA_POLICIES_JSON[${index}].scopeId must be a non-empty string`,
      );
    }
    if (typeof record.limits !== "object" || record.limits === null) {
      throw new Error(
        `GATEWAY_QUOTA_POLICIES_JSON[${index}].limits must be an object`,
      );
    }
    const limitRecord = record.limits as Record<string, unknown>;
    const limits: QuotaLimits = {};
    const requestsPerMinute = parseQuotaLimit(
      limitRecord,
      "requestsPerMinute",
      index,
    );
    const tokensPerMinute = parseQuotaLimit(
      limitRecord,
      "tokensPerMinute",
      index,
    );
    const maxConcurrent = parseQuotaLimit(
      limitRecord,
      "maxConcurrent",
      index,
    );
    if (requestsPerMinute !== undefined) limits.requestsPerMinute = requestsPerMinute;
    if (tokensPerMinute !== undefined) limits.tokensPerMinute = tokensPerMinute;
    if (maxConcurrent !== undefined) limits.maxConcurrent = maxConcurrent;
    if (Object.keys(limits).length === 0) {
      throw new Error(
        `GATEWAY_QUOTA_POLICIES_JSON[${index}].limits must define at least one limit`,
      );
    }
    return { id, scope: scope as QuotaScope, scopeId, limits };
  });
  if (new Set(policies.map((policy) => policy.id)).size !== policies.length) {
    throw new Error("GATEWAY_QUOTA_POLICIES_JSON policy ids must be unique");
  }
  return policies;
};

const parseVirtualKeys = (value: string): VirtualKeySeed[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("GATEWAY_VIRTUAL_KEYS_JSON must be valid JSON", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("GATEWAY_VIRTUAL_KEYS_JSON must be a non-empty array");
  }
  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`GATEWAY_VIRTUAL_KEYS_JSON[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (
      !Array.isArray(record.allowedModels) ||
      record.allowedModels.length === 0 ||
      !record.allowedModels.every(
        (model) => typeof model === "string" && model.length > 0,
      )
    ) {
      throw new Error(
        `GATEWAY_VIRTUAL_KEYS_JSON[${index}].allowedModels must be a non-empty string array`,
      );
    }
    return {
      keyId: requireString(record.keyId, "keyId", index),
      rawKey: requireString(record.key, "key", index),
      tenantId: requireString(record.tenantId, "tenantId", index),
      projectId: requireString(record.projectId, "projectId", index),
      applicationId: requireString(
        record.applicationId,
        "applicationId",
        index,
      ),
      allowedModels: record.allowedModels as string[],
    };
  });
};

const parsePositiveInteger = (name: string, value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const parseBoolean = (name: string, value: string): boolean => {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
};

const adminRoles = new Set<AdminRole>(["viewer", "operator", "admin"]);
const asymmetricJwtAlgorithms = new Set([
  "RS256", "RS384", "RS512", "PS256", "PS384", "PS512",
  "ES256", "ES384", "ES512", "EdDSA",
]);

const requiredAdminValue = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when ADMIN_AUTH_MODE=oidc`);
  return value;
};

const parseRoleMap = (value: string | undefined): Readonly<Record<string, AdminRole>> => {
  if (!value) return { viewer: "viewer", operator: "operator", admin: "admin" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("ADMIN_OIDC_ROLE_MAP_JSON must be valid JSON", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ADMIN_OIDC_ROLE_MAP_JSON must be an object");
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.some(([name, role]) => !name || typeof role !== "string" || !adminRoles.has(role as AdminRole))) {
    throw new Error("ADMIN_OIDC_ROLE_MAP_JSON values must be viewer, operator or admin");
  }
  return Object.fromEntries(entries) as Record<string, AdminRole>;
};

const parseAdminAuth = (env: NodeJS.ProcessEnv, environment: string): AdminAuthConfig => {
  const mode = env.ADMIN_AUTH_MODE ?? (env.ADMIN_OIDC_ISSUER ? "oidc" : env.ADMIN_BEARER_TOKEN ? "static" : environment === "production" ? "disabled" : "local");
  if (mode === "disabled") return { mode };
  if (mode === "local") {
    const tokenSecret = env.ADMIN_LOCAL_TOKEN_SECRET ?? (environment === "production" ? "" : createHash("sha256").update(`${env.GATEWAY_KEY_PEPPER ?? "local-development-pepper"}:local-admin-token`).digest("hex"));
    if (tokenSecret.length < 32) throw new Error("ADMIN_LOCAL_TOKEN_SECRET must contain at least 32 characters");
    if (environment === "production" && (!env.ADMIN_LOCAL_BOOTSTRAP_TOKEN || env.ADMIN_LOCAL_BOOTSTRAP_TOKEN.length < 32)) throw new Error("ADMIN_LOCAL_BOOTSTRAP_TOKEN must contain at least 32 characters for local authentication in production");
    return {
      mode,
      issuer: "aigateway-local",
      audience: "aigateway-admin",
      tokenSecret,
      accountFile: env.ADMIN_LOCAL_ACCOUNT_FILE ?? ".data/admin-local-owner.json",
      ...(env.ADMIN_LOCAL_BOOTSTRAP_TOKEN ? { bootstrapToken: env.ADMIN_LOCAL_BOOTSTRAP_TOKEN } : {}),
      accessTokenTtlSeconds: parsePositiveInteger("ADMIN_LOCAL_ACCESS_TOKEN_TTL_SECONDS", env.ADMIN_LOCAL_ACCESS_TOKEN_TTL_SECONDS ?? "900"),
      production: environment === "production",
    };
  }
  if (mode === "static") {
    if (!env.ADMIN_BEARER_TOKEN) throw new Error("ADMIN_BEARER_TOKEN is required when ADMIN_AUTH_MODE=static");
    if (environment === "production" && !parseBoolean(
      "ADMIN_ALLOW_STATIC_IN_PRODUCTION",
      env.ADMIN_ALLOW_STATIC_IN_PRODUCTION ?? "false",
    )) {
      throw new Error("Static administrator tokens are disabled in production; configure OIDC or explicitly set ADMIN_ALLOW_STATIC_IN_PRODUCTION=true");
    }
    return { mode, bearerToken: env.ADMIN_BEARER_TOKEN };
  }
  if (mode !== "oidc") throw new Error("ADMIN_AUTH_MODE must be disabled, local, static or oidc");

  const issuer = requiredAdminValue(env, "ADMIN_OIDC_ISSUER");
  const audience = requiredAdminValue(env, "ADMIN_OIDC_AUDIENCE");
  const jwksUrl = requiredAdminValue(env, "ADMIN_OIDC_JWKS_URL");
  let parsedJwksUrl: URL;
  let parsedIssuer: URL;
  try {
    parsedJwksUrl = new URL(jwksUrl);
    parsedIssuer = new URL(issuer);
  } catch (error) {
    throw new Error("ADMIN_OIDC_ISSUER and ADMIN_OIDC_JWKS_URL must be valid URLs", { cause: error });
  }
  if (parsedIssuer.search || parsedIssuer.hash) {
    throw new Error("ADMIN_OIDC_ISSUER cannot contain a query string or fragment");
  }
  if (environment === "production" && (parsedJwksUrl.protocol !== "https:" || parsedIssuer.protocol !== "https:")) {
    throw new Error("ADMIN_OIDC_ISSUER and ADMIN_OIDC_JWKS_URL must use HTTPS in production");
  }
  const allowedAlgorithms = (env.ADMIN_OIDC_ALLOWED_ALGORITHMS ?? "RS256,ES256")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (allowedAlgorithms.length === 0 || allowedAlgorithms.some((algorithm) => !asymmetricJwtAlgorithms.has(algorithm))) {
    throw new Error("ADMIN_OIDC_ALLOWED_ALGORITHMS must contain only approved asymmetric JWT algorithms");
  }
  const roleClaim = env.ADMIN_OIDC_ROLE_CLAIM ?? "roles";
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(roleClaim)) {
    throw new Error("ADMIN_OIDC_ROLE_CLAIM must be a dot-separated claim path");
  }
  const tenantClaim = env.ADMIN_OIDC_TENANT_CLAIM ?? "ai_gateway_tenants";
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(tenantClaim)) {
    throw new Error("ADMIN_OIDC_TENANT_CLAIM must be a dot-separated claim path");
  }
  return {
    mode,
    issuer,
    audience,
    jwksUrl,
    roleClaim,
    tenantClaim,
    roleMap: parseRoleMap(env.ADMIN_OIDC_ROLE_MAP_JSON),
    allowedAlgorithms,
    requiredTyp: requiredAdminValue({ ADMIN_OIDC_TOKEN_TYP: env.ADMIN_OIDC_TOKEN_TYP ?? "JWT" }, "ADMIN_OIDC_TOKEN_TYP"),
    clockToleranceSeconds: parsePositiveInteger("ADMIN_OIDC_CLOCK_TOLERANCE_SECONDS", env.ADMIN_OIDC_CLOCK_TOLERANCE_SECONDS ?? "5"),
    jwksTimeoutMs: parsePositiveInteger("ADMIN_OIDC_JWKS_TIMEOUT_MS", env.ADMIN_OIDC_JWKS_TIMEOUT_MS ?? "3000"),
    jwksCooldownMs: parsePositiveInteger("ADMIN_OIDC_JWKS_COOLDOWN_MS", env.ADMIN_OIDC_JWKS_COOLDOWN_MS ?? "30000"),
    jwksCacheMaxAgeMs: parsePositiveInteger("ADMIN_OIDC_JWKS_CACHE_MAX_AGE_MS", env.ADMIN_OIDC_JWKS_CACHE_MAX_AGE_MS ?? "600000"),
  };
};

const parseOpenAICompatibleDeployments = (
  value: string,
  env: NodeJS.ProcessEnv,
): OpenAICompatibleDeploymentConfig[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("OPENAI_COMPAT_DEPLOYMENTS_JSON must be valid JSON", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("OPENAI_COMPAT_DEPLOYMENTS_JSON must be a non-empty array");
  }
  const deployments = parsed.map((item, index): OpenAICompatibleDeploymentConfig => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`OPENAI_COMPAT_DEPLOYMENTS_JSON[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const read = (field: string): string => {
      const fieldValue = record[field];
      if (typeof fieldValue !== "string" || fieldValue.length === 0) {
        throw new Error(`OPENAI_COMPAT_DEPLOYMENTS_JSON[${index}].${field} must be a non-empty string`);
      }
      return fieldValue;
    };
    const apiKeyEnv = record.apiKeyEnv;
    if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== "string" || apiKeyEnv.length === 0)) {
      throw new Error(`OPENAI_COMPAT_DEPLOYMENTS_JSON[${index}].apiKeyEnv must be a non-empty string`);
    }
    const apiKey = typeof apiKeyEnv === "string" ? env[apiKeyEnv] : "";
    if (typeof apiKeyEnv === "string" && apiKey === undefined) {
      throw new Error(`Environment variable '${apiKeyEnv}' referenced by deployment '${String(record.id)}' is missing`);
    }
    const priority = record.priority ?? 100;
    const weight = record.weight ?? 1;
    if (!Number.isSafeInteger(priority) || (priority as number) < 0) {
      throw new Error(`OPENAI_COMPAT_DEPLOYMENTS_JSON[${index}].priority must be a non-negative integer`);
    }
    if (!Number.isSafeInteger(weight) || (weight as number) <= 0) {
      throw new Error(`OPENAI_COMPAT_DEPLOYMENTS_JSON[${index}].weight must be a positive integer`);
    }
    return {
      id: read("id"),
      logicalModel: read("logicalModel"),
      baseUrl: read("baseUrl"),
      providerModel: read("providerModel"),
      apiKey: apiKey ?? "",
      priority: priority as number,
      weight: weight as number,
    };
  });
  if (new Set(deployments.map((item) => item.id)).size !== deployments.length) {
    throw new Error("OPENAI_COMPAT_DEPLOYMENTS_JSON deployment ids must be unique");
  }
  return deployments;
};

export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig => {
  const providerValues = [env.OPENAI_COMPAT_BASE_URL, env.OPENAI_COMPAT_MODEL];
  const hasAnyProviderValue = providerValues.some((value) => value !== undefined);
  const hasAllProviderValues = providerValues.every(
    (value) => value !== undefined && value.length > 0,
  );
  if (hasAnyProviderValue && !hasAllProviderValues) {
    throw new Error(
      "OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_MODEL must be configured together",
    );
  }

  const environment = env.NODE_ENV ?? "development";
  const config: GatewayConfig = {
    environment,
    host: env.HOST ?? "0.0.0.0",
    port: parsePositiveInteger("PORT", env.PORT ?? "3000"),
    logLevel: env.LOG_LEVEL ?? "info",
    keyPepper: env.GATEWAY_KEY_PEPPER ?? "local-development-pepper",
    virtualKeys: env.GATEWAY_VIRTUAL_KEYS_JSON
      ? parseVirtualKeys(env.GATEWAY_VIRTUAL_KEYS_JSON)
      : [
          {
            keyId: "local-development-key",
            rawKey: env.GATEWAY_API_KEY ?? "local-development-key",
            tenantId: "local-tenant",
            projectId: "local-project",
            applicationId: "local-application",
            allowedModels: ["*"],
          },
        ],
    providerTimeoutMs: parsePositiveInteger(
      "PROVIDER_TIMEOUT_MS",
      env.PROVIDER_TIMEOUT_MS ?? "30000",
    ),
    defaultMaxOutputTokens: parsePositiveInteger(
      "DEFAULT_MAX_OUTPUT_TOKENS",
      env.DEFAULT_MAX_OUTPUT_TOKENS ?? "512",
    ),
    quotaReservationTtlMs: parsePositiveInteger(
      "QUOTA_RESERVATION_TTL_MS",
      env.QUOTA_RESERVATION_TTL_MS ?? "600000",
    ),
    quotaPolicies: env.GATEWAY_QUOTA_POLICIES_JSON
      ? parseQuotaPolicies(env.GATEWAY_QUOTA_POLICIES_JSON)
      : [],
    routing: {
      maxAttempts: parsePositiveInteger("ROUTING_MAX_ATTEMPTS", env.ROUTING_MAX_ATTEMPTS ?? "3"),
      rateLimitCooldownMs: parsePositiveInteger("ROUTING_RATE_LIMIT_COOLDOWN_MS", env.ROUTING_RATE_LIMIT_COOLDOWN_MS ?? "30000"),
      circuitFailureThreshold: parsePositiveInteger("ROUTING_CIRCUIT_FAILURE_THRESHOLD", env.ROUTING_CIRCUIT_FAILURE_THRESHOLD ?? "3"),
      circuitOpenMs: parsePositiveInteger("ROUTING_CIRCUIT_OPEN_MS", env.ROUTING_CIRCUIT_OPEN_MS ?? "30000"),
    },
    openAICompatibleDeployments: env.OPENAI_COMPAT_DEPLOYMENTS_JSON
      ? parseOpenAICompatibleDeployments(env.OPENAI_COMPAT_DEPLOYMENTS_JSON, env)
      : [],
    metricsEnabled: parseBoolean("METRICS_ENABLED", env.METRICS_ENABLED ?? "true"),
    metricsBearerToken: env.METRICS_BEARER_TOKEN ?? "local-development-metrics-key",
    databasePoolMax: parsePositiveInteger("DATABASE_POOL_MAX", env.DATABASE_POOL_MAX ?? "10"),
    databaseConnectionTimeoutMs: parsePositiveInteger(
      "DATABASE_CONNECTION_TIMEOUT_MS",
      env.DATABASE_CONNECTION_TIMEOUT_MS ?? "3000",
    ),
    databaseAutoMigrate: parseBoolean(
      "DATABASE_AUTO_MIGRATE",
      env.DATABASE_AUTO_MIGRATE ?? "false",
    ),
    controlPlaneSeedFromEnv: parseBoolean(
      "CONTROL_PLANE_SEED_FROM_ENV",
      env.CONTROL_PLANE_SEED_FROM_ENV ?? "false",
    ),
    rotationApprovalRequired: parseBoolean(
      "ROTATION_APPROVAL_REQUIRED",
      env.ROTATION_APPROVAL_REQUIRED ?? (environment === "production" ? "true" : "false"),
    ),
    rotationApprovalTtlMs: parsePositiveInteger(
      "ROTATION_APPROVAL_TTL_MS",
      env.ROTATION_APPROVAL_TTL_MS ?? "900000",
    ),
    adminAuth: parseAdminAuth(env, environment),
  };
  if (env.REDIS_URL) config.redisUrl = env.REDIS_URL;
  if (env.DATABASE_URL) config.databaseUrl = env.DATABASE_URL;
  if (config.databaseUrl && config.adminAuth.mode === "disabled") {
    throw new Error("Administrator authentication is required when DATABASE_URL is configured");
  }

  if (config.environment === "production") {
    if (!env.GATEWAY_KEY_PEPPER) {
      throw new Error("GATEWAY_KEY_PEPPER is required in production");
    }
    if (!config.databaseUrl && !env.GATEWAY_VIRTUAL_KEYS_JSON && !env.GATEWAY_API_KEY) {
      throw new Error(
        "GATEWAY_VIRTUAL_KEYS_JSON or GATEWAY_API_KEY is required in production",
      );
    }
    if (config.keyPepper.length < 32) {
      throw new Error("GATEWAY_KEY_PEPPER must contain at least 32 characters in production");
    }
    if (config.virtualKeys.some((key) => key.rawKey.length < 32)) {
      if (!config.databaseUrl || config.controlPlaneSeedFromEnv) {
        throw new Error("Every gateway API key must contain at least 32 characters in production");
      }
    }
    if (config.quotaPolicies.length > 0 && !config.redisUrl) {
      throw new Error("REDIS_URL is required when quota policies are enabled in production");
    }
    if (config.metricsEnabled && !env.METRICS_BEARER_TOKEN) {
      throw new Error("METRICS_BEARER_TOKEN is required when metrics are enabled in production");
    }
    if (config.metricsEnabled && config.metricsBearerToken.length < 32) {
      throw new Error("METRICS_BEARER_TOKEN must contain at least 32 characters in production");
    }
    if (config.adminAuth.mode === "static" && config.adminAuth.bearerToken.length < 32) {
      throw new Error("ADMIN_BEARER_TOKEN must contain at least 32 characters in production");
    }
  }

  if (hasAllProviderValues) {
    config.openAICompatible = {
      baseUrl: env.OPENAI_COMPAT_BASE_URL as string,
      apiKey: env.OPENAI_COMPAT_API_KEY ?? "",
      providerModel: env.OPENAI_COMPAT_MODEL as string,
      logicalModel: env.OPENAI_COMPAT_LOGICAL_MODEL ?? "external",
    };
    config.openAICompatibleDeployments.push({
      id: "openai-compatible",
      logicalModel: config.openAICompatible.logicalModel,
      baseUrl: config.openAICompatible.baseUrl,
      apiKey: config.openAICompatible.apiKey,
      providerModel: config.openAICompatible.providerModel,
      priority: 100,
      weight: 1,
    });
  }
  return config;
};
