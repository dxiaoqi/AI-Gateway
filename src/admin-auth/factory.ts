import type { GatewayConfig } from "../config.js";
import { AdminAuthorizationService, OidcAdminAuthenticator, StaticAdminAuthenticator } from "./service.js";
import { LocalAdminAuthenticator } from "./local.js";

export const createAdminAuthorizationService = (config: GatewayConfig): AdminAuthorizationService | undefined => {
  if (config.adminAuth.mode === "disabled") return undefined;
  const authenticator = config.adminAuth.mode === "static"
    ? new StaticAdminAuthenticator(config.adminAuth.bearerToken)
    : config.adminAuth.mode === "local"
      ? new LocalAdminAuthenticator(config.adminAuth)
      : new OidcAdminAuthenticator(config.adminAuth);
  return new AdminAuthorizationService(authenticator);
};
