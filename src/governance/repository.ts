import type { Pool } from "pg";
import { GatewayError } from "../core/errors.js";
import type { GovernanceActor, GovernanceKind, GovernanceRepository, GovernanceResource, GovernanceUsage } from "./types.js";

const conflict = (message: string) => new GatewayError({ message, statusCode: 409, code: "resource_conflict" });

export class InMemoryGovernanceRepository implements GovernanceRepository {
  private readonly resources = new Map<string, GovernanceResource>();
  private readonly usages = new Map<string, GovernanceUsage>();
  private key(kind: GovernanceKind, id: string) { return `${kind}:${id}`; }
  async list(kind: GovernanceKind, scopes?: readonly string[]) {
    return [...this.resources.values()].filter((item) => item.kind === kind && (!scopes || scopes.includes("*") || scopes.includes(item.tenantId)));
  }
  async find(kind: GovernanceKind, id: string) { return this.resources.get(this.key(kind, id)); }
  async create(resource: GovernanceResource) {
    const key = this.key(resource.kind, resource.id);
    if (this.resources.has(key)) throw conflict(`Resource '${resource.id}' already exists`);
    this.resources.set(key, structuredClone(resource));
    return structuredClone(resource);
  }
  async update(kind: GovernanceKind, id: string, version: number, patch: Partial<Pick<GovernanceResource, "enabled" | "spec">>) {
    const current = this.resources.get(this.key(kind, id));
    if (!current) throw new GatewayError({ message: `Resource '${id}' was not found`, statusCode: 404, code: "resource_not_found" });
    if (current.version !== version) throw conflict(`Resource '${id}' changed; refresh and retry`);
    const next = { ...current, ...patch, version: version + 1, updatedAt: new Date().toISOString() };
    this.resources.set(this.key(kind, id), next);
    return structuredClone(next);
  }
  async usage(tenantId: string, period: string, currency: string) {
    return this.usages.get(`${tenantId}:${period}:${currency}`) ?? { tenantId, period, currency, amount: 0, inputTokens: 0, outputTokens: 0 };
  }
  async addUsage(usage: GovernanceUsage) {
    const key = `${usage.tenantId}:${usage.period}:${usage.currency}`;
    const old = await this.usage(usage.tenantId, usage.period, usage.currency);
    this.usages.set(key, { ...usage, amount: old.amount + usage.amount, inputTokens: old.inputTokens + usage.inputTokens, outputTokens: old.outputTokens + usage.outputTokens });
  }
}

interface ResourceRow { kind: GovernanceKind; resource_id: string; tenant_id: string; enabled: boolean; version: number; spec: Record<string, unknown>; created_at: Date; updated_at: Date }
const view = (row: ResourceRow): GovernanceResource => ({ kind: row.kind, id: row.resource_id, tenantId: row.tenant_id, enabled: row.enabled, version: row.version, spec: row.spec, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });

export class PostgresGovernanceRepository implements GovernanceRepository {
  constructor(private readonly pool: Pool) {}
  async list(kind: GovernanceKind, scopes?: readonly string[]) {
    const all = !scopes || scopes.includes("*");
    const result = await this.pool.query<ResourceRow>(`SELECT * FROM governance_resources WHERE kind=$1 AND ($2::boolean OR tenant_id = ANY($3::text[])) ORDER BY updated_at DESC`, [kind, all, scopes ?? []]);
    return result.rows.map(view);
  }
  async find(kind: GovernanceKind, id: string) {
    const result = await this.pool.query<ResourceRow>("SELECT * FROM governance_resources WHERE kind=$1 AND resource_id=$2", [kind, id]);
    return result.rows[0] ? view(result.rows[0]) : undefined;
  }
  async create(resource: GovernanceResource, actor: GovernanceActor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ResourceRow>(`INSERT INTO governance_resources(kind,resource_id,tenant_id,enabled,version,spec) VALUES($1,$2,$3,$4,1,$5) RETURNING *`, [resource.kind, resource.id, resource.tenantId, resource.enabled, resource.spec]);
      await client.query(`INSERT INTO governance_audit_events(actor_id,action,kind,resource_id,tenant_id,after_state,request_id,trace_id) VALUES($1,'created',$2,$3,$4,$5,$6,$7)`, [actor.actorId, resource.kind, resource.id, resource.tenantId, resource, actor.requestId ?? null, actor.traceId ?? null]);
      await client.query("COMMIT");
      return view(result.rows[0]!);
    } catch (error) { await client.query("ROLLBACK"); if ((error as { code?: string }).code === "23505") throw conflict(`Resource '${resource.id}' already exists`); throw error; } finally { client.release(); }
  }
  async update(kind: GovernanceKind, id: string, version: number, patch: Partial<Pick<GovernanceResource, "enabled" | "spec">>, actor: GovernanceActor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const before = await client.query<ResourceRow>("SELECT * FROM governance_resources WHERE kind=$1 AND resource_id=$2 FOR UPDATE", [kind, id]);
      if (!before.rows[0]) throw new GatewayError({ message: `Resource '${id}' was not found`, statusCode: 404, code: "resource_not_found" });
      if (before.rows[0].version !== version) throw conflict(`Resource '${id}' changed; refresh and retry`);
      const result = await client.query<ResourceRow>(`UPDATE governance_resources SET enabled=COALESCE($4,enabled),spec=COALESCE($5,spec),version=version+1,updated_at=now() WHERE kind=$1 AND resource_id=$2 AND version=$3 RETURNING *`, [kind, id, version, patch.enabled ?? null, patch.spec ?? null]);
      await client.query(`INSERT INTO governance_audit_events(actor_id,action,kind,resource_id,tenant_id,before_state,after_state,request_id,trace_id) VALUES($1,'updated',$2,$3,$4,$5,$6,$7,$8)`, [actor.actorId, kind, id, result.rows[0]!.tenant_id, view(before.rows[0]), view(result.rows[0]!), actor.requestId ?? null, actor.traceId ?? null]);
      await client.query("COMMIT"); return view(result.rows[0]!);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async usage(tenantId: string, period: string, currency: string) {
    const result = await this.pool.query<GovernanceUsage & { amount: string; inputTokens: string; outputTokens: string }>(`SELECT tenant_id AS "tenantId",period,currency,amount::text,input_tokens::text AS "inputTokens",output_tokens::text AS "outputTokens" FROM governance_usage WHERE tenant_id=$1 AND period=$2 AND currency=$3`, [tenantId, period, currency]);
    const row = result.rows[0]; return row ? { ...row, amount: Number(row.amount), inputTokens: Number(row.inputTokens), outputTokens: Number(row.outputTokens) } : { tenantId, period, currency, amount: 0, inputTokens: 0, outputTokens: 0 };
  }
  async addUsage(usage: GovernanceUsage) {
    await this.pool.query(`INSERT INTO governance_usage(tenant_id,period,currency,amount,input_tokens,output_tokens) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,period,currency) DO UPDATE SET amount=governance_usage.amount+EXCLUDED.amount,input_tokens=governance_usage.input_tokens+EXCLUDED.input_tokens,output_tokens=governance_usage.output_tokens+EXCLUDED.output_tokens,updated_at=now()`, [usage.tenantId, usage.period, usage.currency, usage.amount, usage.inputTokens, usage.outputTokens]);
  }
}
