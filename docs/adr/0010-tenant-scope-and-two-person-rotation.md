# ADR 0010：租户范围授权与双人 Key 轮换

- 状态：Accepted
- 日期：2026-07-15
- 版本：0.10.0

## 背景

Iteration 9 解决了“谁在操作”和“角色能做什么”，但 operator/admin 仍能管理全部租户。只要知道其他 Key ID 就可能跨租户修改，列表和审计也会返回全量数据。此外，一个 admin 可以单独轮换业务 Key，误操作或账号被盗会立即中断调用方。

## 决策

1. OIDC JWT 从可配置 Claim 读取允许管理的 tenantId 列表，形成 `tenantScopes`；缺失或格式错误默认没有任何租户权限，`*` 才表示全局。
2. 所有创建、修改、轮换和审批请求同时检查 RBAC permission 与目标 Key 的 tenantId。
3. Key、审计和轮换申请列表在 Repository/SQL 层按 tenantId 过滤，不先读取全量数据。
4. 生产默认关闭直接轮换。admin 先创建带 Key version 和过期时间的 rotation request，再由另一名具有同租户权限的 admin 批准。
5. 申请人和批准人使用稳定 actorId 比较；同一人不能自批。静态 break-glass Token 只有一个 actor，因此不能完成双人审批。
6. 批准事务锁定申请和 Key，重新检查 pending、未过期、不同 actor、版本未变化，再原子完成 Key 轮换、申请状态更新和审计。
7. 每个 Key 同时最多一个 pending 申请；申请默认 15 分钟过期。

## 状态机

```text
                  第二人批准且版本一致
pending ------------------------------------> approved
   |
   | expires_at <= database now()
   v
expired
```

approved 和 expired 都是终态。重复批准返回 409，不会再次生成有效 Key。

## 为什么不用“前端审批按钮”

审批约束位于数据库事务，curl、脚本或被篡改的前端都无法绕过。前端未来只负责展示 pending 状态和引导第二人操作，不是安全边界。

## 一致性选择

- PostgreSQL partial unique index 保证一个 Key 只有一个 pending 申请。
- `SELECT ... FOR UPDATE` 串行化同一申请和 Key 的竞争批准。
- Key version 是申请时快照；等待审批期间若权限或状态已变化，批准失败，必须重新申请。
- 过期判断使用 PostgreSQL `now()`，避免网关实例时钟差导致错误批准。
- 原始新 Key 只在成功批准响应中返回一次；申请阶段不提前生成或保存新 Key。

## 未选择方案

| 方案 | 未选择原因 |
|---|---|
| RBAC 角色自动拥有全部租户 | 违反最小权限，跨租户影响面过大 |
| 查询全量后在 Node 过滤 | 数据已离开数据库，容易因新接口漏过滤 |
| 申请人自己确认两次 | 不能抵御账号被盗和单人误操作 |
| 邮件/IM 点链接后直接轮换 | 外部通知不是权威事务状态，重放和并发难控制 |
| 审批时忽略 Key version | 等待期间的权限修改可能被旧申请覆盖 |
| 无限期 pending | 旧批准可以在上下文变化很久后突然执行 |

## 后果与限制

- 企业 IdP 必须把租户范围放入 Token，并维护人员与租户的关系。
- 同租户至少要有两名 admin，否则开启审批后无法轮换。
- 当前只有 tenant 粒度，不能限制到 project/application/key。
- 管理员租户范围也是 JWT 快照，在 Token 过期前不会因 IdP 修改立即收回。
- 没有 reject/cancel API；不批准的申请等待过期。
