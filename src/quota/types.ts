import type { AuthContext } from "../auth/types.js";

export type QuotaScope = "tenant" | "project" | "application" | "key";

export interface QuotaLimits {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  maxConcurrent?: number;
}

export interface QuotaPolicy {
  id: string;
  scope: QuotaScope;
  scopeId: string;
  limits: QuotaLimits;
}

export interface QuotaReservationEntry {
  policyId: string;
  windowKey: string;
  activeKey: string;
}

export interface QuotaReservation {
  id: string;
  reservedTokens: number;
  entries: QuotaReservationEntry[];
}

export interface QuotaReserveInput {
  reservationId: string;
  policies: QuotaPolicy[];
  reservedTokens: number;
  nowMs: number;
  ttlMs: number;
}

export interface QuotaStore {
  reserve(input: QuotaReserveInput): Promise<QuotaReservation>;
  settle(reservation: QuotaReservation, actualTokens: number): Promise<void>;
}

export const getScopeId = (
  context: AuthContext,
  scope: QuotaScope,
): string => {
  if (scope === "tenant") return context.tenantId;
  if (scope === "project") return context.projectId;
  if (scope === "application") return context.applicationId;
  return context.keyId;
};
