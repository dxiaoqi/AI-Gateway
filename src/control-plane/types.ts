import type { VirtualKeyRecord } from "../auth/types.js";

export interface VirtualKeyView {
  keyId: string;
  tenantId: string;
  projectId: string;
  applicationId: string;
  allowedModels: readonly string[];
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastRotatedAt?: string;
}

export interface AuditActor {
  actorId: string;
  subject?: string;
  issuer?: string;
  roles?: readonly string[];
  tenantScopes?: readonly string[];
  authMethod?: "static" | "oidc";
  requestId?: string;
  traceId?: string;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorId: string;
  actorSubject?: string;
  actorIssuer?: string;
  actorRoles?: readonly string[];
  actorTenantScopes?: readonly string[];
  authMethod?: "static" | "oidc";
  action:
    | "virtual_key.created"
    | "virtual_key.updated"
    | "virtual_key.rotated"
    | "virtual_key.rotation_requested"
    | "virtual_key.rotation_rejected"
    | "virtual_key.rotation_cancelled";
  resourceType: "virtual_key";
  resourceId: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  requestId?: string;
  traceId?: string;
}

export type RotationRequestStatus = "pending" | "approved" | "rejected" | "cancelled" | "expired";

export interface RotationRequestView {
  requestId: string;
  keyId: string;
  tenantId: string;
  expectedKeyVersion: number;
  status: RotationRequestStatus;
  requestedByActorId: string;
  requestedBySubject: string;
  requestedByIssuer: string;
  requestedAt: string;
  expiresAt: string;
  approvedByActorId?: string;
  approvedBySubject?: string;
  approvedAt?: string;
  decidedByActorId?: string;
  decidedBySubject?: string;
  decisionReason?: string;
  decidedAt?: string;
}

export type AdminNotificationType =
  | "rotation_requested"
  | "rotation_approved"
  | "rotation_rejected"
  | "rotation_cancelled";

export interface AdminNotification {
  notificationId: string;
  tenantId: string;
  type: AdminNotificationType;
  resourceId: string;
  title: string;
  message: string;
  createdByActorId: string;
  targetActorId?: string;
  createdAt: string;
  readAt?: string;
}

export interface ApprovedRotation {
  rotationRequest: RotationRequestView;
  virtualKey: VirtualKeyView;
}

export interface CreateVirtualKeyRecord {
  keyId: string;
  keyHash: string;
  tenantId: string;
  projectId: string;
  applicationId: string;
  allowedModels: readonly string[];
}

export interface UpdateVirtualKeyRecord {
  enabled?: boolean;
  allowedModels?: readonly string[];
}

export interface VirtualKeyControlPlaneRepository {
  findByHash(keyHash: string): Promise<VirtualKeyRecord | undefined>;
  findById(keyId: string): Promise<VirtualKeyView | undefined>;
  create(input: CreateVirtualKeyRecord, actor: AuditActor): Promise<VirtualKeyView>;
  list(limit: number, tenantScopes?: readonly string[]): Promise<VirtualKeyView[]>;
  update(
    keyId: string,
    expectedVersion: number,
    input: UpdateVirtualKeyRecord,
    actor: AuditActor,
  ): Promise<VirtualKeyView>;
  rotate(
    keyId: string,
    expectedVersion: number,
    keyHash: string,
    actor: AuditActor,
  ): Promise<VirtualKeyView>;
  listAuditEvents(limit: number, tenantScopes?: readonly string[]): Promise<AuditEvent[]>;
  createRotationRequest(
    requestId: string,
    keyId: string,
    expectedKeyVersion: number,
    expiresAt: Date,
    actor: AuditActor,
  ): Promise<RotationRequestView>;
  findRotationRequestById(requestId: string): Promise<RotationRequestView | undefined>;
  listRotationRequests(
    limit: number,
    tenantScopes?: readonly string[],
    status?: RotationRequestStatus,
  ): Promise<RotationRequestView[]>;
  approveRotationRequest(
    requestId: string,
    keyHash: string,
    reason: string,
    actor: AuditActor,
  ): Promise<ApprovedRotation>;
  decideRotationRequest(
    requestId: string,
    decision: "rejected" | "cancelled",
    reason: string,
    actor: AuditActor,
  ): Promise<RotationRequestView>;
  listNotifications(
    limit: number,
    actorId: string,
    tenantScopes?: readonly string[],
    unreadOnly?: boolean,
  ): Promise<AdminNotification[]>;
  markNotificationRead(
    notificationId: string,
    actor: AuditActor,
  ): Promise<AdminNotification>;
}
