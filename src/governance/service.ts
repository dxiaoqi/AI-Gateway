import { randomUUID } from "node:crypto";
import { GatewayError } from "../core/errors.js";
import type { AuthContext } from "../auth/types.js";
import type { QuotaPolicy } from "../quota/types.js";
import type {
  BudgetSpec, GovernanceActor, GovernanceKind, GovernanceRepository, GovernanceResource,
  GuardrailPolicySpec, ManagedQuotaPolicySpec, PricingRuleSpec,
} from "./types.js";
import { toQuotaPolicy } from "./types.js";
import type { ModelDeploymentSpec } from "./types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { MockProvider } from "../providers/mock-provider.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible/provider.js";

const invalid = (message: string) => { throw new GatewayError({ message, statusCode: 400, code: "invalid_request_error" }); };
const positive = (value: unknown, field: string, optional = false) => {
  if (optional && value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) invalid(`${field} must be a positive number`);
};
const text = (value: unknown, field: string) => {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 500) invalid(`${field} must be a non-empty string`);
};

export class GovernanceService {
  constructor(private readonly repository: GovernanceRepository, private readonly now: () => Date = () => new Date(), private readonly registry?: ProviderRegistry) {}

  async initialize(): Promise<void> {
    if (!this.registry) return;
    const deployments = await this.repository.list("model-deployment");
    for (const deployment of deployments) this.applyDeployment(deployment as unknown as GovernanceResource<ModelDeploymentSpec>);
  }

  list(kind: GovernanceKind, scopes?: readonly string[]) { return this.repository.list(kind, scopes); }
  find(kind: GovernanceKind, id: string) { return this.repository.find(kind, id); }

  async create(kind: GovernanceKind, input: { id?: string; tenantId: string; enabled?: boolean; spec: Record<string, unknown> }, actor: GovernanceActor) {
    text(input.tenantId, "tenantId"); this.validate(kind, input.spec);
    const timestamp = this.now().toISOString();
    if (kind === "model-deployment" && input.tenantId !== "*") invalid("model deployments must use the global tenantId '*'");
    const result = await this.repository.create({ kind, id: input.id?.trim() || `${kind}_${randomUUID()}`, tenantId: input.tenantId, enabled: input.enabled ?? true, version: 1, spec: input.spec, createdAt: timestamp, updatedAt: timestamp }, actor);
    if (kind === "model-deployment") this.applyDeployment(result as unknown as GovernanceResource<ModelDeploymentSpec>);
    return result;
  }

  async update(kind: GovernanceKind, id: string, version: number, patch: { enabled?: boolean; spec?: Record<string, unknown> }, actor: GovernanceActor) {
    if (patch.spec) this.validate(kind, patch.spec);
    const result = await this.repository.update(kind, id, version, patch, actor);
    if (kind === "model-deployment") this.applyDeployment(result as unknown as GovernanceResource<ModelDeploymentSpec>);
    return result;
  }

  private applyDeployment(resource: GovernanceResource<ModelDeploymentSpec>) {
    if (!this.registry) return;
    this.registry.remove(resource.id);
    if (!resource.enabled) return;
    const spec = resource.spec;
    const provider = spec.provider === "mock"
      ? new MockProvider()
      : new OpenAICompatibleProvider({ id: resource.id, baseUrl: spec.baseUrl!, apiKey: process.env[spec.credentialEnv!] ?? "", providerModel: spec.providerModel });
    this.registry.upsert(spec.logicalModel, provider, { id: resource.id, priority: spec.priority, weight: spec.weight });
  }

  private validate(kind: GovernanceKind, spec: Record<string, unknown>) {
    if (kind === "model-deployment") {
      text(spec.logicalModel, "logicalModel"); text(spec.providerModel, "providerModel");
      if (spec.provider !== "mock" && spec.provider !== "openai-compatible") invalid("provider must be mock or openai-compatible");
      if (spec.provider === "openai-compatible") {
        text(spec.baseUrl, "baseUrl"); text(spec.credentialEnv, "credentialEnv");
        let url: URL; try { url = new URL(String(spec.baseUrl)); } catch { return invalid("baseUrl must be a valid URL"); }
        if (url.protocol !== "https:" && url.protocol !== "http:") invalid("baseUrl must use http or https");
        if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(String(spec.credentialEnv))) invalid("credentialEnv must be an uppercase environment-variable name");
        if (!process.env[String(spec.credentialEnv)]) invalid(`credential environment variable '${String(spec.credentialEnv)}' is not configured`);
      }
      positive(spec.priority, "priority"); positive(spec.weight, "weight"); return;
    }
    if (kind === "quota-policy") {
      if (!["tenant", "project", "application", "key"].includes(String(spec.scope))) invalid("quota scope is invalid");
      text(spec.scopeId, "scopeId");
      positive(spec.requestsPerMinute, "requestsPerMinute", true); positive(spec.tokensPerMinute, "tokensPerMinute", true); positive(spec.maxConcurrent, "maxConcurrent", true);
      if (spec.requestsPerMinute === undefined && spec.tokensPerMinute === undefined && spec.maxConcurrent === undefined) invalid("at least one quota limit is required"); return;
    }
    if (kind === "pricing-rule") {
      text(spec.logicalModel, "logicalModel"); if (spec.currency !== "CNY" && spec.currency !== "USD") invalid("currency must be CNY or USD");
      positive(spec.inputPerMillion, "inputPerMillion"); positive(spec.outputPerMillion, "outputPerMillion"); return;
    }
    if (kind === "budget") {
      if (spec.period !== "monthly") invalid("only monthly budgets are currently supported");
      if (spec.currency !== "CNY" && spec.currency !== "USD") invalid("currency must be CNY or USD");
      positive(spec.limit, "limit"); positive(spec.alertPercent, "alertPercent");
      if ((spec.alertPercent as number) > 100) invalid("alertPercent cannot exceed 100"); return;
    }
    if (kind === "guardrail-policy") {
      if (spec.mode !== "audit" && spec.mode !== "block") invalid("mode must be audit or block");
      const allowed = ["pii", "prompt-injection", "content-safety"];
      if (!Array.isArray(spec.categories) || spec.categories.length === 0 || !spec.categories.every((item) => allowed.includes(String(item)))) invalid("guardrail categories are invalid");
    }
  }

  async quotaPolicies(context: AuthContext): Promise<QuotaPolicy[]> {
    const resources = await this.repository.list("quota-policy", [context.tenantId]);
    return (resources as unknown as GovernanceResource<ManagedQuotaPolicySpec>[]).filter((item) => item.enabled).map(toQuotaPolicy);
  }

  async inspect(context: AuthContext, content: string): Promise<void> {
    const resources = await this.repository.list("guardrail-policy", [context.tenantId]);
    const policies = (resources as unknown as GovernanceResource<GuardrailPolicySpec>[]).filter((item) => item.enabled);
    for (const policy of policies) {
      const matched = this.detect(content, policy.spec.categories);
      if (matched.length && policy.spec.mode === "block") {
        throw new GatewayError({ message: `Request blocked by guardrail policy '${policy.id}' (${matched.join(", ")})`, statusCode: 400, code: "content_policy_violation" });
      }
    }
  }

  private detect(content: string, categories: GuardrailPolicySpec["categories"]) {
    const hits: string[] = [];
    if (categories.includes("pii") && (/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u.test(content) || /\b(?:\d[ -]*?){13,19}\b/u.test(content))) hits.push("pii");
    if (categories.includes("prompt-injection") && /(ignore|disregard).{0,30}(previous|system|instructions)|忽略.{0,20}(之前|系统|指令)/iu.test(content)) hits.push("prompt-injection");
    if (categories.includes("content-safety") && /(制造|制作).{0,12}(炸弹|爆炸物)|build.{0,12}bomb/iu.test(content)) hits.push("content-safety");
    return hits;
  }

  private period() { return this.now().toISOString().slice(0, 7); }
  async assertBudget(context: AuthContext) {
    const budgets = (await this.repository.list("budget", [context.tenantId]) as unknown as GovernanceResource<BudgetSpec>[]).filter((item) => item.enabled);
    for (const budget of budgets) {
      const usage = await this.repository.usage(context.tenantId, this.period(), budget.spec.currency);
      if (usage.amount >= budget.spec.limit) throw new GatewayError({ message: `Monthly ${budget.spec.currency} budget has been exhausted`, statusCode: 429, code: "budget_exceeded", retryable: false });
    }
  }
  async recordUsage(context: AuthContext, model: string, inputTokens: number, outputTokens: number) {
    const rules = (await this.repository.list("pricing-rule", [context.tenantId]) as unknown as GovernanceResource<PricingRuleSpec>[]).filter((item) => item.enabled && item.spec.logicalModel === model);
    for (const rule of rules) {
      const amount = (inputTokens * rule.spec.inputPerMillion + outputTokens * rule.spec.outputPerMillion) / 1_000_000;
      await this.repository.addUsage({ tenantId: context.tenantId, period: this.period(), currency: rule.spec.currency, amount, inputTokens, outputTokens });
    }
  }
  usage(tenantId: string, currency: string) { return this.repository.usage(tenantId, this.period(), currency); }
}
