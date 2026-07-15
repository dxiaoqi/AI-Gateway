export type AdminRole = "viewer" | "operator" | "admin";

export interface AdminIdentity {
  actorId: string;
  roles: AdminRole[];
  tenantScopes: string[];
  authMethod: "static" | "oidc" | "local";
}

export interface VirtualKey {
  keyId: string;
  tenantId: string;
  projectId: string;
  applicationId: string;
  allowedModels: string[];
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastRotatedAt?: string;
}

export interface RotationRequest {
  requestId: string;
  keyId: string;
  tenantId: string;
  expectedKeyVersion: number;
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired";
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

export interface AdminNotification {
  notificationId: string;
  tenantId: string;
  type: "rotation_requested" | "rotation_approved" | "rotation_rejected" | "rotation_cancelled";
  resourceId: string;
  title: string;
  message: string;
  createdByActorId: string;
  targetActorId?: string;
  createdAt: string;
  readAt?: string;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorId: string;
  actorSubject?: string;
  actorIssuer?: string;
  actorRoles?: string[];
  actorTenantScopes?: string[];
  authMethod?: "static" | "oidc" | "local";
  action: string;
  resourceId: string;
  requestId?: string;
  traceId?: string;
}

export interface ListResponse<T> { data: T[] }

export interface ApiErrorPayload {
  error?: { message?: string; code?: string };
}

export type GovernanceKind = "model-deployments" | "quota-policies" | "pricing-rules" | "budgets" | "guardrail-policies";
export interface GovernanceResource {
  kind: string; id: string; tenantId: string; enabled: boolean; version: number;
  spec: Record<string, string | number | string[]>; createdAt: string; updatedAt: string;
}
