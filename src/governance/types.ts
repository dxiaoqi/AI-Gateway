import type { AuthContext } from "../auth/types.js";
import type { QuotaPolicy } from "../quota/types.js";

export type GovernanceKind = "model-deployment" | "quota-policy" | "pricing-rule" | "budget" | "guardrail-policy";

export interface GovernanceResource<T = Record<string, unknown>> {
  kind: GovernanceKind;
  id: string;
  tenantId: string;
  enabled: boolean;
  version: number;
  spec: T;
  createdAt: string;
  updatedAt: string;
}

export interface ModelDeploymentSpec {
  logicalModel: string;
  provider: "mock" | "openai-compatible";
  providerModel: string;
  baseUrl?: string;
  credentialEnv?: string;
  priority: number;
  weight: number;
}

export interface ManagedQuotaPolicySpec {
  scope: "tenant" | "project" | "application" | "key";
  scopeId: string;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  maxConcurrent?: number;
}

export interface PricingRuleSpec {
  logicalModel: string;
  currency: "CNY" | "USD";
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface BudgetSpec {
  period: "monthly";
  limit: number;
  alertPercent: number;
  currency: "CNY" | "USD";
}

export interface GuardrailPolicySpec {
  mode: "audit" | "block";
  categories: ("pii" | "prompt-injection" | "content-safety")[];
}

export interface GovernanceUsage {
  tenantId: string;
  period: string;
  currency: string;
  amount: number;
  inputTokens: number;
  outputTokens: number;
}

export interface GovernanceActor {
  actorId: string;
  requestId?: string;
  traceId?: string;
}

export interface GovernanceRepository {
  list(kind: GovernanceKind, tenantScopes?: readonly string[]): Promise<GovernanceResource[]>;
  find(kind: GovernanceKind, id: string): Promise<GovernanceResource | undefined>;
  create(resource: GovernanceResource, actor: GovernanceActor): Promise<GovernanceResource>;
  update(kind: GovernanceKind, id: string, version: number, patch: Partial<Pick<GovernanceResource, "enabled" | "spec">>, actor: GovernanceActor): Promise<GovernanceResource>;
  usage(tenantId: string, period: string, currency: string): Promise<GovernanceUsage>;
  addUsage(usage: GovernanceUsage): Promise<void>;
}

export interface GovernanceRequestContext {
  auth: AuthContext;
  model: string;
  text: string;
}

export const toQuotaPolicy = (resource: GovernanceResource<ManagedQuotaPolicySpec>): QuotaPolicy => ({
  id: resource.id,
  scope: resource.spec.scope,
  scopeId: resource.spec.scopeId,
  limits: {
    ...(resource.spec.requestsPerMinute ? { requestsPerMinute: resource.spec.requestsPerMinute } : {}),
    ...(resource.spec.tokensPerMinute ? { tokensPerMinute: resource.spec.tokensPerMinute } : {}),
    ...(resource.spec.maxConcurrent ? { maxConcurrent: resource.spec.maxConcurrent } : {}),
  },
});
