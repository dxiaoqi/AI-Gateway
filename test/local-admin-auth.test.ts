import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server/app.js";

describe("local owner bootstrap and password login", () => {
  let app: FastifyInstance | undefined; let directory: string | undefined;
  afterEach(async () => { await app?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  const setup = async () => {
    directory = await mkdtemp(join(tmpdir(), "aigw-local-auth-"));
    app = await buildApp({ config: loadConfig({ ADMIN_AUTH_MODE: "local", ADMIN_LOCAL_ACCOUNT_FILE: join(directory, "owner.json"), METRICS_ENABLED: "false" }) });
  };
  const bootstrap = () => app!.inject({ method: "POST", url: "/admin/auth/local/bootstrap", payload: { organizationName: "Example Organization", username: "owner@example.com", password: "strong-password-123" } });

  it("creates the only owner, issues a signed identity and closes registration", async () => {
    await setup();
    expect((await app!.inject({ method: "GET", url: "/admin/auth/local/status" })).json()).toMatchObject({ enabled: true, bootstrapAvailable: true });
    const created = await bootstrap(); expect(created.statusCode).toBe(201);
    const accessToken = created.json().accessToken as string; expect(accessToken.split(".")).toHaveLength(3);
    expect((await bootstrap()).statusCode).toBe(409);
    expect((await app!.inject({ method: "GET", url: "/admin/auth/local/status" })).json().bootstrapAvailable).toBe(false);
    const me = await app!.inject({ method: "GET", url: "/admin/v1/me", headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.statusCode).toBe(200); expect(me.json()).toMatchObject({ roles: ["admin"], tenantScopes: ["*"], authMethod: "local" });
  });

  it("verifies the password and rate limits repeated failures", async () => {
    await setup(); await bootstrap();
    const login = (password: string) => app!.inject({ method: "POST", url: "/admin/auth/local/login", payload: { username: "owner@example.com", password } });
    expect((await login("wrong-password")).statusCode).toBe(401);
    expect((await login("strong-password-123")).statusCode).toBe(200);
    for (let index = 0; index < 5; index += 1) await login("wrong-password");
    const limited = await login("wrong-password"); expect(limited.statusCode).toBe(429);
  });

  it("records the local Owner identity on managed changes", async () => {
    await setup(); const token = (await bootstrap()).json().accessToken as string;
    const created = await app!.inject({ method: "POST", url: "/admin/v1/virtual-keys", headers: { authorization: `Bearer ${token}` }, payload: { keyId: "owner-created", tenantId: "tenant-a", projectId: "project-a", applicationId: "app-a", allowedModels: ["general"] } });
    expect(created.statusCode).toBe(201);
    const audit = await app!.inject({ method: "GET", url: "/admin/v1/audit-events", headers: { authorization: `Bearer ${token}` } });
    expect(audit.json().data[0]).toMatchObject({ authMethod: "local", actorIssuer: "aigateway-local", actorRoles: ["admin"] });
  });
});
