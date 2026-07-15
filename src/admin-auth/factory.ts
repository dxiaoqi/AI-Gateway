import type { GatewayConfig } from "../config.js";
import { AdminAuthorizationService, OidcAdminAuthenticator, StaticAdminAuthenticator } from "./service.js";

export const createAdminAuthorizationService = (config: GatewayConfig): AdminAuthorizationService | undefined => {
  if (config.adminAuth.mode === "disabled") return undefined;
  const authenticator = config.adminAuth.mode === "static"
    ? new StaticAdminAuthenticator(config.adminAuth.bearerToken)
    : new OidcAdminAuthenticator(config.adminAuth);
  return new AdminAuthorizationService(authenticator);
};
