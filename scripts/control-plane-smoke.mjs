const baseUrl = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:3000";
const adminToken = process.env.ADMIN_BEARER_TOKEN;
if (!adminToken) throw new Error("ADMIN_BEARER_TOKEN is required");

const keyId = `smoke-${Date.now()}`;
const admin = async (path, options = {}) => fetch(`${baseUrl}${path}`, {
  ...options,
  headers: {
    authorization: `Bearer ${adminToken}`,
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...options.headers,
  },
});
const expectStatus = async (response, expected, label) => {
  if (response.status !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${response.status}: ${await response.text()}`);
  }
  return response;
};
const business = (key) => fetch(`${baseUrl}/v1/models`, {
  headers: { authorization: `Bearer ${key}` },
});

const createdResponse = await expectStatus(await admin("/admin/v1/virtual-keys", {
  method: "POST",
  body: JSON.stringify({
    keyId,
    tenantId: "smoke-tenant",
    projectId: "smoke-project",
    applicationId: "smoke-app",
    allowedModels: ["general"],
  }),
}), 201, "create virtual key");
const created = await createdResponse.json();
const originalKey = created.key;
await expectStatus(await business(originalKey), 200, "new key authenticates");

await expectStatus(await admin(`/admin/v1/virtual-keys/${keyId}`, {
  method: "PATCH",
  headers: { "if-match": "1" },
  body: JSON.stringify({ enabled: false }),
}), 200, "disable key");
await expectStatus(await business(originalKey), 401, "disabled key is rejected immediately");

await expectStatus(await admin(`/admin/v1/virtual-keys/${keyId}`, {
  method: "PATCH",
  headers: { "if-match": "2" },
  body: JSON.stringify({ enabled: true }),
}), 200, "enable key");
const rotatedResponse = await expectStatus(await admin(`/admin/v1/virtual-keys/${keyId}/rotate`, {
  method: "POST",
  headers: { "if-match": "3" },
}), 200, "rotate key");
const rotated = await rotatedResponse.json();
await expectStatus(await business(originalKey), 401, "old key is rejected after rotation");
await expectStatus(await business(rotated.key), 200, "rotated key authenticates");

const auditResponse = await expectStatus(await admin("/admin/v1/audit-events?limit=20"), 200, "read audit events");
const auditBody = await auditResponse.text();
if (!auditBody.includes(keyId) || auditBody.includes(originalKey) || auditBody.includes(rotated.key) || auditBody.includes("keyHash")) {
  throw new Error("audit log is missing the resource or contains secret material");
}

console.log(`Control-plane smoke passed for ${keyId}: create -> disable -> enable -> rotate -> audit`);
