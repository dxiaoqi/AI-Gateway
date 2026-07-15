import { createServer } from "node:http";
import { once } from "node:events";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { AuthService } from "../src/auth/service.js";
import { loadConfig } from "../src/config.js";
import { InMemoryControlPlaneRepository } from "../src/control-plane/in-memory-repository.js";
import { VirtualKeyControlPlaneService } from "../src/control-plane/service.js";
import { buildApp } from "../src/server/app.js";

const issuer = "https://local-identity.example/tenant";
const audience = "ai-gateway-admin";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const publicJwk = { ...(await exportJWK(publicKey)), kid: "smoke-key", alg: "RS256", use: "sig" };
let jwksRequests = 0;
const jwksServer = createServer((request, response) => {
  if (request.url !== "/jwks") {
    response.writeHead(404).end();
    return;
  }
  jwksRequests += 1;
  response.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=600" });
  response.end(JSON.stringify({ keys: [publicJwk] }));
});
jwksServer.listen(0, "127.0.0.1");
await once(jwksServer, "listening");
const jwksAddress = jwksServer.address();
if (!jwksAddress || typeof jwksAddress === "string") throw new Error("JWKS server did not bind a TCP port");

const sign = (subject: string, role: string, tokenAudience = audience, tenantScopes = ["tenant-a"]) => new SignJWT({
  groups: [role],
  ai_gateway_tenants: tenantScopes,
})
  .setProtectedHeader({ alg: "RS256", kid: "smoke-key", typ: "JWT" })
  .setIssuer(issuer)
  .setAudience(tokenAudience)
  .setSubject(subject)
  .setIssuedAt()
  .setExpirationTime("5m")
  .sign(privateKey);

const repository = new InMemoryControlPlaneRepository();
const controlPlane = new VirtualKeyControlPlaneService(repository, "oidc-smoke-pepper", () => "aigw_oidc_smoke_secret");
const config = loadConfig({
  ADMIN_AUTH_MODE: "oidc",
  ADMIN_OIDC_ISSUER: issuer,
  ADMIN_OIDC_AUDIENCE: audience,
  ADMIN_OIDC_JWKS_URL: `http://127.0.0.1:${jwksAddress.port}/jwks`,
  ADMIN_OIDC_ROLE_CLAIM: "groups",
  ADMIN_OIDC_TENANT_CLAIM: "ai_gateway_tenants",
  ADMIN_OIDC_ROLE_MAP_JSON: JSON.stringify({ gateway_viewers: "viewer", gateway_operators: "operator", gateway_admins: "admin" }),
  ADMIN_OIDC_ALLOWED_ALGORITHMS: "RS256",
  ROTATION_APPROVAL_REQUIRED: "true",
  METRICS_ENABLED: "false",
  LOG_LEVEL: "warn",
});
const app = await buildApp({
  config,
  authService: new AuthService(repository, "oidc-smoke-pepper"),
  controlPlaneService: controlPlane,
});

try {
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const tokens = {
    viewer: await sign("employee-viewer", "gateway_viewers"),
    operator: await sign("employee-operator", "gateway_operators"),
    adminRequester: await sign("employee-admin-requester", "gateway_admins"),
    adminApprover: await sign("employee-admin-approver", "gateway_admins"),
    otherTenant: await sign("employee-other-tenant", "gateway_viewers", audience, ["tenant-b"]),
    wrongAudience: await sign("employee-admin", "gateway_admins", "another-api"),
  };
  const request = (path: string, token: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const expectStatus = async (response: Response, expected: number, label: string) => {
    if (response.status !== expected) throw new Error(`${label}: expected ${expected}, got ${response.status}: ${await response.text()}`);
    return response;
  };

  await expectStatus(await request("/admin/v1/virtual-keys", tokens.viewer), 200, "viewer read");
  await expectStatus(await request("/admin/v1/virtual-keys", tokens.viewer, {
    method: "POST",
    body: JSON.stringify({ keyId: "denied", tenantId: "t", projectId: "p", applicationId: "a", allowedModels: ["general"] }),
  }), 403, "viewer create denied");
  await expectStatus(await request("/admin/v1/virtual-keys", tokens.wrongAudience), 401, "wrong audience denied");
  await expectStatus(await request("/admin/v1/virtual-keys", tokens.operator, {
    method: "POST",
    body: JSON.stringify({ keyId: "oidc-smoke", tenantId: "tenant-a", projectId: "project", applicationId: "app", allowedModels: ["general"] }),
  }), 201, "operator create");
  const otherTenantList = await expectStatus(await request("/admin/v1/virtual-keys", tokens.otherTenant), 200, "other tenant read");
  if (((await otherTenantList.json()) as { data: unknown[] }).data.length !== 0) throw new Error("cross-tenant list leaked a virtual key");
  await expectStatus(await request("/admin/v1/virtual-keys/oidc-smoke/rotate", tokens.operator, {
    method: "POST", headers: { "if-match": "1" },
  }), 403, "operator rotate denied");
  await expectStatus(await request("/admin/v1/virtual-keys/oidc-smoke/rotate", tokens.adminRequester, {
    method: "POST", headers: { "if-match": "1" },
  }), 409, "direct rotation requires approval");
  const requestedResponse = await expectStatus(await request("/admin/v1/virtual-keys/oidc-smoke/rotation-requests", tokens.adminRequester, {
    method: "POST", headers: { "if-match": "1" },
  }), 201, "admin requests rotation");
  const requested = await requestedResponse.json() as { rotationRequest: { requestId: string } };
  await expectStatus(await request(`/admin/v1/rotation-requests/${requested.rotationRequest.requestId}/approve`, tokens.adminRequester, {
    method: "POST",
  }), 409, "requester cannot self-approve");
  await expectStatus(await request(`/admin/v1/rotation-requests/${requested.rotationRequest.requestId}/approve`, tokens.adminApprover, {
    method: "POST",
  }), 200, "second admin approves rotation");
  const auditResponse = await expectStatus(await request("/admin/v1/audit-events", tokens.viewer), 200, "viewer audit read");
  const audit = await auditResponse.json() as { data: Array<Record<string, unknown>> };
  if (audit.data[0]?.actorSubject !== "employee-admin-approver" || audit.data[0]?.authMethod !== "oidc") {
    throw new Error("OIDC actor identity was not preserved in the audit event");
  }
  if (jwksRequests !== 1) throw new Error(`expected JWKS cache to fetch once, got ${jwksRequests}`);
  console.log("OIDC smoke passed: JWKS -> JWT -> tenant scope -> RBAC -> two-person rotation -> actor audit; JWKS fetched once");
} finally {
  await app.close();
  jwksServer.close();
  await once(jwksServer, "close");
}
