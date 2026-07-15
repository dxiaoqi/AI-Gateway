const baseUrl = process.env.ADMIN_CONSOLE_BASE_URL ?? "http://127.0.0.1:3100";
const token = process.env.ADMIN_CONSOLE_TOKEN;
if (!token) throw new Error("ADMIN_CONSOLE_TOKEN is required");

const request = async (path, expected, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  if (response.status !== expected) {
    throw new Error(`${path}: expected ${expected}, received ${response.status}`);
  }
  return response;
};

const page = await request("/", 200);
const html = await page.text();
if (!html.includes("AI Gateway Control") || !html.includes("恢复安全会话")) {
  throw new Error("Next.js administrator console shell is incomplete");
}
if (page.headers.get("x-frame-options") !== "DENY") {
  throw new Error("Administrator console is missing clickjacking protection");
}

await request("/api/gateway/admin/v1/me", 401);
await request("/api/gateway/v1/models", 404, {
  headers: { authorization: `Bearer ${token}` },
});

const login = await request("/api/auth/dev-token", 200, {
  method: "POST",
  headers: { "content-type": "application/json", origin: baseUrl },
  body: JSON.stringify({ token }),
});
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
const loginBody = await login.json();
const csrfToken = loginBody.csrfToken;
if (!cookie?.startsWith("aigw_admin_session=") || !csrfToken) {
  throw new Error("Development login did not create an opaque server session");
}

const adminHeaders = { cookie };
const mutationHeaders = { cookie, origin: baseUrl, "x-csrf-token": csrfToken };
const me = await request("/api/gateway/admin/v1/me", 200, { headers: adminHeaders });
const identity = await me.json();
if (!identity.roles?.includes("admin") || !identity.tenantScopes?.includes("*")) {
  throw new Error("Administrator identity was not preserved through the BFF");
}

const keyId = `console-smoke-${Date.now()}`;
await request("/api/gateway/admin/v1/virtual-keys", 403, {
  method: "POST",
  headers: { ...adminHeaders, "content-type": "application/json" },
  body: JSON.stringify({ keyId: "must-not-exist" }),
});
const created = await request("/api/gateway/admin/v1/virtual-keys", 201, {
  method: "POST",
  headers: { ...mutationHeaders, "content-type": "application/json" },
  body: JSON.stringify({
    keyId,
    tenantId: "console-smoke-tenant",
    projectId: "console-smoke-project",
    applicationId: "console-smoke-app",
    allowedModels: ["general"],
  }),
});
const createdBody = await created.json();
if (!createdBody.key || createdBody.virtualKey?.version !== 1) {
  throw new Error("One-time virtual key response was not preserved through the BFF");
}

await request(`/api/gateway/admin/v1/virtual-keys/${encodeURIComponent(keyId)}`, 200, {
  method: "PATCH",
  headers: { ...mutationHeaders, "content-type": "application/json", "if-match": "1" },
  body: JSON.stringify({ enabled: false }),
});

const listed = await request("/api/gateway/admin/v1/virtual-keys?limit=200", 200, { headers: adminHeaders });
const keys = (await listed.json()).data;
if (!keys.some((item) => item.keyId === keyId && item.enabled === false)) {
  throw new Error("Created virtual key was not visible or disabled through the console BFF");
}

const audit = await request("/api/gateway/admin/v1/audit-events?limit=100", 200, { headers: adminHeaders });
if (!(await audit.json()).data.some((event) => event.resourceId === keyId)) {
  throw new Error("Administrator console mutation was not audited");
}

await request("/api/auth/logout", 403, { method: "POST", headers: { cookie, origin: "http://attacker.invalid", "x-csrf-token": csrfToken } });
await request("/api/auth/logout", 200, { method: "POST", headers: mutationHeaders });
await request("/api/auth/session", 401, { headers: { cookie } });
await request("/api/gateway/admin/v1/me", 401, { headers: { cookie } });

console.log("Admin console smoke passed: login -> HttpOnly session -> restricted BFF -> CSRF -> create -> disable -> audit -> logout");
