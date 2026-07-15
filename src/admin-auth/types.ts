export type AdminRole = "viewer" | "operator" | "admin";
export type AdminPermission =
  | "virtual_keys:read"
  | "virtual_keys:create"
  | "virtual_keys:update"
  | "virtual_keys:rotate"
  | "governance:read"
  | "governance:write"
  | "audit:read";

export interface AdminIdentity {
  actorId: string;
  subject: string;
  issuer: string;
  roles: readonly AdminRole[];
  tenantScopes: readonly string[];
  authMethod: "static" | "oidc";
}

export interface AdminAuthenticator {
  authenticate(authorization: string | undefined): Promise<AdminIdentity>;
}
