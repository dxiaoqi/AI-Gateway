import type { VirtualKeyRecord } from "../auth/types.js";
import { randomUUID } from "node:crypto";
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

interface StoredKey extends VirtualKeyView {
  keyHash: string;
}

const view = ({ keyHash: _keyHash, ...record }: StoredKey): VirtualKeyView => structuredClone(record);

export class InMemoryControlPlaneRepository implements VirtualKeyControlPlaneRepository {
  private readonly byId = new Map<string, StoredKey>();
  private readonly audits: AuditEvent[] = [];
  private readonly rotations = new Map<string, RotationRequestView>();
  private readonly notifications = new Map<string, AdminNotification>();
  private readonly notificationReads = new Map<string, Map<string, string>>();
  private auditSequence = 0;

  async findByHash(keyHash: string): Promise<VirtualKeyRecord | undefined> {
    const record = [...this.byId.values()].find((item) => item.keyHash === keyHash);
    if (!record) return undefined;
    return {
      keyId: record.keyId,
      keyHash: record.keyHash,
      tenantId: record.tenantId,
      projectId: record.projectId,
      applicationId: record.applicationId,
      allowedModels: record.allowedModels,
      enabled: record.enabled,
    };
  }

  async findById(keyId: string): Promise<VirtualKeyView | undefined> {
    const record = this.byId.get(keyId);
    return record ? view(record) : undefined;
  }

  async create(input: CreateVirtualKeyRecord, actor: AuditActor): Promise<VirtualKeyView> {
    if (this.byId.has(input.keyId) || [...this.byId.values()].some((item) => item.keyHash === input.keyHash)) {
      throw resourceConflict();
    }
    const now = new Date().toISOString();
    const record: StoredKey = {
      ...input,
      allowedModels: [...input.allowedModels],
      enabled: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(record.keyId, record);
    this.audit("virtual_key.created", record.keyId, actor, undefined, { ...view(record) });
    return view(record);
  }

  async list(limit: number, tenantScopes?: readonly string[]): Promise<VirtualKeyView[]> {
    return [...this.byId.values()]
      .filter((record) => tenantScopes === undefined || tenantScopes.includes("*") || tenantScopes.includes(record.tenantId))
      .reverse().slice(0, limit).map(view);
  }

  async update(keyId: string, expectedVersion: number, input: UpdateVirtualKeyRecord, actor: AuditActor): Promise<VirtualKeyView> {
    const record = this.require(keyId, expectedVersion);
    const before = view(record);
    if (input.enabled !== undefined) record.enabled = input.enabled;
    if (input.allowedModels !== undefined) record.allowedModels = [...input.allowedModels];
    record.version += 1;
    record.updatedAt = new Date().toISOString();
    const after = view(record);
    this.audit("virtual_key.updated", keyId, actor, { ...before }, { ...after });
    return after;
  }

  async rotate(keyId: string, expectedVersion: number, keyHash: string, actor: AuditActor): Promise<VirtualKeyView> {
    const record = this.require(keyId, expectedVersion);
    const before = view(record);
    const now = new Date().toISOString();
    record.keyHash = keyHash;
    record.version += 1;
    record.updatedAt = now;
    record.lastRotatedAt = now;
    const after = view(record);
    this.audit("virtual_key.rotated", keyId, actor, { ...before }, { ...after });
    return after;
  }

  async listAuditEvents(limit: number, tenantScopes?: readonly string[]): Promise<AuditEvent[]> {
    return this.audits
      .filter((event) => tenantScopes === undefined || tenantScopes.includes("*") || tenantScopes.includes(String(event.afterState?.tenantId)))
      .slice(-limit).reverse().map((event) => structuredClone(event));
  }

  async createRotationRequest(
    requestId: string,
    keyId: string,
    expectedKeyVersion: number,
    expiresAt: Date,
    actor: AuditActor,
  ): Promise<RotationRequestView> {
    const key = this.require(keyId, expectedKeyVersion);
    for (const rotation of this.rotations.values()) {
      if (rotation.keyId === keyId && rotation.status === "pending") {
        if (new Date(rotation.expiresAt).getTime() <= Date.now()) rotation.status = "expired";
        else throw approvalConflict(`A pending rotation request already exists for virtual key '${keyId}'`);
      }
    }
    const rotation: RotationRequestView = {
      requestId,
      keyId,
      tenantId: key.tenantId,
      expectedKeyVersion,
      status: "pending",
      requestedByActorId: actor.actorId,
      requestedBySubject: actor.subject ?? actor.actorId,
      requestedByIssuer: actor.issuer ?? "unknown",
      requestedAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    this.rotations.set(requestId, rotation);
    this.audit("virtual_key.rotation_requested", keyId, actor, undefined, { ...rotation });
    this.notify("rotation_requested", rotation, actor);
    return structuredClone(rotation);
  }

  async findRotationRequestById(requestId: string): Promise<RotationRequestView | undefined> {
    const rotation = this.rotations.get(requestId);
    if (rotation?.status === "pending" && new Date(rotation.expiresAt).getTime() <= Date.now()) {
      rotation.status = "expired";
    }
    return rotation ? structuredClone(rotation) : undefined;
  }

  async listRotationRequests(
    limit: number,
    tenantScopes?: readonly string[],
    status?: RotationRequestStatus,
  ): Promise<RotationRequestView[]> {
    for (const rotation of this.rotations.values()) {
      if (rotation.status === "pending" && new Date(rotation.expiresAt).getTime() <= Date.now()) {
        rotation.status = "expired";
      }
    }
    return [...this.rotations.values()]
      .filter((rotation) => tenantScopes === undefined || tenantScopes.includes("*") || tenantScopes.includes(rotation.tenantId))
      .filter((rotation) => status === undefined || rotation.status === status)
      .reverse().slice(0, limit).map((rotation) => structuredClone(rotation));
  }

  async approveRotationRequest(requestId: string, keyHash: string, reason: string, actor: AuditActor): Promise<ApprovedRotation> {
    const rotation = this.rotations.get(requestId);
    if (!rotation) throw notFound(requestId);
    if (rotation.status !== "pending") throw approvalConflict(`Rotation request '${requestId}' is already ${rotation.status}`);
    if (new Date(rotation.expiresAt).getTime() <= Date.now()) {
      rotation.status = "expired";
      throw approvalConflict(`Rotation request '${requestId}' has expired`);
    }
    if (rotation.requestedByActorId === actor.actorId) {
      throw approvalConflict("The requester cannot approve their own rotation request");
    }
    const record = this.byId.get(rotation.keyId);
    if (!record) throw notFound(rotation.keyId);
    if (record.version !== rotation.expectedKeyVersion) {
      throw approvalConflict("The virtual key changed after the rotation request was created");
    }
    const before = view(record);
    const now = new Date().toISOString();
    record.keyHash = keyHash;
    record.version += 1;
    record.updatedAt = now;
    record.lastRotatedAt = now;
    rotation.status = "approved";
    rotation.approvedByActorId = actor.actorId;
    rotation.approvedBySubject = actor.subject ?? actor.actorId;
    rotation.approvedAt = now;
    rotation.decidedByActorId = actor.actorId;
    rotation.decidedBySubject = actor.subject ?? actor.actorId;
    rotation.decisionReason = reason;
    rotation.decidedAt = now;
    const after = view(record);
    this.audit("virtual_key.rotated", record.keyId, actor, { ...before }, { ...after, rotationRequest: structuredClone(rotation) });
    this.notify("rotation_approved", rotation, actor, rotation.requestedByActorId);
    return { rotationRequest: structuredClone(rotation), virtualKey: after };
  }

  async decideRotationRequest(
    requestId: string,
    decision: "rejected" | "cancelled",
    reason: string,
    actor: AuditActor,
  ): Promise<RotationRequestView> {
    const rotation = this.rotations.get(requestId);
    if (!rotation) throw notFound(requestId);
    if (rotation.status !== "pending") throw approvalConflict(`Rotation request '${requestId}' is already ${rotation.status}`);
    if (new Date(rotation.expiresAt).getTime() <= Date.now()) {
      rotation.status = "expired";
      throw approvalConflict(`Rotation request '${requestId}' has expired`);
    }
    if (decision === "rejected" && rotation.requestedByActorId === actor.actorId) {
      throw approvalConflict("The requester must cancel rather than reject their own rotation request");
    }
    if (decision === "cancelled" && rotation.requestedByActorId !== actor.actorId) {
      throw approvalConflict("Only the requester can cancel a rotation request");
    }
    rotation.status = decision;
    rotation.decidedByActorId = actor.actorId;
    rotation.decidedBySubject = actor.subject ?? actor.actorId;
    rotation.decisionReason = reason;
    rotation.decidedAt = new Date().toISOString();
    this.audit(
      decision === "rejected" ? "virtual_key.rotation_rejected" : "virtual_key.rotation_cancelled",
      rotation.keyId,
      actor,
      undefined,
      { ...structuredClone(rotation) },
    );
    this.notify(decision === "rejected" ? "rotation_rejected" : "rotation_cancelled", rotation, actor, rotation.requestedByActorId);
    return structuredClone(rotation);
  }

  async listNotifications(
    limit: number,
    actorId: string,
    tenantScopes?: readonly string[],
    unreadOnly = false,
  ): Promise<AdminNotification[]> {
    return [...this.notifications.values()]
      .filter((item) => tenantScopes === undefined || tenantScopes.includes("*") || tenantScopes.includes(item.tenantId))
      .filter((item) => !item.targetActorId || item.targetActorId === actorId)
      .filter((item) => !unreadOnly || !this.notificationReads.get(item.notificationId)?.has(actorId))
      .reverse().slice(0, limit).map((item) => {
        const readAt = this.notificationReads.get(item.notificationId)?.get(actorId);
        return { ...structuredClone(item), ...(readAt ? { readAt } : {}) };
      });
  }

  async markNotificationRead(notificationId: string, actor: AuditActor): Promise<AdminNotification> {
    const notification = this.notifications.get(notificationId);
    const hasTenant = actor.tenantScopes?.includes("*") || actor.tenantScopes?.includes(notification?.tenantId ?? "");
    if (!notification || !hasTenant || (notification.targetActorId && notification.targetActorId !== actor.actorId)) {
      throw notFound(notificationId);
    }
    const readAt = new Date().toISOString();
    const reads = this.notificationReads.get(notificationId) ?? new Map<string, string>();
    reads.set(actor.actorId, readAt);
    this.notificationReads.set(notificationId, reads);
    return { ...structuredClone(notification), readAt };
  }

  private require(keyId: string, expectedVersion: number): StoredKey {
    const record = this.byId.get(keyId);
    if (!record) throw notFound(keyId);
    if (record.version !== expectedVersion) throw versionConflict();
    return record;
  }

  private notify(
    type: AdminNotification["type"],
    rotation: RotationRequestView,
    actor: AuditActor,
    targetActorId?: string,
  ) {
    const statusLabels = { rotation_requested: "待审批", rotation_approved: "已批准", rotation_rejected: "已拒绝", rotation_cancelled: "已撤销" };
    const notification: AdminNotification = {
      notificationId: randomUUID(),
      tenantId: rotation.tenantId,
      type,
      resourceId: rotation.requestId,
      title: `虚拟 Key ${rotation.keyId} 轮换${statusLabels[type]}`,
      message: rotation.decisionReason ?? `申请人：${rotation.requestedBySubject}`,
      createdByActorId: actor.actorId,
      ...(targetActorId ? { targetActorId } : {}),
      createdAt: new Date().toISOString(),
    };
    this.notifications.set(notification.notificationId, notification);
  }

  private audit(
    action: AuditEvent["action"],
    resourceId: string,
    actor: AuditActor,
    beforeState: Record<string, unknown> | undefined,
    afterState: Record<string, unknown>,
  ) {
    this.auditSequence += 1;
    this.audits.push({
      id: String(this.auditSequence),
      occurredAt: new Date().toISOString(),
      actorId: actor.actorId,
      ...(actor.subject ? { actorSubject: actor.subject } : {}),
      ...(actor.issuer ? { actorIssuer: actor.issuer } : {}),
      ...(actor.roles ? { actorRoles: [...actor.roles] } : {}),
      ...(actor.tenantScopes ? { actorTenantScopes: [...actor.tenantScopes] } : {}),
      ...(actor.authMethod ? { authMethod: actor.authMethod } : {}),
      action,
      resourceType: "virtual_key",
      resourceId,
      ...(beforeState ? { beforeState: { ...structuredClone(beforeState) } } : {}),
      afterState: { ...structuredClone(afterState) },
      ...(actor.requestId ? { requestId: actor.requestId } : {}),
      ...(actor.traceId ? { traceId: actor.traceId } : {}),
    });
  }
}
