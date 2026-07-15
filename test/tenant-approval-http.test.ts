import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AdminAuthorizationService } from "../src/admin-auth/service.js";
import type { AdminAuthenticator, AdminIdentity } from "../src/admin-auth/types.js";
import { AuthService } from "../src/auth/service.js";
import { loadConfig } from "../src/config.js";
import { InMemoryControlPlaneRepository } from "../src/control-plane/in-memory-repository.js";
import { VirtualKeyControlPlaneService } from "../src/control-plane/service.js";
import { buildApp } from "../src/server/app.js";

const identities: Record<string, AdminIdentity> = {
  alice: { actorId: "oidc:alice", subject: "alice", issuer: "https://identity.test", roles: ["admin"], tenantScopes: ["tenant-a"], authMethod: "oidc" },
  carol: { actorId: "oidc:carol", subject: "carol", issuer: "https://identity.test", roles: ["admin"], tenantScopes: ["tenant-a"], authMethod: "oidc" },
  bob: { actorId: "oidc:bob", subject: "bob", issuer: "https://identity.test", roles: ["admin"], tenantScopes: ["tenant-b"], authMethod: "oidc" },
  viewerA: { actorId: "oidc:viewer-a", subject: "viewer-a", issuer: "https://identity.test", roles: ["viewer"], tenantScopes: ["tenant-a"], authMethod: "oidc" },
  viewerB: { actorId: "oidc:viewer-b", subject: "viewer-b", issuer: "https://identity.test", roles: ["viewer"], tenantScopes: ["tenant-b"], authMethod: "oidc" },
};

describe("tenant-scoped authorization and two-person rotation approval", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());

  it("filters every read, blocks cross-tenant writes and requires a different approver", async () => {
    const repository = new InMemoryControlPlaneRepository();
    let secretSequence = 0;
    const service = new VirtualKeyControlPlaneService(
      repository,
      "tenant-test-pepper",
      () => `aigw_tenant_secret_${++secretSequence}`,
    );
    const authenticator: AdminAuthenticator = {
      authenticate: async (authorization) => identities[authorization?.slice(7) ?? ""]!,
    };
    app = await buildApp({
      config: loadConfig({
        ADMIN_BEARER_TOKEN: "local-test-admin-token",
        ROTATION_APPROVAL_REQUIRED: "true",
        METRICS_ENABLED: "false",
      }),
      authService: new AuthService(repository, "tenant-test-pepper"),
      controlPlaneService: service,
      adminAuthorizationService: new AdminAuthorizationService(authenticator),
    });

    const create = (actor: string, keyId: string, tenantId: string) => app!.inject({
      method: "POST",
      url: "/admin/v1/virtual-keys",
      headers: { authorization: `Bearer ${actor}` },
      payload: { keyId, tenantId, projectId: "project", applicationId: "app", allowedModels: ["general"] },
    });
    expect((await create("alice", "denied", "tenant-b")).statusCode).toBe(403);
    const tenantA = await create("alice", "key-a", "tenant-a");
    const originalKey = tenantA.json().key as string;
    expect(tenantA.statusCode).toBe(201);
    expect((await create("bob", "key-b", "tenant-b")).statusCode).toBe(201);

    const listA = await app.inject({ method: "GET", url: "/admin/v1/virtual-keys", headers: { authorization: "Bearer viewerA" } });
    expect(listA.json().data.map((key: { tenantId: string }) => key.tenantId)).toEqual(["tenant-a"]);
    const listB = await app.inject({ method: "GET", url: "/admin/v1/virtual-keys", headers: { authorization: "Bearer viewerB" } });
    expect(listB.json().data.map((key: { tenantId: string }) => key.tenantId)).toEqual(["tenant-b"]);

    const crossTenantUpdate = await app.inject({
      method: "PATCH",
      url: "/admin/v1/virtual-keys/key-b",
      headers: { authorization: "Bearer alice", "if-match": "1" },
      payload: { enabled: false },
    });
    expect(crossTenantUpdate.statusCode).toBe(403);

    const directRotation = await app.inject({
      method: "POST",
      url: "/admin/v1/virtual-keys/key-a/rotate",
      headers: { authorization: "Bearer alice", "if-match": "1" },
    });
    expect(directRotation.statusCode).toBe(409);
    expect(directRotation.json().error.code).toBe("approval_required");

    const requested = await app.inject({
      method: "POST",
      url: "/admin/v1/virtual-keys/key-a/rotation-requests",
      headers: { authorization: "Bearer alice", "if-match": "1" },
    });
    expect(requested.statusCode).toBe(201);
    const requestId = requested.json().rotationRequest.requestId as string;

    const rotationsB = await app.inject({ method: "GET", url: "/admin/v1/rotation-requests", headers: { authorization: "Bearer viewerB" } });
    expect(rotationsB.json().data).toEqual([]);
    const rotationsA = await app.inject({ method: "GET", url: "/admin/v1/rotation-requests", headers: { authorization: "Bearer viewerA" } });
    expect(rotationsA.json().data).toHaveLength(1);

    const selfApproval = await app.inject({
      method: "POST",
      url: `/admin/v1/rotation-requests/${requestId}/approve`,
      headers: { authorization: "Bearer alice" },
    });
    expect(selfApproval.statusCode).toBe(409);
    expect(selfApproval.json().error.code).toBe("approval_conflict");

    const crossTenantApproval = await app.inject({
      method: "POST",
      url: `/admin/v1/rotation-requests/${requestId}/approve`,
      headers: { authorization: "Bearer bob" },
    });
    expect(crossTenantApproval.statusCode).toBe(403);

    const approved = await app.inject({
      method: "POST",
      url: `/admin/v1/rotation-requests/${requestId}/approve`,
      headers: { authorization: "Bearer carol" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      rotationRequest: { status: "approved", requestedBySubject: "alice", approvedBySubject: "carol" },
      virtualKey: { keyId: "key-a", version: 2 },
    });
    const rotatedKey = approved.json().key as string;

    const repeated = await app.inject({
      method: "POST",
      url: `/admin/v1/rotation-requests/${requestId}/approve`,
      headers: { authorization: "Bearer carol" },
    });
    expect(repeated.statusCode).toBe(409);

    const models = (key: string) => app!.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${key}` } });
    expect((await models(originalKey)).statusCode).toBe(401);
    expect((await models(rotatedKey)).statusCode).toBe(200);

    const auditA = await app.inject({ method: "GET", url: "/admin/v1/audit-events", headers: { authorization: "Bearer viewerA" } });
    expect(auditA.json().data.every((event: { afterState: { tenantId: string } }) => event.afterState.tenantId === "tenant-a")).toBe(true);
    expect(auditA.json().data[0]).toMatchObject({ actorSubject: "carol", actorTenantScopes: ["tenant-a"] });
  });
});
