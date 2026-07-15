# Iteration 10：租户范围授权与双人 Key 轮换

- 版本：0.10.0
- 日期：2026-07-15
- 状态：Completed
- 关联 ADR：[ADR 0010](../adr/0010-tenant-scope-and-two-person-rotation.md)
- 操作手册：[租户访问与双人轮换](../runbooks/tenant-access-and-rotation-approval.md)

## 0. 一句话说明

管理员只能操作获授权租户，高风险 Key 轮换必须由两名不同管理员共同完成。

## 1. 30 秒领导摘要

| 领导关心的问题 | 回答 |
|---|---|
| 以前的问题 | operator/admin 能管理所有租户；一名 admin 可立即轮换任意 Key，误操作或账号被盗影响全局。 |
| 本轮交付 | JWT tenant scope、数据库级列表/审计过滤、跨租户写保护、Schema v3 审批状态机、双人轮换、过期/版本/并发保护。 |
| 业务价值 | 把单个管理员事故限制在授权租户；敏感轮换实现职责分离；审批事实可审计并防重放。 |
| 验证证据 | 默认自动测试、真实 JWKS 租户隔离+双人 HTTP 冒烟、真实 PostgreSQL 过期和两人并发仅一次成功。 |
| 最大剩余风险 | Scope 只有 tenant 粒度；没有 reject/cancel、通知和审批 UI；JWT Scope 仍是短期快照。 |

### 最短演示

```bash
npm run smoke:oidc
npm run verify
```

预期看到：`tenant scope -> RBAC -> two-person rotation -> actor audit`。

## 2. 新人工程师导读

### 前置知识

- RBAC 用角色决定动作权限；资源范围决定能操作哪些数据。
- BOLA（对象级授权缺失）指用户通过修改 URL 中的 ID 访问不属于自己的对象。
- 职责分离意味着一个高风险操作需要不同身份分别发起和批准。
- 数据库行锁用于让两个并发批准请求排队，而不是都成功。

### 术语与前端类比

| 术语 | 小白解释 | 前端类比 |
|---|---|---|
| tenant scope | JWT 中允许管理的租户集合 | 多商户后台当前账号可见的 organizationIds；区别是服务端每个查询都强制 |
| deny by default | 没有明确范围就没有权限 | 前端路由无配置时不显示，但这里 API 也返回 403 |
| pending approval | 已申请但尚未执行 | PR 已创建，还没有第二位 Reviewer Approve |
| separation of duty | 发起人与批准人不能相同 | 作者不能充当唯一 Code Owner 批准自己的高风险变更 |
| terminal state | 不能再离开的最终状态 | Promise fulfilled/rejected 后不能再次 resolve |
| partial unique index | 只对符合条件的行保证唯一 | 只要求“进行中任务”唯一，历史完成记录可保留多条 |

### 一次双人轮换发生什么

1. Alice 的 JWT 角色是 admin，tenantScopes 只有 tenant-a。
2. Alice 为 tenant-a 的 Key 创建申请，带 `If-Match: 4`。
3. 路由验证角色、读取 Key，并确认 tenant-a 在 Alice 的 scope。
4. PostgreSQL 锁定 Key，确认版本 4、清理过期 pending，并插入唯一 pending 申请及 `rotation_requested` 审计；此时不生成新 Key。
5. Alice 自己批准会被 actorId 比较拒绝。tenant-b 的 Bob 即使是 admin，也因 scope 不匹配返回 403。
6. 同属 tenant-a 的 Carol 批准。事务先锁申请，再检查 pending、数据库时间未过期、Carol 不是 Alice。
7. 事务锁 Key 并重新确认仍是版本 4；如果等待期间有人改过 ACL/状态，返回 409，避免旧审批覆盖新事实。
8. 网关此时才生成新随机 Key；数据库原子更新摘要和版本、把申请改为 approved、写 Carol 的 rotated 审计。
9. COMMIT 后响应只返回一次新 Key。两个并发批准中只有拿到行锁的第一个成功，第二个看到 approved 后 409。

## 3. 背景与问题

角色是功能级授权，不是数据级授权。一个 viewer 即使只能读，如果能看到所有租户的 Key 元数据和员工审计，仍构成跨租户泄露。一个全局 admin 被盗时可以直接轮换所有 Key。Iteration 10 将身份、动作、资源和业务状态四层同时纳入授权。

## 4. 本轮目标

- JWT 明确声明可管理 tenantId，缺失默认无权限。
- 创建、修改、直接轮换、申请和批准都检查目标 tenant。
- Key、audit、rotation request 列表只返回授权租户。
- 生产直接轮换默认关闭。
- 双人审批禁止自批、跨租户、过期、重复和旧版本执行。
- 并发批准最多一次成功，新 Key 只在成功响应出现一次。
- v1/v2 数据可迁移，旧审计回填 tenantId。

## 5. 非目标

- project/application/key 粒度 Scope。
- 动态策略引擎、Open Policy Agent 或 Cedar。
- reject/cancel/重新指派审批。
- 邮件、飞书、钉钉通知。
- 审批 UI、变更单系统集成和数字签名。
- 业务 Key 双写宽限期或自动更新调用方 Secret Manager。
- JWT introspection 与即时 Scope 撤回。

## 6. 详细设计

### 授权公式

```text
ALLOW = JWT有效
    AND role拥有route permission
    AND (tenantScopes包含resource.tenantId OR tenantScopes包含*)
    AND resource当前状态允许动作
```

任何条件缺失都拒绝。列表查询把 `tenant_id = ANY($scopes)` 放入 SQL；空数组自然返回 0 行。

### Tenant Claim

默认 Claim 为 `ai_gateway_tenants`，支持字符串或最多 1000 个字符串的数组，每个 tenantId 最长 200。格式错误整体按空 Scope，不尝试“尽量接受”。静态本地 Token 显式映射为 `*`，仅用于开发/break-glass。

### Schema v3

- audit_events 新增 `tenant_id` 和 `actor_tenant_scopes[]`，并从旧 before/after JSON 回填 tenantId。
- `virtual_key_rotation_requests` 保存申请 ID、Key、tenant、版本、状态、申请/批准身份和时间。
- partial unique index：同一 key_id 在 `status='pending'` 时唯一。
- tenant/status/requested_at 索引支持租户范围的待审批查询。

### 审批错误语义

| code | HTTP | 含义 |
|---|---:|---|
| `approval_required` | 409 | 生产关闭了直接 rotate |
| `approval_conflict` | 409 | 自批、已有 pending、过期、已批准或版本改变 |
| `authorization_error` | 403 | 角色或租户范围不足 |
| `precondition_required` | 428 | 申请缺少有效 If-Match |

## 7. 关键选择与替代方案

| 选择 | 原因 | 未选择方案 | 代价 |
|---|---|---|---|
| Tenant scope 在可信 JWT | 与 IdP 人员生命周期结合 | 单独管理员 ACL 表 | Scope 在 Token TTL 内是快照 |
| SQL 层过滤 | 防止遗漏和全量数据出库 | Node filter | Repository 接口更复杂 |
| 两个不同 actorId | 明确职责分离 | 同人二次确认 | 至少需两名同租户 admin |
| Approval 锁申请+Key | 并发只一次、状态一致 | 先查后更新 | 事务锁持有稍长 |
| 申请绑定 Key version | 审批上下文不陈旧 | 批准时总用最新版 | 状态变化需重申请 |
| 15 分钟终态过期 | 限制旧申请窗口 | 永久 pending | 运营需及时处理 |

## 8. 代码导读

| 文件 | 职责 |
|---|---|
| `src/admin-auth/service.ts` | 解析 tenant Claim、默认拒绝与 tenant access assertion |
| `src/control-plane/migrations.ts` | Schema v3、回填、审批表与索引 |
| `src/control-plane/postgres-repository.ts` | SQL Scope、审批行锁、版本和原子轮换 |
| `src/control-plane/service.ts` | 申请 TTL、一次性 Key 生成和批准编排 |
| `src/server/routes/admin-virtual-keys.ts` | 所有资源路由 scope 检查与三个审批端点 |
| `test/tenant-approval-http.test.ts` | 跨租户、列表过滤和完整双人流程 |
| `test/postgres-control-plane.integration.test.ts` | v3、过期、版本和并发批准 |
| `scripts/oidc-smoke.ts` | 真实 JWKS/JWT/Scope/RBAC/审批 HTTP 冒烟 |

## 9. 配置与兼容性

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_OIDC_TENANT_CLAIM` | `ai_gateway_tenants` | tenantId 字符串/数组 Claim 路径 |
| `ROTATION_APPROVAL_REQUIRED` | development false；production true | 是否关闭旧直接轮换 API |
| `ROTATION_APPROVAL_TTL_MS` | 900000 | 申请有效期 15 分钟 |

0.9.0 开发环境保持直接 rotate 兼容；生产升级到 0.10.0 后默认必须走审批，这是有意的安全行为变化。IdP 未加入 Tenant Claim 时 OIDC 用户会得到空列表和资源 403，而不是意外全局权限。

## 10. 测试矩阵

| 场景 | 类型 | 预期 |
|---|---|---|
| Claim 缺失/空 | Crypto unit | 无 tenant 权限 |
| tenant-a 列表 | HTTP/PG | 不出现 tenant-b Key |
| tenant-a audit/approval list | HTTP/PG | 不出现 tenant-b 数据 |
| 跨租户创建/修改/批准 | HTTP | 403 |
| 直接 rotate | HTTP | approval_required 409 |
| 申请人自批 | HTTP/PG | approval_conflict 409 |
| 第二人同租户批准 | HTTP/PG | 200，新 Key 一次返回 |
| 重复批准 | HTTP/PG | 只有首次成功 |
| 申请过期 | PostgreSQL | 状态持久化 expired，不能执行 |
| 两人并发批准 | PostgreSQL | 1 fulfilled + 1 rejected |
| 等待期间 Key 改变 | Repository | 409，需重申请 |

## 11. 手工验证

```bash
npm run smoke:oidc
npm run verify
npm run control-plane:up
POSTGRES_TEST_URL='postgres://aigateway:aigateway-local@127.0.0.1:5433/aigateway' npm run test:postgres
npm run control-plane:down
```

详见 [操作手册](../runbooks/tenant-access-and-rotation-approval.md)。这些测试不调用真实模型；PostgreSQL 集成测试会清空本地测试表，禁止指向共享/生产库。

## 12. 实际验证证据

```text
TypeScript strict typecheck: passed
Default test files: 18 passed, 2 optional integration files skipped
Default tests: 77 passed, 3 optional integration tests skipped
Production build: passed
npm production dependency audit: 0 vulnerabilities
Real JWKS/JWT tenant scope + two-person approval HTTP smoke: passed
JWKS network fetch count: 1
PostgreSQL Schema v3 migration: passed
PostgreSQL expired request persisted: passed
PostgreSQL two concurrent approvers: exactly one succeeded
External IdP/model: not called; cost 0
```

## 13. 已知限制与业务影响

- Tenant Scope 不能限制到 project/application，较大租户内部仍是宽权限。
- 没有 reject/cancel；错误申请只能等待过期，pending 期间会阻止同 Key 新申请。
- 没有通知；第二名 admin 不主动查询就不知道有待审批。
- 没有无损轮换编排；批准后旧 Key 立即失效，调用方仍需协调切换。
- 新 Key 返回给批准人而非自动写 Secret Manager，存在人工传递风险。
- 审批只证明两个不同 OIDC subject，不验证他们是否来自不同部门或汇报线。
- Scope 在 JWT 过期前不会即时回收。

## 14. 领导 Review 问题

- 哪些租户必须双人审批，是否允许低风险开发租户直接轮换？
- 两名 admin 是否还要求来自不同团队，谁定义冲突关系？
- 下一轮优先接通知/审批 UI/Secret Manager，还是继续细化到 project scope？
- pending、audit 和员工身份记录应保留多久？

## 15. 工程师 Review 清单

- [ ] IdP tenant Claim 是否来自权威目录，而不是前端可编辑字段？
- [ ] 缺失/未知 tenant 是否 deny by default？
- [ ] 每个 GET 列表是否在 SQL/Repository 层过滤？
- [ ] 每个 ID 路由是否在写入前重新检查资源 tenant？
- [ ] 申请和批准是否必须两个不同 actorId？
- [ ] 批准是否重新检查 Key version、过期和 pending？
- [ ] 并发批准是否通过行锁只能成功一次？
- [ ] 原始新 Key 是否只在成功批准响应出现？
- [ ] 生产是否保持 `ROTATION_APPROVAL_REQUIRED=true`？

## 16. 偏差记录

最初可能同时加入审批 UI。本轮仍先完成服务端权威状态机，因为没有数据库级并发与对象授权时，UI 无法阻止直接 HTTP 绕过。Reject/cancel 和通知被明确留到后续，保证本轮能证明最核心的“跨租户不可见、申请人不能自批、并发只执行一次”。

## 参考资料

- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [NIST RBAC FAQ：Separation of Duty](https://csrc.nist.gov/Projects/role-based-access-control/faqs)
- [PostgreSQL 18 SELECT / FOR UPDATE](https://www.postgresql.org/docs/18/sql-select.html)
