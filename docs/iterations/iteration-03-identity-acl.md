# Iteration 3：虚拟 Key、租户上下文与模型 ACL

- 版本：0.3.0
- 日期：2026-07-15
- 状态：Completed
- 关联 ADR：[ADR 0003](../adr/0003-virtual-key-identity-and-model-acl.md)

## 一句话说明

这一轮让网关知道“谁在调用、属于哪个团队、允许使用哪些模型”。

## 30 秒领导摘要

| 领导关心的问题 | 回答 |
|---|---|
| 以前的问题 | 所有人共用一个 Key，无法区分团队、限制高价模型或为成本归属提供身份。 |
| 本轮交付 | 多虚拟 Key、Tenant/Project/Application 身份、模型访问控制和权限过滤模型列表。 |
| 业务价值 | 可以按团队发放不同权限，为下一轮限额、预算和成本报表建立可靠归属。 |
| 如何证明 | 25 项测试覆盖有效/无效 Key、越权 403、模型列表过滤和生产弱 Key 拒绝；真实 Provider 调用成功。 |
| 最大剩余风险 | Key 仍来自环境变量且仓库在内存中，不能动态创建、吊销或多实例同步。 |

### 最短演示

```bash
npm start
npm run smoke
```

`visibleModels` 表示当前 Key 能看到的模型。若配置一个只允许 `general` 的 Key，直接调用 `external` 应返回 HTTP 403，而不是依赖前端隐藏按钮。

## 新人工程师导读

### 阅读前只需要知道

- 前端路由守卫可以隐藏页面，但真正安全必须由服务端再次校验。
- 密码通常不应明文保存，而应保存不可逆摘要。
- 多租户表示同一套系统服务多个相互隔离的团队或客户。

### 本轮术语

| 术语 | 小白解释 | 前端类比 |
|---|---|---|
| Virtual Key | 网关发给某个应用的访问凭证 | 每个前端应用自己的 API Token |
| Tenant | 最大隔离单位，通常对应公司/事业部/客户 | SaaS 中的 workspace |
| Project | Tenant 下的项目或成本中心 | 前端 monorepo 中的业务应用组 |
| Application | 实际发请求的应用 | Web、移动端、内部机器人 |
| ACL | 哪个身份能访问哪些资源的列表 | 路由权限表，但由服务端强制执行 |
| HMAC-SHA256 | 用秘密 Pepper 生成固定长度摘要 | 类似密码 Hash；数据库不保存原 Key |
| Pepper | 仅服务端知道、参与摘要的额外秘密 | 所有密码 Hash 之外的服务器级秘密 |
| Repository | 隐藏身份数据存储方式的接口 | 封装 localStorage/API 的 data access layer |

### 用一个受限 Key 请求理解全流程

假设 `team-a-key` 只允许 `general`，不允许 `external`。

1. 前端请求 Header 带 `Authorization: Bearer team-a-key`。
2. onRequest Hook 像服务端路由守卫一样先执行。
3. AuthService 严格解析 Bearer Token，不接受空值或多余空格。
4. 服务端用 Pepper 对 Key 做 HMAC-SHA256；原 Key 不写入仓库或日志。
5. Repository 根据摘要找到身份：tenant-a/project-a/app-a。
6. AuthContext 被放进本次 Fastify Request，后续模块不再接触原 Key。
7. 请求 `/v1/models` 时只返回 `general`。
8. 即使前端绕过 UI 直接请求 `external`，调用 Route 仍执行 ACL 并返回 403。
9. 请求日志记录非敏感的 tenant/project/application id，为成本归属做准备。

### 前端权限与网关权限的关键区别

```text
前端隐藏 external 选项：改善体验，不是安全边界
服务端 ACL 返回 403：真正阻止越权和费用产生
```

两者都应该存在，但永远不能只依赖前端控制。

### 为什么不直接保存 Key

如果数据库或日志泄露，明文 Key 可以立刻调用模型并产生费用。网关保存摘要后，认证时对来访 Key 做同样计算再比较。攻击者拿到摘要也不能直接当作 Bearer Key 使用。Pepper 进一步要求攻击者同时攻破身份仓库和服务端 Secret。

### 从前端代码看项目

```text
AuthService                ≈ auth service + route guard logic
VirtualKeyRepository       ≈ user/session data access layer
request.authContext        ≈ 服务端版 currentUser context
allowedModels              ≈ permission codes
registerModelRoutes        ≈ 根据权限生成菜单，但服务端调用仍二次校验
GATEWAY_VIRTUAL_KEYS_JSON  ≈ 暂时的静态用户配置，未来会换数据库
```

## 1. 背景与问题

共享 Key 无法支持成本归属、权限隔离和后续分层配额。仅隐藏模型列表不是授权：攻击者仍可直接请求模型，因此发现接口与调用接口必须执行一致 ACL。同时用户已配置 `.env`，但此前启动入口不会自动加载它。

## 2. 本轮目标

- 自动读取 `.env`，系统环境变量优先。
- 支持多个虚拟 Key，并为每个 Key 绑定 Tenant/Project/Application。
- 认证仓库仅保存 Key 摘要。
- `/v1/models` 按调用方权限过滤。
- 非流式与流式调用均强制模型 ACL。
- 建立生产 Key 强度和日志隐私约束。

## 3. 非目标

- PostgreSQL 持久化、管理 API、动态吊销和轮换。
- OIDC/JWT/Workload Identity。
- Tenant/Project 的层级配额和预算。

## 4. 身份模型

```text
VirtualKey
├── keyId             # 可安全记录的标识
├── HMAC-SHA256 hash  # 仓库查找键
├── tenantId
├── projectId
├── applicationId
└── allowedModels[]
```

原始 Key 只存在于进程环境和启动配置解析阶段。仓库使用 `HMAC-SHA256(pepper, rawKey)`，认证后请求上下文不含原始 Key 或 Hash。

### 请求流

```text
Authorization Header
→ 严格 Bearer 解析
→ HMAC Key 摘要
→ VirtualKeyRepository.findByHash
→ AuthContext
→ Model ACL
→ Provider Registry
```

授权先于模型解析。受限 Key 请求无权模型时返回 403，不通过 404 泄露模型是否存在；具有 `*` 权限的 Key 请求未知模型时返回 404。

## 5. 配置兼容

- 旧 `GATEWAY_API_KEY` 保留，映射成 local tenant/project/application 和 `*` 模型权限。
- `GATEWAY_VIRTUAL_KEYS_JSON` 存在时替代旧单 Key 模式。
- `GATEWAY_KEY_PEPPER` 用于摘要；生产环境必须显式配置。
- `NODE_ENV=production` 时 Key 和 Pepper 均要求至少 32 字符。

## 6. 安全与日志

- 只有精确的 `/health/live`、`/health/ready` 免认证。
- 请求日志可记录 key/tenant/project/application id。
- 不记录 Authorization、Key Hash、Provider Key 和 Prompt。
- `.env` 被 Git 忽略。
- `allowedModels` 在仓库中冻结，避免请求代码意外修改共享身份。

## 7. 代码落点

| 文件 | 职责 |
|---|---|
| `src/auth/types.ts` | Key Seed、Record、AuthContext |
| `src/auth/repository.ts` | 仓库接口和内存实现 |
| `src/auth/service.ts` | HMAC、Bearer 认证、模型 ACL |
| `src/server/fastify.ts` | 请求身份类型扩展 |
| `src/server/routes/models.ts` | 权限过滤的模型发现 |
| `src/config.ts` | 多 Key JSON、生产强度校验 |
| `src/server/app.ts` | onRequest 身份注入和身份日志字段 |

## 8. 测试矩阵

| 场景 | 预期 | 测试 |
|---|---|---|
| 相同 Key 不同 Pepper | Hash 不同 | `auth-service.test.ts` |
| 有效 Key | 返回无秘密的 AuthContext | 同上 |
| 无效 Key | 401 | 同上 |
| 模型 ACL | allow/deny 正确 | 同上 |
| 多 Key JSON | 正确解析 | `config.test.ts` |
| 非法 JSON | 启动失败 | 同上 |
| 生产缺 Pepper/弱 Key | 启动失败 | 同上 |
| 模型列表过滤 | 只返回 general | `model-authorization.test.ts` |
| 直接越权调用 | 403 | 同上 |
| 旧单 Key 模式 | 全部回归通过 | `gateway.test.ts` |

## 9. 实际验证证据

```text
Typecheck: passed
Build: passed
Tests: 25/25 passed
.env ignored by Git: confirmed
/v1/models: external + general
Real provider request: HTTP 200
```

真实 Provider 验证：逻辑模型 `external` 路由到 `openai-compatible`，实际模型 `gpt-4.1-mini-2025-04-14`，返回 `OK`，12 input + 2 output Token，Usage 为 Provider 实际值。

## 10. 已知限制

- 仓库是进程内状态，多实例需要相同启动配置。
- Key 变更需要重启，无法即时吊销。
- Pepper 轮换尚无双读迁移机制。
- 环境变量 JSON 不适合大规模 Key 生命周期管理。
- 没有数据库审计记录 Key 创建、禁用和权限变化。

对领导的影响：已经可以进行小范围、静态配置的团队试用，但不适合大量团队自助接入，也不能满足即时离职/泄露吊销要求。

## 领导 Review 问题

- Tenant、Project、Application 是否符合公司的组织和成本中心结构？
- 哪些团队应允许使用 `external` 或高价模型？
- Key 最长允许多久不轮换，泄露后要求多快吊销？
- 在进入正式试用前，是否必须先做数据库和管理审批流程？

## 11. Review 清单

- [ ] 原始 Key 或 Hash 是否可能进入日志/错误？
- [ ] `/v1/models` 与实际调用是否执行相同 ACL？
- [ ] 流式和非流式调用是否都检查权限？
- [ ] 受限 Key 是否通过错误差异泄露模型存在性？
- [ ] 生产默认配置是否 fail fast？
- [ ] 后续 PostgreSQL Repository 是否可以不改 AuthService 接口替换？

## 12. 偏差记录

原计划可能直接进入数据库；本轮先用仓库接口和内存实现固定身份领域模型，减少同时调试数据库迁移、认证语义和 ACL 的变量。持久化明确留给后续控制面迭代。
