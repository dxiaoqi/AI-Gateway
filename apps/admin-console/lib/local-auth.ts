import "server-only";

const gateway = () => process.env.GATEWAY_API_BASE_URL ?? "http://127.0.0.1:3000";

export async function localAuthStatus() {
  try {
    const response = await fetch(new URL("/admin/auth/local/status", gateway()), { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(3_000) });
    return response.ok ? await response.json() as { enabled: boolean; bootstrapAvailable: boolean; mode: "local" } : { enabled: false, bootstrapAvailable: false };
  } catch { return { enabled: false, bootstrapAvailable: false }; }
}

export async function localAuthRequest(path: "bootstrap" | "login", payload: unknown) {
  const headers = new Headers({ "content-type": "application/json" });
  if (path === "bootstrap" && process.env.ADMIN_LOCAL_BOOTSTRAP_TOKEN) headers.set("authorization", `Bearer ${process.env.ADMIN_LOCAL_BOOTSTRAP_TOKEN}`);
  return fetch(new URL(`/admin/auth/local/${path}`, gateway()), { method: "POST", headers, body: JSON.stringify(payload), cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(8_000) });
}
