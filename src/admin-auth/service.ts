import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { AdminOidcConfig } from "../config.js";
import { GatewayError } from "../core/errors.js";
import type { AdminAuthenticator, AdminIdentity, AdminPermission, AdminRole } from "./types.js";

const rolePermissions: Readonly<Record<AdminRole, ReadonlySet<AdminPermission>>> = {
  viewer: new Set(["virtual_keys:read", "audit:read"]),
  operator: new Set(["virtual_keys:read", "virtual_keys:create", "virtual_keys:update", "audit:read"]),
  admin: new Set([
    "virtual_keys:read",
    "virtual_keys:create",
    "virtual_keys:update",
    "virtual_keys:rotate",
    "audit:read",
  ]),
};

const authenticationError = (): GatewayError => new GatewayError({
  message: "Invalid or missing administrator credential",
  statusCode: 401,
  code: "authentication_error",
});

const parseBearer = (authorization: string | undefined): string => {
  if (!authorization?.startsWith("Bearer ")) throw authenticationError();
  const token = authorization.slice(7);
  if (!token || token.includes(" ") || token.length > 16_384) throw authenticationError();
  return token;
};

const readClaim = (payload: JWTPayload, path: string): unknown => {
  let value: unknown = payload;
  for (const segment of path.split(".")) {
    if (typeof value !== "object" || value === null || !(segment in value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
};

const mapRoles = (claim: unknown, roleMap: Readonly<Record<string, AdminRole>>): AdminRole[] => {
  const externalRoles = typeof claim === "string"
    ? [claim]
    : Array.isArray(claim) && claim.every((role) => typeof role === "string")
      ? claim
      : [];
  return [...new Set(externalRoles.map((role) => roleMap[role]).filter((role): role is AdminRole => role !== undefined))];
};

const mapTenantScopes = (claim: unknown): string[] => {
  const values = typeof claim === "string" ? [claim] : Array.isArray(claim) ? claim : [];
  if (
    values.length > 1000 ||
    !values.every((value) => typeof value === "string" && value.length > 0 && value.length <= 200)
  ) return [];
  return [...new Set(values as string[])];
};

export class StaticAdminAuthenticator implements AdminAuthenticator {
  private readonly expectedDigest: Buffer;

  constructor(token: string) {
    this.expectedDigest = createHash("sha256").update(token).digest();
  }

  async authenticate(authorization: string | undefined): Promise<AdminIdentity> {
    const supplied = parseBearer(authorization);
    const suppliedDigest = createHash("sha256").update(supplied).digest();
    if (!timingSafeEqual(suppliedDigest, this.expectedDigest)) throw authenticationError();
    return {
      actorId: `static:${this.expectedDigest.toString("hex").slice(0, 12)}`,
      subject: this.expectedDigest.toString("hex").slice(0, 16),
      issuer: "local-static-token",
      roles: ["admin"],
      tenantScopes: ["*"],
      authMethod: "static",
    };
  }
}

export class OidcAdminAuthenticator implements AdminAuthenticator {
  private readonly jwks;

  constructor(private readonly config: AdminOidcConfig, jwks?: JWTVerifyGetKey) {
    this.jwks = jwks ?? createRemoteJWKSet(new URL(config.jwksUrl), {
        timeoutDuration: config.jwksTimeoutMs,
        cooldownDuration: config.jwksCooldownMs,
        cacheMaxAge: config.jwksCacheMaxAgeMs,
      });
  }

  async authenticate(authorization: string | undefined): Promise<AdminIdentity> {
    const token = parseBearer(authorization);
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: [...this.config.allowedAlgorithms],
        typ: this.config.requiredTyp,
        requiredClaims: ["sub", "exp"],
        clockTolerance: this.config.clockToleranceSeconds,
      });
      const subject = result.payload.sub;
      if (!subject) throw authenticationError();
      const roles = mapRoles(readClaim(result.payload, this.config.roleClaim), this.config.roleMap);
      const tenantScopes = mapTenantScopes(readClaim(result.payload, this.config.tenantClaim));
      return {
        actorId: `oidc:${createHash("sha256").update(`${this.config.issuer}\u0000${subject}`).digest("hex").slice(0, 20)}`,
        subject,
        issuer: this.config.issuer,
        roles,
        tenantScopes,
        authMethod: "oidc",
      };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw authenticationError();
    }
  }
}

export class AdminAuthorizationService {
  constructor(private readonly authenticator: AdminAuthenticator) {}

  authenticate(authorization: string | undefined): Promise<AdminIdentity> {
    return this.authenticator.authenticate(authorization);
  }

  assertPermission(identity: AdminIdentity, permission: AdminPermission): void {
    if (!identity.roles.some((role) => rolePermissions[role].has(permission))) {
      throw new GatewayError({
        message: `Administrator does not have '${permission}' permission`,
        statusCode: 403,
        code: "authorization_error",
      });
    }
  }

  assertTenantAccess(identity: AdminIdentity, tenantId: string): void {
    if (!identity.tenantScopes.includes("*") && !identity.tenantScopes.includes(tenantId)) {
      throw new GatewayError({
        message: `Administrator is not authorized for tenant '${tenantId}'`,
        statusCode: 403,
        code: "authorization_error",
      });
    }
  }
}
