# Iteration 9：管理员 OIDC 身份与 RBAC

- 版本：0.9.0
- 日期：2026-07-15
- 状态：Completed
- 关联 ADR：[ADR 0009](../adr/0009-oidc-admin-identity-and-rbac.md)
- 运维手册：[管理员 OIDC 与 RBAC](../runbooks/admin-oidc-rbac.md)

## 0. 一句话说明

管理操作现在能验证具体企业身份，并按只读、运营、管理员实施最小权限。

## 1. 30 秒领导摘要

| 领导关心的问题 | 回答 |
|---|---|
| 以前的问题 | 所有管理员共享一个 Token，无法证明是谁操作，也无法限制只读人员或普通运营执行高风险轮换。 |
| 本轮交付 | OIDC JWT 验签、远程 JWKS 缓存、标准 Claim 校验、可配置角色映射、3 角色 RBAC、个人身份审计、生产静态 Token 安全门。 |
| 业务价值 | 员工生命周期回到企业 IdP；权限遵循最小化；审计能关联真实 subject；高风险轮换只给 admin。 |
| 验证证据 | 75 项默认测试；错误 issuer/audience/过期/算法测试；真实 HTTP JWKS 拉取与三角色冒烟；真实 PostgreSQL actor migration。 |
| 最大剩余风险 | JWT 在过期前是权限快照，移组不能立即撤回已签发 Token；没有管理 UI 和审批流。 |

### 最短演示

```bash
npm run smoke:oidc
npm run verify
```

OIDC Smoke 应显示 `remote JWKS -> JWT claims -> viewer/operator/admin RBAC -> actor audit`，不连接外部 IdP，也不产生模型费用。

## 2. 新人工程师导读

### 阅读前需要知道什么

- 身份认证回答“你是谁”，权限校验回答“你能做什么”，两者不能合并。
- JWT 是 IdP 签名的 JSON 声明；能解码不等于可信，必须验证签名和 Claims。
- JWKS 是 IdP 发布的公钥集合；公钥只能验证，不能伪造签名。
- RBAC（基于角色的访问控制）把多个 permission 聚合成岗位角色。

### 本轮术语与前端类比

| 术语 | 小白解释 | 前端类比 |
|---|---|---|
| IdP | 企业登录和人员身份的权威系统 | 公司统一登录，而不是每个 SPA 自建账号表 |
| issuer | 谁签发 Token | API Response 的可信域名，但它还必须参与密码学校验 |
| audience | Token 是签给哪个 API 的 | 一个站点的 CSRF Token 不能拿去另一个站点使用 |
| JWKS | 可轮换的签名公钥列表 | 浏览器信任 CA 公钥的思路；这里由应用主动拉取 IdP Key |
| `kid` | Token 指明使用哪把公钥 | 静态资源 hash 指向具体版本，但用于密码学 Key 选择 |
| Claim | Token 里的声明，例如 sub、groups | 登录后前端拿到的 user profile 字段；区别是后端必须先验签 |
| RBAC | 角色映射权限 | 前端路由 meta.roles，但这里服务端直接拒绝 HTTP 请求 |
| 401 | 身份无法验证 | 登录态无效，需要重新获取 Token |
| 403 | 身份有效但越权 | 已登录，但菜单和 API 都不属于这个岗位 |

### 一次 operator 创建 Key 的完整流程

1. 企业 IdP 为员工签发 Access Token，包含 `iss/sub/aud/exp/groups`，Header 包含 `alg/kid/typ`。
2. 员工调用管理 API，Bearer Token 进入路由 preHandler。
3. 网关先限制 Token 格式和 16 KiB 大小，再读取 `kid`。
4. jose 从配置的 JWKS URL 获取公钥；后续请求复用缓存。JWKS 地址不来自 Token，避免被攻击者指向任意内网。
5. 验证数字签名，同时固定检查 issuer、audience、expiration、subject、typ 和允许算法。任一失败返回相同 401。
6. 从 `groups` 或配置的点路径取外部角色，例如 `ai-gateway-operators`。
7. Role Map 把它转换为内部 operator；未映射组被忽略。
8. 路由声明创建需要 `virtual_keys:create`。operator 拥有该 permission，继续执行；viewer 会在此返回 403。
9. 控制面创建 Key，并在同一 PostgreSQL 事务写入 `actorSubject`、issuer、roles、authMethod、request/trace id。
10. 响应日志只写哈希化 `adminActorId` 与内部 roles，不把 JWT 或原始 subject 写入普通请求日志。

## 3. 背景与问题

静态管理员 Token 把“知道秘密”等价为“拥有全部权限”。多人共享后无法可靠离职回收、无法区分审计责任，也违背最小权限。Iteration 8 已把 Key 生命周期持久化，本轮必须先补身份治理，管理 UI 才不会只是给不安全接口套一层页面。

## 4. 本轮目标

- 使用企业 IdP 非对称 JWT 验证管理员身份。
- 拒绝错误签名、issuer、audience、过期、错误 typ 和非白名单算法。
- 支持嵌套 Role Claim 和显式外部组映射。
- 服务端强制 viewer/operator/admin 权限矩阵。
- 审计能回答具体 issuer、subject、role 和认证方式。
- JWKS 缓存并支持标准 `kid` Key rotation。
- 本地静态模式兼容，生产默认拒绝静态模式。

## 5. 非目标

- 登录页、Authorization Code + PKCE、Cookie Session。
- 自建用户密码、MFA 和账号恢复。
- IdP 管理或特定厂商 SDK（Entra/Okta/Keycloak）。
- Token introspection、即时会话撤销和 denylist。
- ABAC、按租户授权、资源所有权和审批流。
- 管理后台 UI。
- 浏览审计事件本身的二次审计与 SIEM 导出。

## 6. 详细设计

### 信任链

```text
IdP 私钥签名 JWT
       ↓
Bearer JWT ─→ 格式/大小 ─→ 远程 JWKS 公钥 ─→ 签名 + iss/aud/exp/sub/typ/alg
                                                        ↓
外部 groups/roles ─→ 显式 Role Map ─→ 内部 Role ─→ Permission ─→ 路由
                                                        ↓
                                                  PostgreSQL Audit
```

### 权限矩阵

| Permission | viewer | operator | admin |
|---|:---:|:---:|:---:|
| `virtual_keys:read` | ✓ | ✓ | ✓ |
| `audit:read` | ✓ | ✓ | ✓ |
| `virtual_keys:create` |  | ✓ | ✓ |
| `virtual_keys:update` |  | ✓ | ✓ |
| `virtual_keys:rotate` |  |  | ✓ |

角色层级没有用隐式数字比较，而是每个角色对应明确 Permission Set，未来新增 permission 时必须主动决定分配，避免 operator 意外继承高风险能力。

### Token 安全

- `alg` 同时受 Token Header 与配置白名单约束；只允许 RS/PS/ES/EdDSA 非对称算法集合。
- 默认允许 `RS256,ES256`，生产应进一步收窄为 IdP 实际算法。
- 默认要求 `typ=JWT`，若 IdP 使用 `at+jwt` 可显式修改。
- issuer、audience 精确匹配，`sub` 和 `exp` 必须存在。
- 默认允许 5 秒时钟偏差；过大 tolerance 会延长过期 Token 可用时间。
- JWKS timeout 3 秒、cooldown 30 秒、cache 10 分钟，均可配置。
- JWT 验证错误统一 401，权限不足统一 403。

### 审计 Schema v2

Migration 2 在原有 audit_events 增加 `actor_subject`、`actor_issuer`、`actor_roles[]`、`auth_method`。旧记录字段为空仍可读取。变更与 actor 信息继续位于同一事务。

普通请求日志只写不可逆 actorId 和内部 roles，避免扩大员工标识传播；受权限保护的审计 API 才返回 subject 和 issuer。

## 7. 关键选择与替代方案

| 选择 | 原因 | 未选择方案 | 代价 |
|---|---|---|---|
| Resource Server 验 JWT | 与企业 IdP 解耦、无需每请求回源 | 网关自建登录/账号 | JWT 撤销不是即时 |
| 显式 JWKS URL | 信任边界固定、易限制出网 | 从 Token 动态发现 | 配置多三个字段 |
| 外部组映射内部角色 | IdP 命名与代码权限解耦 | 组名直接当 permission | 需要维护映射 |
| 路由声明 permission | Review 时可见且服务端强制 | 只做 UI 菜单权限 | 每个新路由必须选择权限 |
| 默认禁用生产静态模式 | 安全默认值 | 永久兼容共享 Token | IdP 故障需 break-glass 流程 |
| 缓存 JWKS | 降低 IdP 压力并容忍短故障 | 每次获取公钥 | 新 kid 与缓存故障需运维协调 |

## 8. 代码导读

| 文件 | 职责 |
|---|---|
| `src/admin-auth/types.ts` | AdminIdentity、Role、Permission 接口 |
| `src/admin-auth/service.ts` | Bearer/JWT 验证、JWKS、Claim 角色映射和 RBAC |
| `src/admin-auth/factory.ts` | 按 static/oidc 配置创建认证服务 |
| `src/server/routes/admin-virtual-keys.ts` | 每个路由声明 permission，并传递 actor |
| `src/control-plane/migrations.ts` | Schema v2 actor identity 字段 |
| `src/control-plane/postgres-repository.ts` | actor 与 Key 变更同事务写入 |
| `test/admin-auth.test.ts` | 密码学 Claim/算法/权限测试 |
| `test/control-plane-http.test.ts` | 三角色路由级权限矩阵 |
| `scripts/oidc-smoke.ts` | 真实 JWKS HTTP、签发 JWT、启动网关并走 RBAC |

## 9. 配置与兼容性

关键变量见 `.env.example` 和 Runbook。`ADMIN_AUTH_MODE` 可为 disabled/static/oidc；配置 DATABASE_URL 时不能 disabled。开发环境若只提供旧 `ADMIN_BEARER_TOKEN` 会自动推断 static，保持 0.8.0 本地流程。

生产有意改变：static 默认启动失败；临时 break-glass 必须显式设置 `ADMIN_ALLOW_STATIC_IN_PRODUCTION=true`。OIDC 模式不需要 `ADMIN_BEARER_TOKEN`。

## 10. 测试矩阵

| 场景 | 类型 | 预期 |
|---|---|---|
| 正确 RS256 JWT + 嵌套 roles | Crypto unit | 映射 viewer/operator |
| 错 issuer/audience/过期 | Crypto unit + Smoke | 401 |
| ES256 Token 但只允许 RS256 | Crypto unit | 401 |
| 合法 Token 无映射角色 | Unit | 身份成立，任何管理 permission 为 403 |
| viewer 创建 | HTTP | 403 |
| operator 创建/修改 | HTTP | 成功 |
| operator 轮换 | HTTP | 403 |
| admin 轮换 | HTTP | 成功 |
| actor 审计 | Memory + PostgreSQL | subject/issuer/roles/authMethod 完整 |
| 真实远程 JWKS 缓存 | Local network smoke | 多 Token 仅抓取一次 |
| 生产 static 安全门 | Config | 默认拒绝，显式 override 才允许 |

## 11. 手工验证

```bash
npm run smoke:oidc
npm run verify
npm run control-plane:up
POSTGRES_TEST_URL='postgres://aigateway:aigateway-local@127.0.0.1:5433/aigateway' npm run test:postgres
npm run control-plane:down
```

OIDC Smoke 启动两个本地随机端口，仅使用临时 RSA Key 和内存 Repository；PostgreSQL 测试只使用本地开发库。均不调用真实模型。

## 12. 实际验证证据

```text
Default test files: 17 passed, 2 optional integration files skipped
Default tests: 75 passed, 3 skipped
Typecheck: passed
Production build: passed
OIDC remote JWKS HTTP smoke: passed; JWKS fetched once
PostgreSQL migration v1 -> v2 and actor audit: 1 integration test passed
External IdP/model: not called; cost 0
```

## 13. 已知限制与业务影响

- JWT 角色在 Token 过期前不会因 IdP 移组自动变化；高风险环境需短 TTL、会话撤销或后续 introspection。
- 还没有租户级权限：operator 能管理所有虚拟 Key，而不是仅某个 tenant/project。
- viewer 可以读取全部 actor subject 审计，需结合内部隐私政策进一步拆分 audit permission。
- 没有审批流和双人复核；admin 可以单人轮换关键 Key。
- JWKS 缓存是单进程；每个网关实例独立抓取，IdP 需承受实例启动/新 kid 请求。
- 没有 UI；管理员仍通过 curl/自动化调用并自行获取 Access Token。
- 未测试具体企业 IdP Claim 方言；接入时必须做真实租户联调。

## 14. 领导 Review 问题

- viewer/operator/admin 的职责分离是否符合现有组织，轮换是否需要双人审批？
- 管理员 Access Token 允许多长 TTL，离职/高风险事件的目标撤销时间是多少？
- actor subject 属于个人数据，谁能查询、保留多久、是否导出 SIEM？
- 下一轮优先做 tenant-scoped RBAC/审批流，还是管理后台 UI？

## 15. 工程师 Review 清单

- [ ] issuer、audience、JWKS、typ 和 algorithm 是否与 IdP Access Token 完全一致？
- [ ] 生产是否只允许 HTTPS，出网是否仅开放受信 JWKS Host？
- [ ] Role Map 是否显式且未知组默认无权限？
- [ ] 新管理路由是否声明 permission，而非只依赖前端按钮？
- [ ] Token/JWT/原始 subject 是否没有进入普通日志和 Metrics？
- [ ] IdP Key rotation 是否先发布新公钥、后签发新 kid、最后移除旧公钥？
- [ ] 静态 break-glass 是否有审批、截止时间和恢复后轮换？
- [ ] JWT TTL 与人员回收目标是否匹配？

## 16. 偏差记录

原计划可能包含管理 UI。实施时先完成 OIDC/RBAC，因为没有可靠服务端身份与权限时，UI 只会放大共享 Token 风险。本轮额外实现了生产静态 Token 默认禁用、JWT 大小限制和 `typ` 验证，来自 RFC 8725 的算法固定与跨 JWT 混淆防护要求。

## 参考资料

- [RFC 8725：JWT Best Current Practices](https://www.rfc-editor.org/info/rfc8725/)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0-18.html)
- [jose 官方项目](https://github.com/panva/jose)
