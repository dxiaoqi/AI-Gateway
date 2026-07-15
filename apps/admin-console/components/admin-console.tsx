"use client";

import { FormEvent, useMemo, useState } from "react";
import type {
  AdminIdentity,
  ApiErrorPayload,
  AuditEvent,
  ListResponse,
  RotationRequest,
  VirtualKey,
} from "@/lib/types";

type View = "overview" | "keys" | "approvals" | "audit";
type Notice = { message: string; error: boolean } | null;
type KeyForm = {
  mode: "create" | "edit";
  keyId: string;
  tenantId: string;
  projectId: string;
  applicationId: string;
  models: string;
  version?: number;
};

const emptyKeyForm: KeyForm = {
  mode: "create",
  keyId: "",
  tenantId: "",
  projectId: "",
  applicationId: "",
  models: "general",
};

const viewLabels: Record<View, [string, string]> = {
  overview: ["OVERVIEW", "运行总览"],
  keys: ["VIRTUAL KEYS", "虚拟 Key"],
  approvals: ["ROTATION APPROVALS", "轮换审批"],
  audit: ["AUDIT TRAIL", "审计记录"],
};

const actionLabels: Record<string, string> = {
  "virtual_key.created": "创建虚拟 Key",
  "virtual_key.updated": "更新虚拟 Key",
  "virtual_key.rotation_requested": "申请轮换",
  "virtual_key.rotated": "批准并完成轮换",
};

async function gatewayRequest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/gateway/admin/v1/${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json() as T & ApiErrorPayload;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `请求失败：HTTP ${response.status}`);
  }
  return payload;
}

function formatDate(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function short(value: string | undefined, length = 18) {
  if (!value) return "—";
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function BrandMark({ small = false }: { small?: boolean }) {
  return <div className={`brand-mark${small ? " small" : ""}`} aria-hidden="true"><span /><span /><span /></div>;
}

function StatusPill({ value }: { value: string }) {
  return <span className={`status-pill ${value.toLowerCase()}`}>{value.toUpperCase()}</span>;
}

export function AdminConsole() {
  const [token, setToken] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [identity, setIdentity] = useState<AdminIdentity | null>(null);
  const [keys, setKeys] = useState<VirtualKey[]>([]);
  const [approvals, setApprovals] = useState<RotationRequest[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [view, setView] = useState<View>("overview");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [keyForm, setKeyForm] = useState<KeyForm | null>(null);
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);

  const pending = useMemo(() => approvals.filter((item) => item.status === "pending"), [approvals]);
  const filteredKeys = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return keys;
    return keys.filter((item) => [item.keyId, item.tenantId, item.projectId, item.applicationId]
      .join(" ").toLowerCase().includes(query));
  }, [keys, search]);
  const canWrite = Boolean(identity?.roles.some((role) => role === "operator" || role === "admin"));
  const canApprove = Boolean(identity?.roles.includes("admin"));

  const alert = (message: string, error = false) => {
    setNotice({ message, error });
    window.setTimeout(() => setNotice(null), 3500);
  };

  const loadData = async (credential = token) => {
    const [me, keyList, requestList, eventList] = await Promise.all([
      gatewayRequest<AdminIdentity>(credential, "me"),
      gatewayRequest<ListResponse<VirtualKey>>(credential, "virtual-keys?limit=200"),
      gatewayRequest<ListResponse<RotationRequest>>(credential, "rotation-requests?limit=200"),
      gatewayRequest<ListResponse<AuditEvent>>(credential, "audit-events?limit=100"),
    ]);
    setIdentity(me);
    setKeys(keyList.data);
    setApprovals(requestList.data);
    setAudit(eventList.data);
  };

  const login = async (event: FormEvent) => {
    event.preventDefault();
    const credential = tokenInput.trim();
    if (!credential) return;
    setLoading(true);
    setTokenInput("");
    try {
      await loadData(credential);
      setToken(credential);
    } catch (error) {
      setToken("");
      setIdentity(null);
      alert(error instanceof Error ? error.message : "Token 验证失败", true);
    } finally {
      setLoading(false);
    }
  };

  const refresh = async (message?: string) => {
    setLoading(true);
    try {
      await loadData();
      if (message) alert(message);
    } catch (error) {
      alert(error instanceof Error ? error.message : "刷新失败", true);
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    setToken("");
    setIdentity(null);
    setKeys([]);
    setApprovals([]);
    setAudit([]);
    setView("overview");
    alert("Token 已从页面内存清除");
  };

  const toggleKey = async (item: VirtualKey) => {
    try {
      await gatewayRequest(token, `virtual-keys/${encodeURIComponent(item.keyId)}`, {
        method: "PATCH",
        headers: { "If-Match": String(item.version) },
        body: JSON.stringify({ enabled: !item.enabled }),
      });
      await refresh(item.enabled ? "Key 已禁用" : "Key 已启用");
    } catch (error) {
      alert(error instanceof Error ? error.message : "操作失败", true);
    }
  };

  const requestRotation = async (item: VirtualKey) => {
    try {
      await gatewayRequest(token, `virtual-keys/${encodeURIComponent(item.keyId)}/rotation-requests`, {
        method: "POST", headers: { "If-Match": String(item.version) },
      });
      await refresh("轮换申请已创建，等待另一位管理员批准");
      setView("approvals");
    } catch (error) {
      alert(error instanceof Error ? error.message : "申请失败", true);
    }
  };

  const approveRotation = async (item: RotationRequest) => {
    try {
      const result = await gatewayRequest<{ key: string }>(token, `rotation-requests/${encodeURIComponent(item.requestId)}/approve`, { method: "POST" });
      await refresh();
      setOneTimeSecret(result.key);
    } catch (error) {
      alert(error instanceof Error ? error.message : "批准失败", true);
    }
  };

  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!keyForm) return;
    const allowedModels = keyForm.models.split(",").map((item) => item.trim()).filter(Boolean);
    try {
      if (keyForm.mode === "create") {
        const result = await gatewayRequest<{ key: string }>(token, "virtual-keys", {
          method: "POST",
          body: JSON.stringify({
            keyId: keyForm.keyId.trim(), tenantId: keyForm.tenantId.trim(),
            projectId: keyForm.projectId.trim(), applicationId: keyForm.applicationId.trim(), allowedModels,
          }),
        });
        setKeyForm(null);
        await refresh();
        setOneTimeSecret(result.key);
      } else {
        await gatewayRequest(token, `virtual-keys/${encodeURIComponent(keyForm.keyId)}`, {
          method: "PATCH", headers: { "If-Match": String(keyForm.version) },
          body: JSON.stringify({ allowedModels }),
        });
        setKeyForm(null);
        await refresh("模型权限已更新");
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存失败", true);
    }
  };

  const editKey = (item: VirtualKey) => setKeyForm({
    mode: "edit", keyId: item.keyId, tenantId: item.tenantId, projectId: item.projectId,
    applicationId: item.applicationId, models: item.allowedModels.join(", "), version: item.version,
  });

  if (!identity) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <BrandMark />
          <p className="eyebrow">ENTERPRISE CONTROL PLANE</p>
          <h1>把模型访问变成<br /><em>可治理的能力</em></h1>
          <p className="login-copy">使用管理员 Access Token 进入控制台。Token 只保存在当前 React 页面内存，刷新或退出后立即消失。</p>
          <form className="login-form" onSubmit={login}>
            <label htmlFor="access-token">管理员 Access Token</label>
            <div className="token-field">
              <input id="access-token" type={showToken ? "text" : "password"} value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} autoComplete="off" spellCheck={false} placeholder="粘贴 OIDC 或本地开发 Token" required />
              <button type="button" className="icon-button" onClick={() => setShowToken((value) => !value)}>{showToken ? "隐藏" : "显示"}</button>
            </div>
            <button className="primary-button wide" disabled={loading} type="submit"><span>{loading ? "正在验证…" : "验证身份并进入"}</span><b>→</b></button>
          </form>
          <div className="security-note"><span>●</span> 同源 BFF · 默认拒绝 · 不写浏览器存储</div>
        </section>
        <aside className="login-aside">
          <div className="aside-top"><span>AI GATEWAY</span><span>v0.11</span></div>
          <div className="signal-card"><p>PLATFORM SIGNAL</p><strong>身份 × 范围 × 审批</strong><div className="signal-line"><i /><i /><i /><i /><i /></div></div>
          <p className="aside-quote">“网关不是另一个代理层，<br />而是企业 AI 的策略执行点。”</p>
        </aside>
        {notice && <div className={`toast visible${notice.error ? " error" : ""}`}>{notice.message}</div>}
      </main>
    );
  }

  return (
    <div className="console-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><BrandMark small /><div><strong>AI Gateway</strong><small>Control plane</small></div></div>
        <nav aria-label="管理后台导航">
          {(["overview", "keys", "approvals", "audit"] as View[]).map((item) => (
            <button key={item} className={`nav-item${view === item ? " active" : ""}`} onClick={() => setView(item)}>
              <span>{item === "overview" ? "◫" : item === "keys" ? "⌁" : item === "approvals" ? "✓" : "≡"}</span>
              {viewLabels[item][1]}{item === "approvals" && pending.length > 0 && <b className="badge">{pending.length}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot"><div className="status-row"><i /><span>Gateway connected</span></div><button className="text-button" onClick={logout}>退出并清除 Token</button></div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">AI GOVERNANCE / <span>{viewLabels[view][0]}</span></p><h2>{viewLabels[view][1]}</h2></div>
          <div className="identity-chip"><div>{identity.roles[0]?.charAt(0).toUpperCase() ?? "?"}</div><div><strong>{identity.roles.join(" / ") || "no role"}</strong><small>{identity.tenantScopes.join(", ") || "no tenant scope"}</small></div></div>
        </header>

        {view === "overview" && <section>
          <div className="hero-strip"><div><p className="eyebrow">CONTROL PLANE STATUS</p><h3>策略在线，边界清晰。</h3><p>所有管理动作继续由 Gateway 验证角色、租户范围和资源状态。</p></div><div className="pulse-orbit"><span /><b>READY</b></div></div>
          <div className="metric-grid">
            <article className="metric-card accent"><p>可见虚拟 Key</p><strong>{keys.length}</strong><small>当前 Tenant Scope</small></article>
            <article className="metric-card"><p>待审批轮换</p><strong>{pending.length}</strong><small>需要第二位管理员</small></article>
            <article className="metric-card"><p>已禁用 Key</p><strong>{keys.filter((item) => !item.enabled).length}</strong><small>调用立即失效</small></article>
            <article className="metric-card"><p>近期审计事件</p><strong>{audit.length}</strong><small>最近 100 条范围内</small></article>
          </div>
          <div className="split-grid">
            <article className="panel-card"><div className="panel-heading"><div><p className="eyebrow">ACTION CENTER</p><h3>需要你关注</h3></div><button className="quiet-button" onClick={() => setView("approvals")}>查看全部</button></div><div className="attention-list">
              {pending.length === 0 ? <div className="empty-state">当前没有待审批轮换。</div> : pending.slice(0, 4).map((item) => <div className="attention-item" key={item.requestId}><div><strong>{item.keyId}</strong><small>{item.tenantId} · version {item.expectedKeyVersion} · {formatDate(item.expiresAt)} 到期</small></div><StatusPill value="pending" /></div>)}
            </div></article>
            <article className="panel-card"><div className="panel-heading"><div><p className="eyebrow">ACCESS BOUNDARY</p><h3>当前身份</h3></div></div><dl className="identity-detail"><div><dt>角色</dt><dd>{identity.roles.join(", ")}</dd></div><div><dt>租户范围</dt><dd>{identity.tenantScopes.join(", ")}</dd></div><div><dt>认证方式</dt><dd>{identity.authMethod}</dd></div><div><dt>Actor ID</dt><dd>{identity.actorId}</dd></div></dl></article>
          </div>
        </section>}

        {view === "keys" && <section>
          <div className="section-actions"><p>创建、启停、调整模型权限，以及发起双人轮换。</p>{canWrite && <button className="primary-button" onClick={() => setKeyForm(emptyKeyForm)}><span>创建虚拟 Key</span><b>＋</b></button>}</div>
          <div className="table-card"><div className="table-toolbar"><label className="search-field"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} type="search" placeholder="搜索 Key、租户、项目或应用" /></label><span className="result-count">{filteredKeys.length} ITEMS</span></div><div className="table-scroll"><table><thead><tr><th>KEY / APPLICATION</th><th>TENANT / PROJECT</th><th>MODELS</th><th>STATUS</th><th>VERSION</th><th className="right">ACTIONS</th></tr></thead><tbody>
            {filteredKeys.length === 0 && <tr><td className="empty-state" colSpan={6}>没有符合条件的虚拟 Key。</td></tr>}
            {filteredKeys.map((item) => <tr key={item.keyId}><td><strong>{item.keyId}</strong><small>{item.applicationId}</small></td><td><strong>{item.tenantId}</strong><small>{item.projectId}</small></td><td>{item.allowedModels.map((model) => <span className="model-pill" key={model}>{model}</span>)}</td><td><StatusPill value={item.enabled ? "enabled" : "disabled"} /></td><td><strong>v{item.version}</strong><small>{formatDate(item.updatedAt)}</small></td><td className="right"><div className="action-group">{canWrite && <><button onClick={() => editKey(item)}>编辑模型</button><button className={item.enabled ? "danger" : ""} onClick={() => void toggleKey(item)}>{item.enabled ? "禁用" : "启用"}</button></>}{canApprove && <button onClick={() => void requestRotation(item)}>申请轮换</button>}{!canWrite && !canApprove && <span className="model-pill">只读</span>}</div></td></tr>)}
          </tbody></table></div></div>
        </section>}

        {view === "approvals" && <section>
          <div className="section-actions"><p>批准前核对租户、Key 版本、申请人和变更窗口。申请人不能批准自己的申请。</p><button className="quiet-button" onClick={() => void refresh("审批列表已刷新")}>刷新待办</button></div>
          <div className="table-card"><div className="table-scroll"><table><thead><tr><th>REQUEST</th><th>VIRTUAL KEY</th><th>TENANT</th><th>REQUESTER</th><th>EXPIRES</th><th>STATUS</th><th className="right">ACTION</th></tr></thead><tbody>
            {approvals.length === 0 && <tr><td className="empty-state" colSpan={7}>当前范围内没有轮换申请。</td></tr>}
            {approvals.map((item) => <tr key={item.requestId}><td><strong>{short(item.requestId, 12)}</strong><small>{formatDate(item.requestedAt)}</small></td><td><strong>{item.keyId}</strong><small>expected v{item.expectedKeyVersion}</small></td><td><strong>{item.tenantId}</strong></td><td><strong>{short(item.requestedBySubject, 20)}</strong><small>{short(item.requestedByIssuer, 26)}</small></td><td>{formatDate(item.expiresAt)}</td><td><StatusPill value={item.status} /></td><td className="right">{item.status === "pending" && canApprove ? <button className="table-action" onClick={() => void approveRotation(item)}>批准并轮换</button> : "—"}</td></tr>)}
          </tbody></table></div></div>
        </section>}

        {view === "audit" && <section>
          <div className="section-actions"><p>记录谁在什么范围、对哪个资源做了什么；不会展示 Key 明文或摘要。</p><button className="quiet-button" onClick={() => void refresh("审计记录已刷新")}>刷新记录</button></div>
          <div className="audit-card">{audit.length === 0 ? <div className="empty-state">当前范围内没有审计记录。</div> : audit.map((item) => <div className="audit-item" key={item.id}><div className="audit-icon">{item.action.includes("rotat") ? "↻" : item.action.includes("created") ? "+" : "∆"}</div><div><strong>{actionLabels[item.action] ?? item.action} · {item.resourceId}</strong><small>{item.actorSubject ?? item.actorId} · {(item.actorRoles ?? []).join(", ")}</small></div><div className="audit-meta">{formatDate(item.occurredAt)}</div></div>)}</div>
        </section>}
      </main>

      {keyForm && <div className="modal-backdrop" role="presentation"><form className="modal" onSubmit={saveKey}><div className="modal-head"><div><p className="eyebrow">VIRTUAL KEY</p><h3>{keyForm.mode === "create" ? "创建虚拟 Key" : "编辑模型权限"}</h3></div><button type="button" onClick={() => setKeyForm(null)}>×</button></div>
        <label>Key ID<input required disabled={keyForm.mode === "edit"} value={keyForm.keyId} onChange={(event) => setKeyForm({ ...keyForm, keyId: event.target.value })} placeholder="frontend-assistant-prod" /></label>
        <div className="form-grid"><label>Tenant ID<input required disabled={keyForm.mode === "edit"} value={keyForm.tenantId} onChange={(event) => setKeyForm({ ...keyForm, tenantId: event.target.value })} placeholder="business-a" /></label><label>Project ID<input required disabled={keyForm.mode === "edit"} value={keyForm.projectId} onChange={(event) => setKeyForm({ ...keyForm, projectId: event.target.value })} placeholder="assistant" /></label></div>
        <label>Application ID<input required disabled={keyForm.mode === "edit"} value={keyForm.applicationId} onChange={(event) => setKeyForm({ ...keyForm, applicationId: event.target.value })} placeholder="web-prod" /></label>
        <label>允许模型 <span>逗号分隔</span><input required value={keyForm.models} onChange={(event) => setKeyForm({ ...keyForm, models: event.target.value })} placeholder="general, external" /></label>
        <div className="modal-actions"><button type="button" className="quiet-button" onClick={() => setKeyForm(null)}>取消</button><button type="submit" className="primary-button">保存</button></div>
      </form></div>}

      {oneTimeSecret && <div className="modal-backdrop" role="presentation"><section className="modal secret-modal"><div className="modal-head"><div><p className="eyebrow">ONE-TIME SECRET</p><h3>立即保存新 Key</h3></div></div><p>关闭后控制台无法再次找回。请写入调用方 Secret Manager，不要放进聊天、工单或代码仓库。</p><div className="secret-box"><code>{oneTimeSecret}</code><button className="quiet-button" onClick={() => void navigator.clipboard.writeText(oneTimeSecret).then(() => alert("已复制，请立即保存到 Secret Manager")).catch(() => alert("复制失败，请手工选择 Key", true))}>复制</button></div><button className="primary-button wide" onClick={() => setOneTimeSecret(null)}>我已安全保存</button></section></div>}
      {notice && <div className={`toast visible${notice.error ? " error" : ""}`}>{notice.message}</div>}
      {loading && <div className="loading-line" />}
    </div>
  );
}
