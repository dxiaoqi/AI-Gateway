"use client";

import { FormEvent, useState } from "react";
import type { ApiErrorPayload, GovernanceKind, GovernanceResource, ListResponse } from "@/lib/types";

type Field = { key: string; label: string; type?: "number" | "select" | "multi"; values?: string[]; placeholder?: string };
const definitions: Record<GovernanceKind, { title: string; help: string; tenant: boolean; fields: Field[] }> = {
  "model-deployments": { title: "模型部署", help: "把逻辑模型映射到真实供应商；启停后立即影响路由。API Key 只填写环境变量名。", tenant: false, fields: [
    { key: "logicalModel", label: "逻辑模型", placeholder: "general" }, { key: "provider", label: "供应商类型", type: "select", values: ["mock", "openai-compatible"] },
    { key: "providerModel", label: "供应商模型", placeholder: "gpt-4.1-mini" }, { key: "baseUrl", label: "Base URL", placeholder: "https://api.example.com/v1" },
    { key: "credentialEnv", label: "凭证环境变量", placeholder: "PROVIDER_API_KEY" }, { key: "priority", label: "优先级（越小越优先）", type: "number" }, { key: "weight", label: "同级权重", type: "number" },
  ] },
  "quota-policies": { title: "配额策略", help: "限制租户、项目、应用或 Key 的 RPM、TPM 与并发数。", tenant: true, fields: [
    { key: "scope", label: "范围", type: "select", values: ["tenant", "project", "application", "key"] }, { key: "scopeId", label: "范围 ID" },
    { key: "requestsPerMinute", label: "每分钟请求数", type: "number" }, { key: "tokensPerMinute", label: "每分钟 Token", type: "number" }, { key: "maxConcurrent", label: "最大并发", type: "number" },
  ] },
  "pricing-rules": { title: "模型定价", help: "按百万 Token 维护输入、输出单价；请求成功后自动记账。", tenant: true, fields: [
    { key: "logicalModel", label: "逻辑模型" }, { key: "currency", label: "币种", type: "select", values: ["CNY", "USD"] },
    { key: "inputPerMillion", label: "输入单价 / 百万 Token", type: "number" }, { key: "outputPerMillion", label: "输出单价 / 百万 Token", type: "number" },
  ] },
  budgets: { title: "月度预算", help: "预算耗尽后，网关在供应商调用前拒绝请求，防止继续产生费用。", tenant: true, fields: [
    { key: "period", label: "周期", type: "select", values: ["monthly"] }, { key: "currency", label: "币种", type: "select", values: ["CNY", "USD"] },
    { key: "limit", label: "月度上限", type: "number" }, { key: "alertPercent", label: "预警百分比", type: "number" },
  ] },
  "guardrail-policies": { title: "安全护栏", help: "在 Prompt 离开企业边界前检查 PII、提示词注入与危险内容。", tenant: true, fields: [
    { key: "mode", label: "模式", type: "select", values: ["audit", "block"] }, { key: "categories", label: "检查项", type: "multi", values: ["pii", "prompt-injection", "content-safety"] },
  ] },
};

async function call<T>(csrf: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`/api/gateway/admin/v1/${path}`, { ...init, cache: "no-store", headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.method && init.method !== "GET" ? { "X-CSRF-Token": csrf } : {}), ...init.headers } });
  const payload = await response.json() as T & ApiErrorPayload;
  if (!response.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  return payload;
}

export function GovernancePanel({ kind, resources, csrfToken, canWrite, reload, notify }: { kind: GovernanceKind; resources: GovernanceResource[]; csrfToken: string; canWrite: boolean; reload: () => Promise<void>; notify: (message: string, error?: boolean) => void }) {
  const definition = definitions[kind];
  const [editing, setEditing] = useState(false); const [id, setId] = useState(""); const [tenantId, setTenantId] = useState(definition.tenant ? "" : "*");
  const [values, setValues] = useState<Record<string, string>>({ provider: "mock", priority: "100", weight: "1", scope: "tenant", currency: "CNY", period: "monthly", alertPercent: "80", mode: "block", categories: "pii,prompt-injection" });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const spec: Record<string, unknown> = {};
    for (const field of definition.fields) { const raw = values[field.key]?.trim(); if (!raw) continue; spec[field.key] = field.type === "number" ? Number(raw) : field.type === "multi" ? raw.split(",").map((item) => item.trim()).filter(Boolean) : raw; }
    try { await call(csrfToken, kind, { method: "POST", body: JSON.stringify({ id, tenantId, spec }) }); setEditing(false); setId(""); await reload(); notify(`${definition.title}已创建`); } catch (error) { notify(error instanceof Error ? error.message : "保存失败", true); }
  };
  const toggle = async (item: GovernanceResource) => {
    try { await call(csrfToken, `${kind}/${encodeURIComponent(item.id)}`, { method: "PATCH", headers: { "If-Match": String(item.version) }, body: JSON.stringify({ enabled: !item.enabled }) }); await reload(); notify(item.enabled ? "策略已停用" : "策略已启用"); } catch (error) { notify(error instanceof Error ? error.message : "操作失败", true); }
  };
  return <section>
    <div className="section-actions"><div><h3 className="governance-title">{definition.title}</h3><p>{definition.help}</p></div>{canWrite && <button className="primary-button" onClick={() => setEditing(true)}>新增配置 ＋</button>}</div>
    <div className="table-card"><div className="table-scroll"><table><thead><tr><th>ID / TENANT</th><th>CONFIGURATION</th><th>STATUS</th><th>VERSION</th><th className="right">ACTION</th></tr></thead><tbody>
      {resources.length === 0 && <tr><td className="empty-state" colSpan={5}>还没有配置。点击“新增配置”创建第一条。</td></tr>}
      {resources.map((item) => <tr key={item.id}><td><strong>{item.id}</strong><small>{item.tenantId === "*" ? "全局" : item.tenantId}</small></td><td><div className="spec-summary">{Object.entries(item.spec).map(([key, value]) => <span key={key}><b>{key}</b> {Array.isArray(value) ? value.join(", ") : value}</span>)}</div></td><td><span className={`status-pill ${item.enabled ? "enabled" : "disabled"}`}>{item.enabled ? "ENABLED" : "DISABLED"}</span></td><td>v{item.version}</td><td className="right">{canWrite ? <button className="table-action" onClick={() => void toggle(item)}>{item.enabled ? "停用" : "启用"}</button> : "—"}</td></tr>)}
    </tbody></table></div></div>
    {editing && <div className="modal-backdrop"><form className="modal" onSubmit={save}><div className="modal-head"><div><p className="eyebrow">GOVERNANCE POLICY</p><h3>新增{definition.title}</h3></div><button type="button" onClick={() => setEditing(false)}>×</button></div>
      <div className="form-grid"><label>配置 ID<input required value={id} onChange={(e) => setId(e.target.value)} placeholder="使用稳定、可读的 ID" /></label><label>Tenant ID<input required disabled={!definition.tenant} value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="tenant-a" /></label></div>
      <div className="form-grid">{definition.fields.map((field) => <label key={field.key}>{field.label}{field.type === "select" ? <select className="form-select" value={values[field.key] ?? field.values?.[0]} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}>{field.values?.map((value) => <option value={value} key={value}>{value}</option>)}</select> : <input type={field.type === "number" ? "number" : "text"} step={field.type === "number" ? "any" : undefined} value={values[field.key] ?? ""} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })} placeholder={field.type === "multi" ? field.values?.join(",") : field.placeholder} />}</label>)}</div>
      <div className="modal-actions"><button type="button" className="quiet-button" onClick={() => setEditing(false)}>取消</button><button className="primary-button" type="submit">保存并发布</button></div>
    </form></div>}
  </section>;
}
