import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("Next.js administrator console", () => {
  it("keeps administrator tokens behind a server-side session and uses a same-origin BFF", async () => {
    const consoleSource = await read("apps/admin-console/components/admin-console.tsx");
    expect(consoleSource).toContain("/api/auth/session");
    expect(consoleSource).toContain("/api/gateway/admin/v1/");
    expect(consoleSource).not.toContain("Authorization: `Bearer");
    expect(consoleSource).not.toContain("localStorage");
    expect(consoleSource).not.toContain("sessionStorage");
    expect(consoleSource).not.toContain("NEXT_PUBLIC_");
  });

  it("restricts the server-side proxy to administrator API paths", async () => {
    const proxy = await read("apps/admin-console/app/api/gateway/[...path]/route.ts");
    expect(proxy).toContain('const allowedPrefix = "admin/v1/"');
    expect(proxy).toContain('redirect: "manual"');
    expect(proxy).toContain("unsafeSegment");
    expect(proxy).toContain("hasValidCsrf");
    expect(proxy).toContain("readSession");
    expect(proxy).not.toContain("console.log");
  });

  it("implements OIDC code flow with PKCE and one-time state", async () => {
    const oidc = await read("apps/admin-console/lib/oidc.ts");
    const login = await read("apps/admin-console/app/api/auth/login/route.ts");
    const callback = await read("apps/admin-console/app/api/auth/callback/route.ts");
    expect(login).toContain('code_challenge_method: "S256"');
    expect(login).toContain("nonce:");
    expect(callback).toContain("consumeOidcTransaction");
    expect(oidc).toContain("jwtVerify");
  });

  it("documents a server-only Gateway base URL", async () => {
    const env = await read("apps/admin-console/.env.example");
    expect(env).toContain("GATEWAY_API_BASE_URL=");
    expect(env).toContain("ADMIN_CONSOLE_OIDC_ISSUER=");
    expect(env).toContain("ADMIN_CONSOLE_SESSION_SECRET=");
    expect(env).not.toContain("NEXT_PUBLIC_");
  });

  it("exposes the approval closure and notification inbox through the console", async () => {
    const consoleSource = await read("apps/admin-console/components/admin-console.tsx");
    const routes = await read("src/server/routes/admin-virtual-keys.ts");
    expect(consoleSource).toContain('action: "reject"');
    expect(consoleSource).toContain('action: "cancel"');
    expect(consoleSource).toContain('view === "notifications"');
    expect(routes).toContain("RotationListQuery");
    expect(routes).toContain('/admin/v1/notifications/:notificationId/read');
  });

  it("supports one-time local Owner bootstrap without exposing the access token", async () => {
    const consoleSource = await read("apps/admin-console/components/admin-console.tsx");
    const bootstrap = await read("apps/admin-console/app/api/auth/local/bootstrap/route.ts");
    const localAuth = await read("src/admin-auth/local.ts");
    expect(consoleSource).toContain("创建主组织并进入");
    expect(bootstrap).toContain("createSession");
    expect(bootstrap).not.toContain("accessToken: body.accessToken");
    expect(localAuth).toContain('open(this.config.accountFile, "wx"');
    expect(localAuth).toContain("scrypt");
    expect(localAuth).not.toContain("console.log");
  });
});
