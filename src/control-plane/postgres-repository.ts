import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { VirtualKeyRecord, VirtualKeySeed } from "../auth/types.js";
import { hashVirtualKey } from "../auth/service.js";
import { approvalConflict, notFound, resourceConflict, versionConflict } from "./errors.js";
import type {
  ApprovedRotation,
  AdminNotification,
  AuditActor,
  AuditEvent,
  CreateVirtualKeyRecord,
  UpdateVirtualKeyRecord,
  RotationRequestView,
  RotationRequestStatus,
  VirtualKeyControlPlaneRepository,
  VirtualKeyView,
} from "./types.js";

interface VirtualKeyRow {
  key_id: string;
  key_hash: string;
  tenant_id: string;
  project_id: string;
  application_id: string;
  allowed_models: string[];
  enabled: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
  last_rotated_at: Date | null;
}

interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_id: string;
  actor_subject: string | null;
  actor_issuer: string | null;
  actor_roles: string[] | null;
  actor_tenant_scopes: string[] | null;
  auth_method: "static" | "oidc" | null;
  tenant_id: string | null;
  action: AuditEvent["action"];
  resource_type: "virtual_key";
  resource_id: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  request_id: string | null;
  trace_id: string | null;
}

interface RotationRequestRow {
  request_id: string;
  key_id: string;
  tenant_id: string;
  expected_key_version: number;
  status: RotationRequestStatus;
  requested_by_actor_id: string;
  requested_by_subject: string;
  requested_by_issuer: string;
  requested_at: Date;
  expires_at: Date;
  approved_by_actor_id: string | null;
  approved_by_subject: string | null;
  approved_at: Date | null;
  decided_by_actor_id: string | null;
  decided_by_subject: string | null;
  decision_reason: string | null;
  decided_at: Date | null;
}

interface NotificationRow {
  notification_id: string;
  tenant_id: string;
  type: AdminNotification["type"];
  resource_id: string;
  title: string;
  message: string;
  created_by_actor_id: string;
  target_actor_id: string | null;
  created_at: Date;
  read_at: Date | null;
}

const columns = `key_id, key_hash, tenant_id, project_id, application_id,
  allowed_models, enabled, version, created_at, updated_at, last_rotated_at`;

const toView = (row: VirtualKeyRow): VirtualKeyView => ({
  keyId: row.key_id,
  tenantId: row.tenant_id,
  projectId: row.project_id,
  applicationId: row.application_id,
  allowedModels: row.allowed_models,
  enabled: row.enabled,
  version: row.version,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  ...(row.last_rotated_at ? { lastRotatedAt: row.last_rotated_at.toISOString() } : {}),
});

const auditState = (view: VirtualKeyView): Record<string, unknown> => ({ ...view });

const rotationColumns = `request_id::text, key_id, tenant_id, expected_key_version, status,
  requested_by_actor_id, requested_by_subject, requested_by_issuer, requested_at, expires_at,
  approved_by_actor_id, approved_by_subject, approved_at, decided_by_actor_id,
  decided_by_subject, decision_reason, decided_at`;

const toRotationView = (row: RotationRequestRow): RotationRequestView => ({
  requestId: row.request_id,
  keyId: row.key_id,
  tenantId: row.tenant_id,
  expectedKeyVersion: row.expected_key_version,
  status: row.status,
  requestedByActorId: row.requested_by_actor_id,
  requestedBySubject: row.requested_by_subject,
  requestedByIssuer: row.requested_by_issuer,
  requestedAt: row.requested_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  ...(row.approved_by_actor_id ? { approvedByActorId: row.approved_by_actor_id } : {}),
  ...(row.approved_by_subject ? { approvedBySubject: row.approved_by_subject } : {}),
  ...(row.approved_at ? { approvedAt: row.approved_at.toISOString() } : {}),
  ...(row.decided_by_actor_id ? { decidedByActorId: row.decided_by_actor_id } : {}),
  ...(row.decided_by_subject ? { decidedBySubject: row.decided_by_subject } : {}),
  ...(row.decision_reason ? { decisionReason: row.decision_reason } : {}),
  ...(row.decided_at ? { decidedAt: row.decided_at.toISOString() } : {}),
});

const notificationColumns = `n.notification_id::text, n.tenant_id, n.type, n.resource_id,
  n.title, n.message, n.created_by_actor_id, n.target_actor_id, n.created_at, r.read_at`;

const toNotification = (row: NotificationRow): AdminNotification => ({
  notificationId: row.notification_id,
  tenantId: row.tenant_id,
  type: row.type,
  resourceId: row.resource_id,
  title: row.title,
  message: row.message,
  createdByActorId: row.created_by_actor_id,
  ...(row.target_actor_id ? { targetActorId: row.target_actor_id } : {}),
  createdAt: row.created_at.toISOString(),
  ...(row.read_at ? { readAt: row.read_at.toISOString() } : {}),
});

const isAllTenants = (tenantScopes: readonly string[] | undefined) =>
  tenantScopes === undefined || tenantScopes.includes("*");

const insertAudit = async (
  client: PoolClient,
  action: AuditEvent["action"],
  resourceId: string,
  tenantId: string,
  actor: AuditActor,
  beforeState: Record<string, unknown> | undefined,
  afterState: Record<string, unknown>,
) => {
  await client.query(
    `INSERT INTO audit_events
      (actor_id, action, resource_type, resource_id, before_state, after_state,
       request_id, trace_id, actor_subject, actor_issuer, actor_roles, auth_method,
       tenant_id, actor_tenant_scopes)
     VALUES ($1, $2, 'virtual_key', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      actor.actorId,
      action,
      resourceId,
      beforeState ?? null,
      afterState,
      actor.requestId ?? null,
      actor.traceId ?? null,
      actor.subject ?? null,
      actor.issuer ?? null,
      actor.roles ?? null,
      actor.authMethod ?? null,
      tenantId,
      actor.tenantScopes ?? null,
    ],
  );
};

const insertNotification = async (
  client: PoolClient,
  type: AdminNotification["type"],
  rotation: RotationRequestView,
  actor: AuditActor,
  targetActorId?: string,
) => {
  const statusLabels = { rotation_requested: "待审批", rotation_approved: "已批准", rotation_rejected: "已拒绝", rotation_cancelled: "已撤销" };
  await client.query(
    `INSERT INTO admin_notifications
      (notification_id, tenant_id, type, resource_id, title, message, created_by_actor_id, target_actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(), rotation.tenantId, type, rotation.requestId,
      `虚拟 Key ${rotation.keyId} 轮换${statusLabels[type]}`,
      rotation.decisionReason ?? `申请人：${rotation.requestedBySubject}`,
      actor.actorId, targetActorId ?? null,
    ],
  );
};

const inTransaction = async <T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export class PostgresVirtualKeyRepository implements VirtualKeyControlPlaneRepository {
  constructor(private readonly pool: Pool) {}

  async findByHash(keyHash: string): Promise<VirtualKeyRecord | undefined> {
    const result = await this.pool.query<VirtualKeyRow>(
      `SELECT ${columns} FROM virtual_keys WHERE key_hash = $1`,
      [keyHash],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      keyId: row.key_id,
      keyHash: row.key_hash,
      tenantId: row.tenant_id,
      projectId: row.project_id,
      applicationId: row.application_id,
      allowedModels: row.allowed_models,
      enabled: row.enabled,
    };
  }

  async findById(keyId: string): Promise<VirtualKeyView | undefined> {
    const result = await this.pool.query<VirtualKeyRow>(
      `SELECT ${columns} FROM virtual_keys WHERE key_id = $1`,
      [keyId],
    );
    return result.rows[0] ? toView(result.rows[0]) : undefined;
  }

  create(input: CreateVirtualKeyRecord, actor: AuditActor): Promise<VirtualKeyView> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<VirtualKeyRow>(
        `INSERT INTO virtual_keys
          (key_id, key_hash, tenant_id, project_id, application_id, allowed_models)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${columns}`,
        [input.keyId, input.keyHash, input.tenantId, input.projectId, input.applicationId, input.allowedModels],
      );
      const view = toView(result.rows[0]!);
      await insertAudit(client, "virtual_key.created", view.keyId, view.tenantId, actor, undefined, auditState(view));
      return view;
    }).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        throw resourceConflict();
      }
      throw error;
    });
  }

  async list(limit: number, tenantScopes?: readonly string[]): Promise<VirtualKeyView[]> {
    const allTenants = isAllTenants(tenantScopes);
    const result = await this.pool.query<VirtualKeyRow>(
      `SELECT ${columns} FROM virtual_keys
       ${allTenants ? "" : "WHERE tenant_id = ANY($1::text[])"}
       ORDER BY created_at DESC, key_id LIMIT $${allTenants ? 1 : 2}`,
      allTenants ? [limit] : [tenantScopes, limit],
    );
    return result.rows.map(toView);
  }

  update(keyId: string, expectedVersion: number, input: UpdateVirtualKeyRecord, actor: AuditActor): Promise<VirtualKeyView> {
    return inTransaction(this.pool, async (client) => {
      const beforeResult = await client.query<VirtualKeyRow>(
        `SELECT ${columns} FROM virtual_keys WHERE key_id = $1 FOR UPDATE`,
        [keyId],
      );
      const row = beforeResult.rows[0];
      if (!row) throw notFound(keyId);
      if (row.version !== expectedVersion) throw versionConflict();
      const before = toView(row);
      const result = await client.query<VirtualKeyRow>(
        `UPDATE virtual_keys SET
           enabled = COALESCE($2, enabled),
           allowed_models = COALESCE($3, allowed_models),
           version = version + 1,
           updated_at = now()
         WHERE key_id = $1 RETURNING ${columns}`,
        [keyId, input.enabled ?? null, input.allowedModels ?? null],
      );
      const after = toView(result.rows[0]!);
      await insertAudit(client, "virtual_key.updated", keyId, after.tenantId, actor, auditState(before), auditState(after));
      return after;
    });
  }

  rotate(keyId: string, expectedVersion: number, keyHash: string, actor: AuditActor): Promise<VirtualKeyView> {
    return inTransaction(this.pool, async (client) => {
      const beforeResult = await client.query<VirtualKeyRow>(
        `SELECT ${columns} FROM virtual_keys WHERE key_id = $1 FOR UPDATE`,
        [keyId],
      );
      const row = beforeResult.rows[0];
      if (!row) throw notFound(keyId);
      if (row.version !== expectedVersion) throw versionConflict();
      const before = toView(row);
      const result = await client.query<VirtualKeyRow>(
        `UPDATE virtual_keys SET key_hash = $2, version = version + 1,
           updated_at = now(), last_rotated_at = now()
         WHERE key_id = $1 RETURNING ${columns}`,
        [keyId, keyHash],
      );
      const after = toView(result.rows[0]!);
      await insertAudit(client, "virtual_key.rotated", keyId, after.tenantId, actor, auditState(before), auditState(after));
      return after;
    });
  }

  async listAuditEvents(limit: number, tenantScopes?: readonly string[]): Promise<AuditEvent[]> {
    const allTenants = isAllTenants(tenantScopes);
    const result = await this.pool.query<AuditRow>(
      `SELECT id::text, occurred_at, actor_id, action, resource_type, resource_id,
              before_state, after_state, request_id, trace_id,
              actor_subject, actor_issuer, actor_roles, auth_method, tenant_id, actor_tenant_scopes
       FROM audit_events
       ${allTenants ? "" : "WHERE tenant_id = ANY($1::text[])"}
       ORDER BY id DESC LIMIT $${allTenants ? 1 : 2}`,
      allTenants ? [limit] : [tenantScopes, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at.toISOString(),
      actorId: row.actor_id,
      ...(row.actor_subject ? { actorSubject: row.actor_subject } : {}),
      ...(row.actor_issuer ? { actorIssuer: row.actor_issuer } : {}),
      ...(row.actor_roles ? { actorRoles: row.actor_roles } : {}),
      ...(row.actor_tenant_scopes ? { actorTenantScopes: row.actor_tenant_scopes } : {}),
      ...(row.auth_method ? { authMethod: row.auth_method } : {}),
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      ...(row.before_state ? { beforeState: row.before_state } : {}),
      ...(row.after_state ? { afterState: row.after_state } : {}),
      ...(row.request_id ? { requestId: row.request_id } : {}),
      ...(row.trace_id ? { traceId: row.trace_id } : {}),
    }));
  }

  createRotationRequest(
    requestId: string,
    keyId: string,
    expectedKeyVersion: number,
    expiresAt: Date,
    actor: AuditActor,
  ): Promise<RotationRequestView> {
    return inTransaction(this.pool, async (client) => {
      const keyResult = await client.query<VirtualKeyRow>(
        `SELECT ${columns} FROM virtual_keys WHERE key_id = $1 FOR UPDATE`,
        [keyId],
      );
      const key = keyResult.rows[0];
      if (!key) throw notFound(keyId);
      if (key.version !== expectedKeyVersion) throw versionConflict();
      await client.query(
        "UPDATE virtual_key_rotation_requests SET status = 'expired' WHERE key_id = $1 AND status = 'pending' AND expires_at <= now()",
        [keyId],
      );
      let result;
      try {
        result = await client.query<RotationRequestRow>(
          `INSERT INTO virtual_key_rotation_requests
            (request_id, key_id, tenant_id, expected_key_version, requested_by_actor_id,
             requested_by_subject, requested_by_issuer, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${rotationColumns}`,
          [
            requestId,
            keyId,
            key.tenant_id,
            expectedKeyVersion,
            actor.actorId,
            actor.subject ?? actor.actorId,
            actor.issuer ?? "unknown",
            expiresAt,
          ],
        );
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
          throw approvalConflict(`A pending rotation request already exists for virtual key '${keyId}'`);
        }
        throw error;
      }
      const rotation = toRotationView(result.rows[0]!);
      await insertAudit(
        client,
        "virtual_key.rotation_requested",
        keyId,
        key.tenant_id,
        actor,
        undefined,
        { ...rotation },
      );
      await insertNotification(client, "rotation_requested", rotation, actor);
      return rotation;
    });
  }

  async findRotationRequestById(requestId: string): Promise<RotationRequestView | undefined> {
    await this.pool.query(
      "UPDATE virtual_key_rotation_requests SET status = 'expired' WHERE request_id = $1 AND status = 'pending' AND expires_at <= now()",
      [requestId],
    );
    const result = await this.pool.query<RotationRequestRow>(
      `SELECT ${rotationColumns} FROM virtual_key_rotation_requests WHERE request_id = $1`,
      [requestId],
    );
    return result.rows[0] ? toRotationView(result.rows[0]) : undefined;
  }

  async listRotationRequests(
    limit: number,
    tenantScopes?: readonly string[],
    status?: RotationRequestStatus,
  ): Promise<RotationRequestView[]> {
    await this.pool.query(
      "UPDATE virtual_key_rotation_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= now()",
    );
    const result = await this.pool.query<RotationRequestRow>(
      `SELECT ${rotationColumns} FROM virtual_key_rotation_requests
       WHERE ($1::text[] IS NULL OR tenant_id = ANY($1::text[]))
         AND ($2::text IS NULL OR status = $2)
       ORDER BY requested_at DESC LIMIT $3`,
      [isAllTenants(tenantScopes) ? null : tenantScopes, status ?? null, limit],
    );
    return result.rows.map(toRotationView);
  }

  approveRotationRequest(requestId: string, keyHash: string, reason: string, actor: AuditActor): Promise<ApprovedRotation> {
    return inTransaction(this.pool, async (client) => {
      const requestResult = await client.query<RotationRequestRow>(
        `SELECT ${rotationColumns} FROM virtual_key_rotation_requests WHERE request_id = $1 FOR UPDATE`,
        [requestId],
      );
      const request = requestResult.rows[0];
      if (!request) throw notFound(requestId);
      if (request.status !== "pending") throw approvalConflict(`Rotation request '${requestId}' is already ${request.status}`);
      const expired = await client.query(
        "UPDATE virtual_key_rotation_requests SET status = 'expired' WHERE request_id = $1 AND status = 'pending' AND expires_at <= now() RETURNING request_id",
        [requestId],
      );
      if (expired.rowCount === 1) {
        return { expired: true as const };
      }
      if (request.requested_by_actor_id === actor.actorId) {
        throw approvalConflict("The requester cannot approve their own rotation request");
      }
      const keyResult = await client.query<VirtualKeyRow>(
        `SELECT ${columns} FROM virtual_keys WHERE key_id = $1 FOR UPDATE`,
        [request.key_id],
      );
      const key = keyResult.rows[0];
      if (!key) throw notFound(request.key_id);
      if (key.version !== request.expected_key_version) {
        throw approvalConflict("The virtual key changed after the rotation request was created");
      }
      const before = toView(key);
      const updated = await client.query<VirtualKeyRow>(
        `UPDATE virtual_keys SET key_hash = $2, version = version + 1,
           updated_at = now(), last_rotated_at = now()
         WHERE key_id = $1 RETURNING ${columns}`,
        [key.key_id, keyHash],
      );
      const after = toView(updated.rows[0]!);
      const approved = await client.query<RotationRequestRow>(
        `UPDATE virtual_key_rotation_requests SET status = 'approved',
           approved_by_actor_id = $2, approved_by_subject = $3, approved_at = now(),
           decided_by_actor_id = $2, decided_by_subject = $3,
           decision_reason = $4, decided_at = now()
         WHERE request_id = $1 RETURNING ${rotationColumns}`,
        [requestId, actor.actorId, actor.subject ?? actor.actorId, reason],
      );
      const rotation = toRotationView(approved.rows[0]!);
      await insertAudit(client, "virtual_key.rotated", key.key_id, key.tenant_id, actor, auditState(before), { ...auditState(after), rotationRequest: rotation });
      await insertNotification(client, "rotation_approved", rotation, actor, rotation.requestedByActorId);
      return { expired: false as const, rotationRequest: rotation, virtualKey: after };
    }).then((result) => {
      if (result.expired) throw approvalConflict(`Rotation request '${requestId}' has expired`);
      return { rotationRequest: result.rotationRequest, virtualKey: result.virtualKey };
    });
  }

  decideRotationRequest(
    requestId: string,
    decision: "rejected" | "cancelled",
    reason: string,
    actor: AuditActor,
  ): Promise<RotationRequestView> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<RotationRequestRow>(
        `SELECT ${rotationColumns} FROM virtual_key_rotation_requests WHERE request_id = $1 FOR UPDATE`,
        [requestId],
      );
      const request = result.rows[0];
      if (!request) throw notFound(requestId);
      if (request.status !== "pending") throw approvalConflict(`Rotation request '${requestId}' is already ${request.status}`);
      const expired = await client.query(
        "UPDATE virtual_key_rotation_requests SET status = 'expired' WHERE request_id = $1 AND status = 'pending' AND expires_at <= now() RETURNING request_id",
        [requestId],
      );
      if (expired.rowCount === 1) return { expired: true as const };
      if (decision === "rejected" && request.requested_by_actor_id === actor.actorId) {
        throw approvalConflict("The requester must cancel rather than reject their own rotation request");
      }
      if (decision === "cancelled" && request.requested_by_actor_id !== actor.actorId) {
        throw approvalConflict("Only the requester can cancel a rotation request");
      }
      const updated = await client.query<RotationRequestRow>(
        `UPDATE virtual_key_rotation_requests SET status = $2,
           decided_by_actor_id = $3, decided_by_subject = $4,
           decision_reason = $5, decided_at = now()
         WHERE request_id = $1 RETURNING ${rotationColumns}`,
        [requestId, decision, actor.actorId, actor.subject ?? actor.actorId, reason],
      );
      const rotation = toRotationView(updated.rows[0]!);
      await insertAudit(
        client,
        decision === "rejected" ? "virtual_key.rotation_rejected" : "virtual_key.rotation_cancelled",
        rotation.keyId,
        rotation.tenantId,
        actor,
        undefined,
        { ...rotation },
      );
      await insertNotification(
        client,
        decision === "rejected" ? "rotation_rejected" : "rotation_cancelled",
        rotation,
        actor,
        rotation.requestedByActorId,
      );
      return { expired: false as const, rotation };
    }).then((result) => {
      if (result.expired) throw approvalConflict(`Rotation request '${requestId}' has expired`);
      return result.rotation;
    });
  }

  async listNotifications(
    limit: number,
    actorId: string,
    tenantScopes?: readonly string[],
    unreadOnly = false,
  ): Promise<AdminNotification[]> {
    const result = await this.pool.query<NotificationRow>(
      `SELECT ${notificationColumns}
       FROM admin_notifications n
       LEFT JOIN admin_notification_reads r ON r.notification_id = n.notification_id AND r.actor_id = $2
       WHERE ($1::text[] IS NULL OR n.tenant_id = ANY($1::text[]))
         AND (n.target_actor_id IS NULL OR n.target_actor_id = $2)
         AND ($3::boolean = false OR r.read_at IS NULL)
       ORDER BY n.created_at DESC LIMIT $4`,
      [isAllTenants(tenantScopes) ? null : tenantScopes, actorId, unreadOnly, limit],
    );
    return result.rows.map(toNotification);
  }

  markNotificationRead(notificationId: string, actor: AuditActor): Promise<AdminNotification> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<NotificationRow>(
        `SELECT ${notificationColumns}
         FROM admin_notifications n
         LEFT JOIN admin_notification_reads r ON r.notification_id = n.notification_id AND r.actor_id = $2
         WHERE n.notification_id = $1
           AND ($3::text[] IS NULL OR n.tenant_id = ANY($3::text[]))
           AND (n.target_actor_id IS NULL OR n.target_actor_id = $2)
         FOR UPDATE OF n`,
        [notificationId, actor.actorId, isAllTenants(actor.tenantScopes) ? null : actor.tenantScopes],
      );
      if (!result.rows[0]) throw notFound(notificationId);
      await client.query(
        `INSERT INTO admin_notification_reads (notification_id, actor_id)
         VALUES ($1, $2) ON CONFLICT (notification_id, actor_id)
         DO UPDATE SET read_at = EXCLUDED.read_at`,
        [notificationId, actor.actorId],
      );
      return { ...toNotification(result.rows[0]), readAt: new Date().toISOString() };
    });
  }
}

export const seedVirtualKeys = async (
  pool: Pool,
  seeds: VirtualKeySeed[],
  pepper: string,
): Promise<number> => {
  let inserted = 0;
  for (const seed of seeds) {
    const result = await pool.query(
      `INSERT INTO virtual_keys
        (key_id, key_hash, tenant_id, project_id, application_id, allowed_models)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [seed.keyId, hashVirtualKey(seed.rawKey, pepper), seed.tenantId, seed.projectId, seed.applicationId, seed.allowedModels],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
};
