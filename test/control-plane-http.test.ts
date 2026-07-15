import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AuthService } from "../src/auth/service.js";
import { loadConfig } from "../src/config.js";
import { InMemoryControlPlaneRepository } from "../src/control-plane/in-memory-repository.js";
import { VirtualKeyControlPlaneService } from "../src/control-plane/service.js";
import { buildApp } from "../src/server/app.js";
import { AdminAuthorizationService } from "../src/admin-auth/service.js";
import type { AdminAuthenticator, AdminRole } from "../src/admin-auth/types.js";

const pepper = "test-pepper";
const adminToken = "test-admin-token";
const secretValues = ["aigw_created_secret", "aigw_rotated_secret"];

describe("virtual-key control-plane HTTP lifecycle", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());

  it("creates, authorizes, disables, rotates and audits a virtual key", async () => {
    const repository = new InMemoryControlPlaneRepository();
    const service = new VirtualKeyControlPlaneService(repository, pepper, () => secretValues.shift()!);
    const config = loadConfig({
      GATEWAY_KEY_PEPPER: pepper,
      ADMIN_BEARER_TOKEN: adminToken,
      METRICS_ENABLED: "false",
    });
    app = await buildApp({
      config,
      authService: new AuthService(repository, pepper),
      controlPlaneService: service,
    });

    const unauthorized = await app.inject({ method: "GET", url: "/admin/v1/virtual-keys" });
    expect(unauthorized.statusCode).toBe(401);

    const created = await app.inject({
      method: "POST",
      url: "/admin/v1/virtual-keys",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        keyId: "frontend-team",
        tenantId: "tenant-a",
        projectId: "project-a",
        applicationId: "web-app",
        allowedModels: ["general"],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ key: "aigw_created_secret", virtualKey: { version: 1 } });
    expect(created.body).not.toContain("keyHash");

    const businessRequest = () => app!.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer aigw_created_secret" },
      payload: { model: "general", messages: [{ role: "user", content: "hello" }] },
    });
    expect((await businessRequest()).statusCode).toBe(200);

    const missingPrecondition = await app.inject({
      method: "PATCH",
      url: "/admin/v1/virtual-keys/frontend-team",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(missingPrecondition.statusCode).toBe(428);

    const disabled = await app.inject({
      method: "PATCH",
      url: "/admin/v1/virtual-keys/frontend-team",
      headers: { authorization: `Bearer ${adminToken}`, "if-match": "\"1\"" },
      payload: { enabled: false },
    });
    expect(disabled.json()).toMatchObject({ enabled: false, version: 2 });
    expect((await businessRequest()).statusCode).toBe(401);

    const stale = await app.inject({
      method: "PATCH",
      url: "/admin/v1/virtual-keys/frontend-team",
      headers: { authorization: `Bearer ${adminToken}`, "if-match": "1" },
      payload: { enabled: true },
    });
    expect(stale.statusCode).toBe(409);

    const enabled = await app.inject({
      method: "PATCH",
      url: "/admin/v1/virtual-keys/frontend-team",
      headers: { authorization: `Bearer ${adminToken}`, "if-match": "2" },
      payload: { enabled: true },
    });
    expect(enabled.json()).toMatchObject({ enabled: true, version: 3 });

    const rotated = await app.inject({
      method: "POST",
      url: "/admin/v1/virtual-keys/frontend-team/rotate",
      headers: { authorization: `Bearer ${adminToken}`, "if-match": "3" },
    });
    expect(rotated.json()).toMatchObject({ key: "aigw_rotated_secret", virtualKey: { version: 4 } });
    expect((await businessRequest()).statusCode).toBe(401);

    const newBusiness = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer aigw_rotated_secret" },
    });
    expect(newBusiness.statusCode).toBe(200);

    const audits = await app.inject({
      method: "GET",
      url: "/admin/v1/audit-events",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(audits.json().data).toHaveLength(4);
    expect(audits.json().data[0]).toMatchObject({
      actorIssuer: "local-static-token",
      actorRoles: ["admin"],
      authMethod: "static",
    });
    expect(audits.body).not.toContain("aigw_created_secret");
    expect(audits.body).not.toContain("aigw_rotated_secret");
    expect(audits.body).not.toContain("keyHash");
  });

  it("reports not ready when the control-plane dependency is unavailable", async () => {
    app = await buildApp({
      config: loadConfig({ METRICS_ENABLED: "false" }),
      readiness: async () => { throw new Error("database unavailable"); },
    });
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "not_ready", dependency: "postgres" });
  });

  it("enforces viewer, operator and admin permissions on every route", async () => {
    const repository = new InMemoryControlPlaneRepository();
    const service = new VirtualKeyControlPlaneService(repository, pepper, () => "aigw_rbac_secret");
    const authenticator: AdminAuthenticator = {
      authenticate: async (authorization) => {
        const role = authorization?.replace("Bearer ", "") as AdminRole;
        return {
          actorId: `oidc:${role}`,
          subject: `${role}-employee`,
          issuer: "https://identity.test",
          roles: [role],
          tenantScopes: ["*"],
          authMethod: "oidc",
        };
      },
    };
    app = await buildApp({
      config: loadConfig({ ADMIN_BEARER_TOKEN: adminToken, METRICS_ENABLED: "false" }),
      authService: new AuthService(repository, pepper),
      controlPlaneService: service,
      adminAuthorizationService: new AdminAuthorizationService(authenticator),
    });

    const create = (role: AdminRole) => app!.inject({
      method: "POST",
      url: "/admin/v1/virtual-keys",
      headers: { authorization: `Bearer ${role}` },
      payload: {
        keyId: "rbac-key",
        tenantId: "tenant-a",
        projectId: "project-a",
        applicationId: "app-a",
        allowedModels: ["general"],
      },
    });
    expect((await create("viewer")).statusCode).toBe(403);
    expect((await create("operator")).statusCode).toBe(201);

    const viewerList = await app.inject({
      method: "GET",
      url: "/admin/v1/virtual-keys",
      headers: { authorization: "Bearer viewer" },
    });
    expect(viewerList.statusCode).toBe(200);

    const currentIdentity = await app.inject({
      method: "GET",
      url: "/admin/v1/me",
      headers: { authorization: "Bearer viewer" },
    });
    expect(currentIdentity.statusCode).toBe(200);
    expect(currentIdentity.json()).toEqual({
      actorId: "oidc:viewer",
      roles: ["viewer"],
      tenantScopes: ["*"],
      authMethod: "oidc",
    });

    const operatorUpdate = await app.inject({
      method: "PATCH",
      url: "/admin/v1/virtual-keys/rbac-key",
      headers: { authorization: "Bearer operator", "if-match": "1" },
      payload: { enabled: false },
    });
    expect(operatorUpdate.statusCode).toBe(200);

    const operatorRotate = await app.inject({
      method: "POST",
      url: "/admin/v1/virtual-keys/rbac-key/rotate",
      headers: { authorization: "Bearer operator", "if-match": "2" },
    });
    expect(operatorRotate.statusCode).toBe(403);

    const adminRotate = await app.inject({
      method: "POST",
      url: "/admin/v1/virtual-keys/rbac-key/rotate",
      headers: { authorization: "Bearer admin", "if-match": "2" },
    });
    expect(adminRotate.statusCode).toBe(200);

    const audits = await app.inject({
      method: "GET",
      url: "/admin/v1/audit-events",
      headers: { authorization: "Bearer viewer" },
    });
    expect(audits.statusCode).toBe(200);
    expect(audits.json().data[0]).toMatchObject({
      actorSubject: "admin-employee",
      actorIssuer: "https://identity.test",
      actorRoles: ["admin"],
      authMethod: "oidc",
    });
  });
});
