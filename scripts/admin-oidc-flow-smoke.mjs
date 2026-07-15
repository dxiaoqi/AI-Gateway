import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const gatewayToken = process.env.ADMIN_CONSOLE_TOKEN;
if (!gatewayToken) throw new Error("ADMIN_CONSOLE_TOKEN is required");

const consoleOrigin = "http://127.0.0.1:3100";
const clientId = "admin-console-smoke";
const clientSecret = "admin-console-smoke-secret";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const publicJwk = { ...(await exportJWK(publicKey)), kid: "admin-console-smoke", alg: "RS256", use: "sig" };
const codes = new Map();
let issuer;

const idp = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", issuer);
  if (url.pathname === "/.well-known/openid-configuration") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    }));
    return;
  }
  if (url.pathname === "/jwks") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" })
      .end(JSON.stringify({ keys: [publicJwk] }));
    return;
  }
  if (url.pathname === "/authorize") {
    const required = ["state", "nonce", "code_challenge", "redirect_uri"];
    if (url.searchParams.get("response_type") !== "code" || url.searchParams.get("code_challenge_method") !== "S256"
      || url.searchParams.get("client_id") !== clientId || required.some((name) => !url.searchParams.get(name))) {
      response.writeHead(400).end("invalid authorization request");
      return;
    }
    const code = randomBytes(24).toString("base64url");
    codes.set(code, {
      challenge: url.searchParams.get("code_challenge"),
      nonce: url.searchParams.get("nonce"),
      redirectUri: url.searchParams.get("redirect_uri"),
    });
    const callback = new URL(url.searchParams.get("redirect_uri"));
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", url.searchParams.get("state"));
    response.writeHead(302, { location: callback.toString() }).end();
    return;
  }
  if (url.pathname === "/token" && request.method === "POST") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = new URLSearchParams(raw);
    const record = codes.get(body.get("code"));
    codes.delete(body.get("code"));
    const expectedBasic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    const challenge = createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
    if (!record || request.headers.authorization !== expectedBasic || challenge !== record.challenge
      || body.get("redirect_uri") !== record.redirectUri || body.get("grant_type") !== "authorization_code") {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    const idToken = await new SignJWT({ nonce: record.nonce })
      .setProtectedHeader({ alg: "RS256", kid: "admin-console-smoke", typ: "JWT" })
      .setIssuer(issuer).setAudience(clientId).setSubject("smoke-admin").setIssuedAt().setExpirationTime("5m")
      .sign(privateKey);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      access_token: gatewayToken,
      id_token: idToken,
      token_type: "Bearer",
      expires_in: 300,
    }));
    return;
  }
  response.writeHead(404).end();
});

idp.listen(0, "127.0.0.1");
await once(idp, "listening");
const idpAddress = idp.address();
if (!idpAddress || typeof idpAddress === "string") throw new Error("Mock OIDC server did not bind");
issuer = `http://127.0.0.1:${idpAddress.port}`;

const next = spawn("./node_modules/.bin/next", ["dev", "apps/admin-console", "--hostname", "127.0.0.1", "--port", "3100"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    GATEWAY_API_BASE_URL: "http://127.0.0.1:3000",
    ADMIN_CONSOLE_PUBLIC_ORIGIN: consoleOrigin,
    ADMIN_CONSOLE_SESSION_SECRET: "admin-oidc-flow-smoke-session-secret",
    ADMIN_CONSOLE_OIDC_ISSUER: issuer,
    ADMIN_CONSOLE_OIDC_CLIENT_ID: clientId,
    ADMIN_CONSOLE_OIDC_CLIENT_SECRET: clientSecret,
    ADMIN_CONSOLE_OIDC_REDIRECT_URI: `${consoleOrigin}/api/auth/callback`,
    ADMIN_CONSOLE_ALLOW_DEV_TOKEN_LOGIN: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const waitForConsole = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(consoleOrigin)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Next.js console did not become ready");
};

const transactionCookie = (response) => response.headers.get("set-cookie")?.match(/aigw_oidc_transaction=[^;,]+/)?.[0];
const sessionCookie = (response) => response.headers.get("set-cookie")?.match(/aigw_admin_session=[^;,]+/)?.[0];

try {
  await waitForConsole();
  const login = await fetch(`${consoleOrigin}/api/auth/login`, { redirect: "manual" });
  const txCookie = transactionCookie(login);
  const authorizationLocation = login.headers.get("location");
  if (login.status !== 307 || !txCookie || !authorizationLocation?.startsWith(`${issuer}/authorize`)) {
    throw new Error("OIDC login did not create a transaction and redirect to the provider");
  }
  const authorize = await fetch(authorizationLocation, { redirect: "manual" });
  const callbackLocation = authorize.headers.get("location");
  if (authorize.status !== 302 || !callbackLocation) throw new Error("Mock provider did not authorize");
  const callback = await fetch(callbackLocation, { headers: { cookie: txCookie }, redirect: "manual" });
  const cookie = sessionCookie(callback);
  if (callback.status !== 307 || !cookie || callback.headers.get("location") !== `${consoleOrigin}/`) {
    throw new Error(`OIDC callback did not create a server session: status=${callback.status}, location=${callback.headers.get("location")}, cookies=${callback.headers.get("set-cookie")?.replace(/=[^;,]+/g, "=REDACTED")}`);
  }
  const session = await fetch(`${consoleOrigin}/api/auth/session`, { headers: { cookie } });
  const me = await fetch(`${consoleOrigin}/api/gateway/admin/v1/me`, { headers: { cookie } });
  if (!session.ok || !me.ok || !(await me.json()).roles?.includes("admin")) {
    throw new Error("OIDC session was not accepted by the Gateway BFF");
  }
  console.log("Admin OIDC flow smoke passed: discovery -> state/nonce -> PKCE S256 -> code exchange -> ID token -> server session -> BFF");
} finally {
  next.kill("SIGTERM");
  if (next.exitCode === null) await Promise.race([once(next, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  idp.close();
  await once(idp, "close");
}
