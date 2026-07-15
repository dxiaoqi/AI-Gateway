# Iteration 8：PostgreSQL 虚拟 Key 控制面

- 版本：0.8.0
- 日期：2026-07-15
- 状态：Completed
- 关联 ADR：[ADR 0008](../adr/0008-strongly-consistent-key-lifecycle.md)
- 操作手册：[虚拟 Key 控制面操作手册](../runbooks/control-plane-key-operations.md)

## 0. 一句话说明

虚拟 Key 现在可以不停机创建、禁用、改权限、轮换并留下审计记录。

## 1. 30 秒领导摘要

| 领导关心的问题 | 回答 |
|---|---|
| 以前的问题 | Key 写在环境变量里；新增、泄露吊销和权限修改都要改配置并重启，多实例生效时间不可控。 |
| 本轮交付 | PostgreSQL 持久化；5 个管理端点；一次性 Key 签发；即时禁用/轮换；版本冲突保护；事务审计；数据库 Readiness。 |
| 业务价值 | 平台可在不发布网关的情况下管理调用方；泄露凭据可立即止损；变更有可追查证据。 |
| 验证证据 | 68 项默认测试通过；真实 PostgreSQL 18.4 集成测试通过；真实 HTTP 完整生命周期冒烟通过；生产构建通过。 |
| 最大剩余风险 | 管理员仍是单个静态 Token，没有企业 SSO/RBAC；每次认证查库，数据库故障会阻断业务。 |

### 最短演示

```bash
npm run control-plane:up
POSTGRES_TEST_URL='postgres://aigateway:aigateway-local@127.0.0.1:5433/aigateway' npm run test:postgres
npm run control-plane:down
```

应看到 `1 passed`。该测试不调用真实模型，不产生模型费用。

## 2. 新人工程师导读

### 阅读前需要知道什么

- Repository 是数据访问层：业务逻辑不需要知道 SQL 写法。
- 数据库事务是一组“要么全部成功、要么全部失败”的操作。
- HMAC 摘要用于验证 Key，不能从摘要还原原始 Key。
- HTTP `ETag/If-Match` 在这里承载版本号，用来发现两个人同时编辑。

### 本轮术语

| 术语 | 小白解释 | 前端类比 |
|---|---|---|
| 控制面 | 管理 Key 和策略的接口，不承载普通模型请求 | CMS 后台，而业务 API 是用户页面接口 |
| 数据面 | 每次模型调用实际经过的认证、配额、路由 | 用户打开页面时走的线上 BFF |
| 乐观锁 | 更新时确认自己看到的版本仍是最新 | 编辑表单提交时带 revision，过期就提示刷新 |
| 事务 | Key 变更和审计必须一起成功 | Redux 一次 action 原子地产生同一份新 state，但数据库还能跨表回滚 |
| 软禁用 | 保留记录，只设 `enabled=false` | 隐藏/归档数据而不是直接删除；区别是服务端强制拒绝调用 |
| Pepper | 网关持有的额外摘要秘密 | 构建环境中的服务端 Secret；不是前端盐值，也绝不能下发浏览器 |
| Readiness | 是否具备安全接收流量的依赖条件 | 页面进程在，但关键初始化失败时仍显示“暂不可用” |

### 一次“禁用 Key”逐步发生了什么

例：管理员看到 `frontend-team` 的版本是 2，提交 `enabled=false`。

1. 请求进入 `PATCH /admin/v1/virtual-keys/frontend-team`，携带管理员 Token、`If-Match: "2"` 和 JSON。
2. 全局业务认证守卫识别 `/admin/v1/`，不拿业务 Key 校验；管理路由用独立 Token 做恒定时间摘要比较。
3. Schema 拒绝空模型列表、未知字段和错误类型；`If-Match` 缺失或非法返回 428。
4. Repository 从连接池借出一个 PostgreSQL Client，开始事务并用 `FOR UPDATE` 锁住该 Key 行。
5. 若数据库版本不是 2，回滚并返回 409；管理员必须重新读取，避免覆盖别人刚做的修改。
6. 若版本匹配，更新 `enabled=false`、版本 3 和更新时间。
7. 同一事务写入审计 before/after、管理员指纹、request id 和 trace id。审计不含原始 Key 或摘要。
8. COMMIT 成功后才返回 200 和 `ETag: "3"`；任一步失败都会 ROLLBACK。
9. 旧 Key 下一次调用时，认证服务计算 HMAC、直接查 PostgreSQL，看到 `enabled=false` 后返回 401。

注意：“立即”指事务提交后的下一次新请求；已经通过认证并正在生成的流式请求不会被本轮主动中断。

## 3. 背景与问题

环境变量模式把身份生命周期和应用发布耦合。企业内最危险的场景不是“创建慢”，而是泄露 Key 无法确定何时完全失效。若每个实例各自缓存配置，即使某台已重启，另一台仍可能接受旧 Key。本轮先建立最小可信控制面：身份事实唯一、吊销语义明确、变更可审计。

## 4. 本轮目标

- 数据库模式下，Key 和权限跨进程重启保留。
- 管理员可创建、列出、禁用/启用、修改模型 ACL、轮换和查询审计。
- 原始 Key 只返回一次，列表和审计永不返回原始 Key/摘要。
- 禁用和轮换提交后，下一次认证立即读取新状态。
- 并发更新不会静默丢失。
- PostgreSQL 不可用或未迁移时 Readiness 为 503。
- 不配置数据库时，原有环境变量模式继续工作。

## 5. 非目标

- 模型部署、路由权重和配额策略的数据库管理。
- 管理后台 UI、批量操作、分页游标和搜索。
- OIDC/SSO、角色权限、审批流和双人复核。
- Key 到期时间、自动轮换、双 Key 宽限期。
- Key 认证缓存和跨实例失效广播。
- 正在执行请求的强制中断。
- PostgreSQL HA、备份恢复和跨地域灾备。

## 6. 详细设计

### 请求流与边界

```text
管理请求 ─→ 独立 Admin Token ─→ ControlPlaneService ─→ PostgreSQL 事务
                                                        ├─ virtual_keys
                                                        └─ audit_events

业务请求 ─→ 原始虚拟 Key ─→ HMAC(pepper) ─→ PostgreSQL 查询 ─→ AuthContext ─→ ACL/配额/路由
```

管理 Token 不能调用业务 API；业务 Key 不能调用管理 API。两类凭据泄露后的影响范围不同，因此不能复用。

### 数据表

`virtual_keys` 保存身份层级、模型 ACL、enabled、version 和时间。`key_hash char(64)` 是 HMAC 十六进制摘要。`audit_events` 保存操作人指纹、动作、资源、前后状态以及请求关联字段。`gateway_schema_migrations` 记录已执行版本。

迁移使用 PostgreSQL advisory lock，避免多个网关同时启动时并发执行相同迁移；每个 migration 自身处于事务。

### API

| 方法与路径 | 作用 | 成功 | 关键失败 |
|---|---|---:|---|
| `POST /admin/v1/virtual-keys` | 创建并一次性返回 Key | 201 | 重复 id/secret 409 |
| `GET /admin/v1/virtual-keys` | 列出非秘密元数据 | 200 | 管理 Token 错误 401 |
| `PATCH /admin/v1/virtual-keys/:id` | 启停或改 allowedModels | 200 | 无 If-Match 428；旧版本 409 |
| `POST /admin/v1/virtual-keys/:id/rotate` | 生成新 Key，旧 Key 失效 | 200 | 不存在 404；旧版本 409 |
| `GET /admin/v1/audit-events` | 按新到旧读取审计 | 200 | limit 非法 400 |

创建与轮换响应里的 `key` 是 write-only secret。它不会再次从数据库读取，因为数据库根本没有原文。

### 状态与一致性

- `version` 每次修改加 1；读取版本后再更新构成乐观并发控制。
- `SELECT ... FOR UPDATE` 让同一 Key 的并发写顺序化。
- 变更与 audit insert 共用同一个 Client、BEGIN/COMMIT；node-postgres 官方明确事务必须固定在同一个 Client。
- 认证不缓存，确保多实例都读取同一个已提交事实。
- PostgreSQL 故障时 fail closed：不回退旧配置，防止已吊销 Key 复活。

### 安全与隐私

- Key 由 `randomBytes(32)` 产生并使用 base64url，共 256 位随机材料。
- HMAC Pepper 只来自进程 Secret；数据库泄露本身不能直接得到原始 Key。
- Admin Token 先做 SHA-256 再 `timingSafeEqual`，避免长度差导致直接比较异常和明显时序差。
- 审计 actor 只保存 Admin Token 摘要前 12 位形成的稳定指纹，不保存 Token。
- 日志继续只记录 keyId/tenant/project/application，不记录 Authorization、Prompt、原始 Key 或摘要。

### 可观测性与故障

`/health/live` 只说明 Node 进程还活着；`/health/ready` 会查询 migration 表，数据库断开或 Schema 未建立时返回 503。负载均衡器应只向 Ready 实例发送业务流量。

## 7. 关键选择与替代方案

| 选择 | 原因 | 未选择方案 | 代价 |
|---|---|---|---|
| 每次认证查 PostgreSQL | 即时吊销语义最容易证明 | 本地 TTL 缓存 | 每请求增加 DB 延迟和依赖 |
| HMAC+Pepper 摘要 | 不保存可用凭据，沿用 Iteration 3 | 加密保存原始 Key | 有解密权即能批量泄露 |
| 事务写审计 | 事实与证据一致 | 异步消息审计 | 事务稍长，审计表故障会阻止变更 |
| If-Match 版本 | 防止前端旧表单覆盖新状态 | 最后写入胜出 | 客户端需处理 409 |
| 软禁用，无 DELETE | 保留调查线索和历史 | 物理删除 | 表会持续增长，需后续归档策略 |
| 显式迁移脚本 | 生产发布可控 | 所有实例自动迁移 | 发布流程多一步 |

## 8. 代码导读

| 文件/模块 | 职责 |
|---|---|
| `src/control-plane/migrations.ts` | 表结构、版本记录、advisory lock 和事务迁移 |
| `src/control-plane/postgres-repository.ts` | 参数化 SQL、行锁、变更+审计事务、认证查询 |
| `src/control-plane/service.ts` | 生成 Key、计算摘要、编排 Repository |
| `src/control-plane/runtime.ts` | 连接池、迁移/种子、Readiness、优雅关闭 |
| `src/server/routes/admin-virtual-keys.ts` | Admin 认证、Schema、If-Match、5 个 HTTP 端点 |
| `src/control-plane/in-memory-repository.ts` | 快速且可重复的 HTTP 生命周期测试替身 |
| `scripts/migrate.ts` | 发布阶段显式执行数据库迁移 |
| `scripts/control-plane-smoke.mjs` | 真实 HTTP 完整生命周期冒烟 |
| `test/control-plane-http.test.ts` | 不依赖 Docker 的 API/即时失效/秘密测试 |
| `test/postgres-control-plane.integration.test.ts` | 真实 PostgreSQL 事务、迁移和认证测试 |

## 9. 配置与兼容性

| 环境变量 | 默认 | 说明 |
|---|---:|---|
| `DATABASE_URL` | 未设置 | 设置后启用 PostgreSQL Key 控制面 |
| `ADMIN_BEARER_TOKEN` | 未设置 | DATABASE_URL 存在时必填；生产至少 32 字符 |
| `DATABASE_POOL_MAX` | 10 | 单个网关进程最大数据库连接数 |
| `DATABASE_CONNECTION_TIMEOUT_MS` | 3000 | 建连等待时间 |
| `DATABASE_AUTO_MIGRATE` | false | 本地可 true；生产推荐发布 Job 显式迁移 |
| `CONTROL_PLANE_SEED_FROM_ENV` | false | 首次迁移时用环境变量 Key 做 INSERT-only 种子 |

兼容策略：没有 `DATABASE_URL` 时保持 0.7.0 内存/环境变量认证。启用数据库后不回退内存。种子使用 `ON CONFLICT DO NOTHING`，重启不会重新启用已禁用 Key；也不会覆盖数据库内已修改 ACL。

## 10. 测试矩阵

| 场景 | 类型 | 预期 | 测试文件 |
|---|---|---|---|
| Admin/业务凭据隔离 | HTTP | 无 Admin Token 为 401 | `control-plane-http.test.ts` |
| 创建后认证 | HTTP | 新 Key 可调用 general | 同上 |
| 禁用即时生效 | HTTP + PostgreSQL | 下一请求 401 | 两个控制面测试 |
| 缺少版本 | HTTP | 428 | `control-plane-http.test.ts` |
| 旧版本并发更新 | HTTP + PostgreSQL | 409，状态不被覆盖 | 两个控制面测试 |
| 轮换 | HTTP + PostgreSQL | 旧 Key 401，新 Key 200 | 两个控制面测试 |
| 审计秘密边界 | HTTP + PostgreSQL | 无 raw key/keyHash | 两个控制面测试 |
| 迁移幂等 | PostgreSQL | 执行两次仍只有版本 1 | PostgreSQL 集成测试 |
| 配置兼容 | Unit | DB 可选，生产约束正确 | `config.test.ts` |
| 真实网络链路 | Smoke | 全生命周期通过 | `control-plane-smoke.mjs` |

## 11. 手工验证

详细逐步命令见 [验证手册](../VERIFICATION.md) 第 9 节和 [操作手册](../runbooks/control-plane-key-operations.md)。最短真实数据库验证：

```bash
npm run control-plane:up
POSTGRES_TEST_URL='postgres://aigateway:aigateway-local@127.0.0.1:5433/aigateway' npm run test:postgres
npm run control-plane:down
```

只访问本机 PostgreSQL和 Mock Provider，无模型费用。集成测试会清空本地开发库中的 `virtual_keys` 和 `audit_events`，因此不能把 `POSTGRES_TEST_URL` 指向共享或生产数据库。

## 12. 实际验证证据

2026-07-15 实际执行：

```text
Typecheck: passed
Default test files: 16 passed, 2 optional integration files skipped
Default tests: 68 passed, 3 optional tests skipped
Production build: passed
PostgreSQL image: postgres:18.4-alpine, healthy
PostgreSQL integration: 1 passed; migration invoked twice
Container restart persistence: virtual_keys count 1 before and 1 after restart
HTTP smoke: passed (create -> disable -> enable -> rotate -> audit)
Production dependency audit: 0 vulnerabilities
External model: not called; cost 0
```

真实 HTTP 冒烟还发现并修复了一个网络层问题：空 POST 若错误携带 JSON Content-Type，Fastify 会产生 400；统一错误处理原本会误包装成 500，现在框架 4xx 被规范为 `invalid_request_error`，但 Gateway 自己的 401/403 保持原语义。

## 13. 已知限制与业务影响

- 静态 Admin Token 无法回答“具体哪位员工操作”；当前 actor 只是 Token 指纹，生产审计仍不够。
- 单 Key 轮换立即切断旧值；调用方未同步会中断。无损方式是先创建第二把 Key，再切换、最后禁用旧 Key。
- 已通过认证的长流请求不会因中途禁用而被强制断开；极端泄露事件仍有在途窗口。
- 每请求查库增加延迟；数据库故障会使认证失败。生产需要 HA、连接预算、备份和恢复演练。
- `limit` 只是最近 N 条，没有游标、筛选和审计归档；数据大后不适合运营查询。
- 没有过期时间、最后使用时间和自动轮换提醒，平台仍需人工治理长期 Key。
- Pepper 不支持在线双读轮换；丢失会让全部现有 Key 无法认证，泄露需要全量重签。
- 管理 API 目前没有网络层隔离和细粒度 RBAC；生产还应置于内网/mTLS/API firewall 之后。

## 14. 领导 Review 问题

- Key 泄露后的目标吊销时间是否接受“事务提交后的下一请求”，是否还要求中断在途流？
- 管理操作是否必须接企业 SSO、按角色授权和双人审批，谁拥有最终权限？
- PostgreSQL 由现有平台托管还是网关团队自建，RTO/RPO 是多少？
- 业务更需要下一轮做 OIDC/RBAC 管理面，还是先把模型/配额策略也动态化？

## 15. 工程师 Review 清单

- [ ] 生产 DATABASE_URL 是否使用 TLS、最小权限账号和 Secret Manager？
- [ ] `GATEWAY_KEY_PEPPER` 是否备份、限制读取且至少 32 字符？
- [ ] Admin Token 是否与业务/metrics Token 完全不同，并限制网络入口？
- [ ] 生产迁移是否由独立发布步骤执行，而非所有实例竞争启动？
- [ ] 变更和审计是否始终使用同一 Client 与事务？
- [ ] SQL 是否参数化，列表/审计是否绝不返回 keyHash？
- [ ] 客户端是否正确处理 428、409、404，不自动覆盖？
- [ ] 连接池总预算是否按全部实例计算？
- [ ] 数据库故障时是否 fail closed，Readiness 是否摘流？
- [ ] 集成测试 URL 是否确定不是共享/生产库？

## 16. 偏差记录

原始设想包含模型配置与配额策略数据库化。审计现有边界后，本轮缩小到虚拟 Key 完整生命周期，因为它是最迫切的安全闭环，也能独立验收。管理 UI、OIDC/RBAC 和策略控制面保留后续迭代，避免一次同时重构认证、路由和配额三类核心状态。

## 参考资料

- [node-postgres Pool](https://node-postgres.com/apis/pool)：连接池、释放 Client、关闭 Pool。
- [node-postgres Transactions](https://node-postgres.com/features/transactions)：事务必须使用同一 Client。
- [node-postgres Queries](https://node-postgres.com/features/queries)：参数化查询避免 SQL 注入。
- [PostgreSQL 18.4 发布说明](https://www.postgresql.org/about/news/postgresql-184-1710-1614-1518-and-1423-released-3297/)：本地镜像固定版本依据。
- [PostgreSQL Docker Official Image PGDATA](https://github.com/docker-library/docs/blob/master/postgres/README.md#pgdata)：18+ Volume 应挂载 `/var/lib/postgresql`。
