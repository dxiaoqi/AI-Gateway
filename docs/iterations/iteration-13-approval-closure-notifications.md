# Iteration 13：审批闭环与站内通知

- 版本：0.13.0
- 日期：2026-07-15
- 状态：Completed
- 关联 ADR：[ADR 0013](../adr/0013-tenant-notification-inbox.md)
- 操作手册：[租户访问与轮换审批](../runbooks/tenant-access-and-rotation-approval.md)

## 0. 一句话说明

轮换审批不再只有“批准”：申请人可以撤销，另一位管理员可以拒绝，三种决策都必须留下原因，并在同一数据库事务里生成审计和站内通知。

## 1. 30 秒领导摘要

| 领导关心的问题 | 本轮回答 |
|---|---|
| 流程是否闭环 | 状态完整支持 pending、approved、rejected、cancelled、expired。 |
| 谁能做什么 | 申请人只能撤销自己的申请；另一位同租户 admin 可以批准或拒绝；跨租户继续 403。 |
| 为什么做决定 | 批准、拒绝、撤销均要求 3–500 字符理由，并进入审计。 |
| 人怎么知道有待办 | 新增租户级站内通知和未读角标；决策结果定向通知原申请人。 |
| 已读是否互相影响 | 不影响。每个管理员有独立 read receipt。 |
| 数据会不会半成功 | 状态、Key 轮换、审计、通知位于同一个 PostgreSQL 事务。 |
| 外部邮件/IM | 本轮不绑定某一家供应商；先提供可靠站内事实源，下一轮可接 outbox worker。 |

## 2. 给传统前端工程师的类比

把轮换申请想成一个 Pull Request：

- `pending`：PR 正在等待 Review。
- `approved`：另一位 Reviewer 批准并真正执行合并，这里对应生成新 Key。
- `rejected`：Reviewer 认为材料不完整，写理由后关闭。
- `cancelled`：PR 作者发现发布计划取消，自己撤回。
- `expired`：超过变更窗口还没人处理，系统自动关闭。

前端按钮只展示用户“理论上可以做”的动作。即使在 DevTools 手工请求，Gateway 仍检查 actor、tenant、当前状态和过期时间。

## 3. 状态机

```text
                     另一位同租户 admin + 理由
                  ┌──────── approved（同时轮换 Key）
                  │
pending ──────────┼──────── rejected（Key 不变）
   │              │
   │              └──────── expired（到期自动转换）
   │
   └── 申请人本人 + 理由 ── cancelled（Key 不变）
```

终态不可再次决策。并发请求会锁定同一条申请，最多一个动作成功，其余返回 409。

## 4. 关键业务规则

| 场景 | 结果 | 原因 |
|---|---:|---|
| 申请人批准自己的申请 | 409 | 双人原则 |
| 申请人拒绝自己的申请 | 409 | 自己的申请应使用“撤销”，避免审计语义混乱 |
| 非申请人撤销 | 409 | 不能替别人伪造“主动撤回” |
| 同租户另一位 admin 拒绝 | 200 | 合法 Review 决策 |
| 跨租户 admin 决策 | 403 | Tenant Scope 仍是强边界 |
| 理由少于 3 或超过 500 字符 | 400 | 避免空理由和无限制载荷 |
| 已进入终态后重复操作 | 409 | 状态机只允许一次终局决策 |
| 申请后 Key version 改变再批准 | 409 | 防止批准陈旧对象 |

## 5. 通知设计

### 5.1 为什么不是直接发邮件

核心事务里直接调用邮件或企业微信会产生经典问题：数据库已经提交，但外部请求超时；或者消息发出，数据库却回滚。不同企业使用的渠道也不同。本轮先把“必须发生的通知事实”持久化，页面立即可见。

### 5.2 两类通知

- 申请创建：租户级广播，当前租户范围内管理员可见。
- 批准/拒绝/撤销：定向原申请人，包含决策理由。

### 5.3 独立已读

`admin_notifications` 保存通知本身；`admin_notification_reads` 使用 `(notification_id, actor_id)` 复合主键保存每个人的已读时间。Alice 标记已读不会让 Carol 的未读角标消失。

## 6. 数据库 Schema v4

`virtual_key_rotation_requests` 新增：

- `decided_by_actor_id`
- `decided_by_subject`
- `decision_reason`
- `decided_at`
- status CHECK 扩展 rejected/cancelled

新增两张表：

| 表 | 用途 |
|---|---|
| `admin_notifications` | 不可变的通知事实、租户、类型、资源、定向 actor |
| `admin_notification_reads` | 每个 actor 独立的 read receipt |

旧的 approved 数据在迁移时回填统一 decision 字段，不丢失已有审批记录。

## 7. API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/v1/rotation-requests?status=pending` | 按状态和租户过滤 |
| POST | `/admin/v1/rotation-requests/:id/approve` | body `{ reason }`，成功才返回一次性新 Key |
| POST | `/admin/v1/rotation-requests/:id/reject` | body `{ reason }`，另一位 admin |
| POST | `/admin/v1/rotation-requests/:id/cancel` | body `{ reason }`，仅申请人 |
| GET | `/admin/v1/notifications?unreadOnly=true` | 当前 actor 可见的未读通知 |
| POST | `/admin/v1/notifications/:id/read` | 只标记当前 actor 已读 |

列表过滤发生在 Repository/SQL 层，不是把全租户数据取回 Node 后再过滤。

## 8. 页面变化

- 审批页默认只显示 pending，可切换 approved/rejected/cancelled/expired/all。
- 申请人看到“撤销申请”；其他 admin 看到“批准并轮换”和“拒绝”。
- 三种操作统一打开理由弹窗。
- 已完成申请直接展示决策理由。
- 新增通知中心、未读角标、标记已读。
- 总览的 pending 数量继续来自真实审批数据。

## 9. 代码导读

| 文件 | 职责 |
|---|---|
| `src/control-plane/migrations.ts` | Schema v4 与通知表 |
| `src/control-plane/types.ts` | 状态机、决策字段和通知契约 |
| `src/control-plane/postgres-repository.ts` | 行锁、决策事务、租户/actor 通知过滤 |
| `src/control-plane/in-memory-repository.ts` | 与 PostgreSQL 同语义的快速测试实现 |
| `src/server/routes/admin-virtual-keys.ts` | reject/cancel/filter/notification HTTP API |
| `apps/admin-console/components/admin-console.tsx` | 状态筛选、理由弹窗、通知中心 |
| `scripts/admin-console-smoke.mjs` | 真实 Session/BFF/DB 审批闭环 |

## 10. 验证证据

```text
Schema v4 isolated PostgreSQL integration: passed
In-memory HTTP state-machine test: passed
OIDC/JWKS/RBAC two-person approval smoke: passed
Next -> BFF -> Gateway -> PostgreSQL -> notification/read smoke: passed
Gateway TypeScript build: passed
Next production build: passed
```

PostgreSQL 测试使用独立数据库 `aigateway_iter13_test_20260715`，没有清空当前演示库。当前演示库通过版本化 migration 从 v3 无损升级到 v4。

曾尝试使用应用内浏览器做最终页面目测，但本地 URL 被浏览器安全策略阻止，因此没有把该项计为通过；页面交互由 Next production build、静态契约测试和真实 BFF smoke 覆盖。

## 11. 已知限制

- 暂无邮件、企业微信、钉钉或 Slack 投递 Worker；站内通知是当前可靠入口。
- 暂无通知保留/归档策略，大规模生产需要按公司审计策略分区或清理。
- 通知内容目前是固定模板，尚未国际化。
- 当前没有把审批与外部 ITSM 变更单做强校验；理由可填写变更单号，但不会联网验证。
- 静态本地管理员只有一个 actor，所以只能演示申请人撤销；完整批准/拒绝需要两个 OIDC subject。
- Anthropic 原生协议继续暂缓。

## 12. 下一轮建议

Iteration 14 优先实现可配置 Notification Outbox Worker：Webhook 通道、签名、指数退避、死信和投递状态页面；并推进 Cursor 分页与 Key 搜索，避免数据量增长后一次加载 200 条。模型/配额策略管理随后进入管理后台。
