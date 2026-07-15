import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { randomUrlSafe } from "./session";

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

let cachedDiscovery: { value: Discovery; expiresAt: number } | undefined;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertSafeUrl(value: string, label: string) {
  const url = new URL(value);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && local)) {
    throw new Error(`${label} must use HTTPS`);
  }
  return url;
}

export function oidcEnabled() {
  return Boolean(process.env.ADMIN_CONSOLE_OIDC_ISSUER && process.env.ADMIN_CONSOLE_OIDC_CLIENT_ID);
}

export function oidcConfig() {
  const issuer = required("ADMIN_CONSOLE_OIDC_ISSUER").replace(/\/$/, "");
  const clientId = required("ADMIN_CONSOLE_OIDC_CLIENT_ID");
  const redirectUri = process.env.ADMIN_CONSOLE_OIDC_REDIRECT_URI
    ?? `${process.env.ADMIN_CONSOLE_PUBLIC_ORIGIN ?? "http://127.0.0.1:3100"}/api/auth/callback`;
  assertSafeUrl(issuer, "OIDC issuer");
  assertSafeUrl(redirectUri, "OIDC redirect URI");
  return {
    issuer,
    clientId,
    clientSecret: process.env.ADMIN_CONSOLE_OIDC_CLIENT_SECRET,
    redirectUri,
    scopes: process.env.ADMIN_CONSOLE_OIDC_SCOPES?.trim() || "openid profile",
  };
}

export async function discoverOidc(): Promise<Discovery> {
  if (cachedDiscovery && cachedDiscovery.expiresAt > Date.now()) return cachedDiscovery.value;
  const config = oidcConfig();
  const response = await fetch(`${config.issuer}/.well-known/openid-configuration`, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`OIDC discovery failed with HTTP ${response.status}`);
  const body = await response.json() as Partial<Discovery>;
  if (body.issuer !== config.issuer || !body.authorization_endpoint || !body.token_endpoint || !body.jwks_uri) {
    throw new Error("OIDC discovery response is invalid");
  }
  assertSafeUrl(body.authorization_endpoint, "OIDC authorization endpoint");
  assertSafeUrl(body.token_endpoint, "OIDC token endpoint");
  assertSafeUrl(body.jwks_uri, "OIDC JWKS URI");
  const value = body as Discovery;
  cachedDiscovery = { value, expiresAt: Date.now() + 5 * 60_000 };
  return value;
}

export function createAuthorizationValues() {
  const codeVerifier = randomUrlSafe(32);
  return {
    state: randomUrlSafe(),
    nonce: randomUrlSafe(),
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
  };
}

export async function exchangeAuthorizationCode(code: string, codeVerifier: string, nonce: string) {
  const config = oidcConfig();
  const discovery = await discoverOidc();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  });
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (config.clientSecret) {
    const user = encodeURIComponent(config.clientId);
    const password = encodeURIComponent(config.clientSecret);
    headers.set("authorization", `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`);
  }
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers,
    body,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OIDC token exchange failed with HTTP ${response.status}`);
  const tokens = await response.json() as { access_token?: unknown; id_token?: unknown; expires_in?: unknown };
  if (typeof tokens.access_token !== "string" || typeof tokens.id_token !== "string") {
    throw new Error("OIDC token response is missing required tokens");
  }
  const verified = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(discovery.jwks_uri)), {
    issuer: config.issuer,
    audience: config.clientId,
    algorithms: ["RS256", "ES256"],
  });
  const receivedNonce = typeof verified.payload.nonce === "string" ? Buffer.from(verified.payload.nonce) : Buffer.alloc(0);
  const expectedNonce = Buffer.from(nonce);
  if (
    !verified.payload.sub
    || typeof verified.payload.exp !== "number"
    || receivedNonce.length !== expectedNonce.length
    || !timingSafeEqual(receivedNonce, expectedNonce)
  ) {
    throw new Error("OIDC ID token claims are invalid");
  }
  return {
    accessToken: tokens.access_token,
    expiresIn: typeof tokens.expires_in === "number" ? tokens.expires_in : undefined,
  };
}
