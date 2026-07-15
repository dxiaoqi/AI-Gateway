export type AdminRole = "viewer" | "operator" | "admin";

export interface AdminIdentity {
  actorId: string;
  roles: AdminRole[];
  tenantScopes: string[];
  authMethod: "static" | "oidc";
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
  status: "pending" | "approved" | "expired";
  requestedByActorId: string;
  requestedBySubject: string;
  requestedByIssuer: string;
  requestedAt: string;
  expiresAt: string;
  approvedByActorId?: string;
  approvedBySubject?: string;
  approvedAt?: string;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorId: string;
  actorSubject?: string;
  actorIssuer?: string;
  actorRoles?: string[];
  actorTenantScopes?: string[];
  authMethod?: "static" | "oidc";
  action: string;
  resourceId: string;
  requestId?: string;
  traceId?: string;
}

export interface ListResponse<T> { data: T[] }

export interface ApiErrorPayload {
  error?: { message?: string; code?: string };
}
