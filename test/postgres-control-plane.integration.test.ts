import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { AuthService, hashVirtualKey } from "../src/auth/service.js";
import { runMigrations } from "../src/control-plane/migrations.js";
import { PostgresVirtualKeyRepository } from "../src/control-plane/postgres-repository.js";
import { VirtualKeyControlPlaneService } from "../src/control-plane/service.js";

const databaseUrl = process.env.POSTGRES_TEST_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("PostgreSQL virtual-key control plane", () => {
  const pepper = "postgres-integration-pepper";
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const repository = new PostgresVirtualKeyRepository(pool);
  let secretSequence = 0;
  const service = new VirtualKeyControlPlaneService(repository, pepper, () => `aigw_postgres_${++secretSequence}`);
  const auth = new AuthService(repository, pepper);
  const actor = {
    actorId: "oidc:test-user",
    subject: "test-user",
    issuer: "https://identity.test",
    roles: ["admin"],
    tenantScopes: ["tenant-db"],
    authMethod: "oidc" as const,
    requestId: "request-1",
    traceId: "a".repeat(32),
  };
  const approver = { ...actor, actorId: "oidc:approver", subject: "approver" };
  const secondApprover = { ...actor, actorId: "oidc:second-approver", subject: "second-approver" };

  beforeAll(async () => {
    await runMigrations(pool);
    await runMigrations(pool);
    await pool.query("TRUNCATE admin_notification_reads, admin_notifications, virtual_key_rotation_requests, audit_events, virtual_keys RESTART IDENTITY");
  });

  afterAll(async () => pool.end());

  it("persists mutations and audit together with immediately consistent authentication", async () => {
    const created = await service.create({
      keyId: "postgres-key",
      tenantId: "tenant-db",
      projectId: "project-db",
      applicationId: "app-db",
      allowedModels: ["general"],
    }, actor);
    expect(created.virtualKey).toMatchObject({ enabled: true, version: 1 });
    expect((await auth.authenticate("Bearer aigw_postgres_1")).keyId).toBe("postgres-key");

    const disabled = await service.update("postgres-key", 1, { enabled: false }, actor);
    expect(disabled.version).toBe(2);
    await expect(auth.authenticate("Bearer aigw_postgres_1")).rejects.toMatchObject({ statusCode: 401 });
    await expect(service.update("postgres-key", 1, { enabled: true }, actor)).rejects.toMatchObject({ statusCode: 409 });

    const enabled = await service.update("postgres-key", 2, { enabled: true, allowedModels: ["general", "external"] }, actor);
    expect(enabled).toMatchObject({ version: 3, allowedModels: ["general", "external"] });
    const rotated = await service.rotate("postgres-key", 3, actor);
    expect(rotated).toMatchObject({ key: "aigw_postgres_2", virtualKey: { version: 4 } });
    await expect(auth.authenticate("Bearer aigw_postgres_1")).rejects.toMatchObject({ statusCode: 401 });
    expect((await auth.authenticate("Bearer aigw_postgres_2")).keyId).toBe("postgres-key");

    const requested = await service.requestRotation("postgres-key", 4, actor);
    await expect(service.approveRotation(requested.requestId, "self approval", actor)).rejects.toMatchObject({ code: "approval_conflict" });
    const approved = await service.approveRotation(requested.requestId, "Verified change window", approver);
    expect(approved).toMatchObject({
      key: "aigw_postgres_4",
      virtualKey: { version: 5 },
      rotationRequest: { status: "approved", requestedBySubject: "test-user", approvedBySubject: "approver", decisionReason: "Verified change window" },
    });
    await expect(service.approveRotation(requested.requestId, "repeat", approver)).rejects.toMatchObject({ code: "approval_conflict" });
    expect(await service.list(10, ["other-tenant"])).toEqual([]);
    expect(await service.listAuditEvents(10, ["other-tenant"])).toEqual([]);

    const rejectedRequest = await service.requestRotation("postgres-key", 5, actor);
    await expect(service.rejectRotation(rejectedRequest.requestId, "not allowed", actor)).rejects.toMatchObject({ code: "approval_conflict" });
    const rejected = await service.rejectRotation(rejectedRequest.requestId, "Change ticket is incomplete", approver);
    expect(rejected).toMatchObject({ status: "rejected", decisionReason: "Change ticket is incomplete", decidedBySubject: "approver" });

    const cancelledRequest = await service.requestRotation("postgres-key", 5, actor);
    await expect(service.cancelRotation(cancelledRequest.requestId, "wrong actor", approver)).rejects.toMatchObject({ code: "approval_conflict" });
    const cancelled = await service.cancelRotation(cancelledRequest.requestId, "Deployment was postponed", actor);
    expect(cancelled).toMatchObject({ status: "cancelled", decisionReason: "Deployment was postponed" });

    const unread = await service.listNotifications(20, actor, true);
    expect(unread.some((item) => item.type === "rotation_rejected")).toBe(true);
    const broadcast = unread.find((item) => item.type === "rotation_requested")!;
    const read = await service.markNotificationRead(broadcast.notificationId, actor);
    expect(read.readAt).toBeTruthy();
    expect((await service.listNotifications(20, actor, true)).some((item) => item.notificationId === broadcast.notificationId)).toBe(false);
    expect((await service.listNotifications(20, approver, true)).some((item) => item.notificationId === broadcast.notificationId)).toBe(true);

    const expiringService = new VirtualKeyControlPlaneService(
      repository,
      pepper,
      () => "aigw_expired_unused",
      10,
    );
    const expiring = await expiringService.requestRotation("postgres-key", 5, actor);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(expiringService.approveRotation(expiring.requestId, "expired request", approver)).rejects.toMatchObject({ code: "approval_conflict" });
    expect((await service.findRotationRequestById(expiring.requestId))?.status).toBe("expired");

    const concurrent = await service.requestRotation("postgres-key", 5, actor);
    const approvals = await Promise.allSettled([
      repository.approveRotationRequest(concurrent.requestId, hashVirtualKey("aigw_concurrent_one", pepper), "first concurrent approval", approver),
      repository.approveRotationRequest(concurrent.requestId, hashVirtualKey("aigw_concurrent_two", pepper), "second concurrent approval", secondApprover),
    ]);
    expect(approvals.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(approvals.filter((result) => result.status === "rejected")).toHaveLength(1);

    const audits = await service.listAuditEvents(10);
    expect(audits.some((event) => event.action === "virtual_key.rotation_requested")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("aigw_postgres");
    expect(JSON.stringify(audits)).not.toContain("keyHash");
    expect(audits[0]).toMatchObject({
      actorIssuer: "https://identity.test",
      actorRoles: ["admin"],
      actorTenantScopes: ["tenant-db"],
      authMethod: "oidc",
    });
    const count = await pool.query<{ count: string }>("SELECT count(*) FROM gateway_schema_migrations");
    expect(count.rows[0]?.count).toBe("4");
  });
});
