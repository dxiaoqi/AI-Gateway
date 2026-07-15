import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JSONWebKeySet,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { AdminAuthorizationService, OidcAdminAuthenticator } from "../src/admin-auth/service.js";
import type { AdminOidcConfig } from "../src/config.js";

const issuer = "https://identity.test/tenant";
const audience = "ai-gateway-admin";
let privateKey: CryptoKey;
let alternatePrivateKey: CryptoKey;
let jwks: JSONWebKeySet;

const config: AdminOidcConfig = {
  mode: "oidc",
  issuer,
  audience,
  jwksUrl: "https://unused.test/jwks",
  roleClaim: "realm_access.roles",
  tenantClaim: "tenant_access.ids",
  roleMap: { readers: "viewer", operators: "operator", owners: "admin" },
  allowedAlgorithms: ["RS256"],
  requiredTyp: "JWT",
  clockToleranceSeconds: 5,
  jwksTimeoutMs: 1000,
  jwksCooldownMs: 1000,
  jwksCacheMaxAgeMs: 60_000,
};

const sign = async (options: {
  subject?: string;
  tokenIssuer?: string;
  tokenAudience?: string;
  roles?: string[];
  expiresIn?: string | number;
  key?: CryptoKey;
  algorithm?: string;
  tenants?: string[];
}) => new SignJWT({
  realm_access: { roles: options.roles ?? ["readers"] },
  tenant_access: { ids: options.tenants ?? ["tenant-a"] },
})
  .setProtectedHeader({ alg: options.algorithm ?? "RS256", kid: options.algorithm === "ES256" ? "ec-key" : "rsa-key", typ: "JWT" })
  .setIssuer(options.tokenIssuer ?? issuer)
  .setAudience(options.tokenAudience ?? audience)
  .setSubject(options.subject ?? "employee-123")
  .setIssuedAt()
  .setExpirationTime(options.expiresIn ?? "5m")
  .sign(options.key ?? privateKey);

beforeAll(async () => {
  const rsa = await generateKeyPair("RS256");
  const ec = await generateKeyPair("ES256");
  privateKey = rsa.privateKey;
  alternatePrivateKey = ec.privateKey;
  jwks = {
    keys: [
      { ...(await exportJWK(rsa.publicKey)), kid: "rsa-key", alg: "RS256", use: "sig" },
      { ...(await exportJWK(ec.publicKey)), kid: "ec-key", alg: "ES256", use: "sig" },
    ],
  };
});

describe("OIDC administrator authentication and RBAC", () => {
  const createService = () => new AdminAuthorizationService(
    new OidcAdminAuthenticator(config, createLocalJWKSet(jwks)),
  );

  it("verifies the signature and standard claims, then maps nested roles", async () => {
    const service = createService();
    const identity = await service.authenticate(`Bearer ${await sign({ roles: ["readers", "operators", "ignored"] })}`);
    expect(identity).toMatchObject({
      subject: "employee-123",
      issuer,
      roles: ["viewer", "operator"],
      tenantScopes: ["tenant-a"],
      authMethod: "oidc",
    });
    expect(identity.actorId).toMatch(/^oidc:[a-f0-9]{20}$/u);
    expect(() => service.assertPermission(identity, "virtual_keys:update")).not.toThrow();
    expect(() => service.assertPermission(identity, "virtual_keys:rotate")).toThrowError(
      expect.objectContaining({ statusCode: 403, code: "authorization_error" }),
    );
  });

  it("rejects wrong issuer, audience, expiration and algorithms", async () => {
    const service = createService();
    const invalidTokens = [
      await sign({ tokenIssuer: "https://attacker.test" }),
      await sign({ tokenAudience: "another-api" }),
      await sign({ expiresIn: -60 }),
      await sign({ key: alternatePrivateKey, algorithm: "ES256" }),
    ];
    for (const token of invalidTokens) {
      await expect(service.authenticate(`Bearer ${token}`)).rejects.toMatchObject({
        statusCode: 401,
        code: "authentication_error",
      });
    }
  });

  it("authenticates a valid user without mapped roles but grants no permission", async () => {
    const service = createService();
    const identity = await service.authenticate(`Bearer ${await sign({ roles: ["unrelated-group"] })}`);
    expect(identity.roles).toEqual([]);
    expect(() => service.assertPermission(identity, "virtual_keys:read")).toThrowError(
      expect.objectContaining({ statusCode: 403 }),
    );
  });

  it("denies tenant access when the scoped claim is empty", async () => {
    const service = createService();
    const identity = await service.authenticate(`Bearer ${await sign({ roles: ["owners"], tenants: [] })}`);
    expect(identity.tenantScopes).toEqual([]);
    expect(() => service.assertTenantAccess(identity, "tenant-a")).toThrowError(
      expect.objectContaining({ statusCode: 403, code: "authorization_error" }),
    );
  });
});
