# 项目设计与 Review 索引

本目录是 AI Gateway 的可审计工程记录。代码回答“现在如何工作”，迭代记录回答“本轮为什么这样做、验证过什么、还缺什么”，ADR 回答“关键架构选择为什么成立”。

未完成能力、优先级和建议迭代统一维护在 [待实现能力清单](./BACKLOG.md)，不再只依赖各轮文档末尾的零散“已知限制”。

需要从平台全景开始 Review 时，先读 [Enterprise AI Gateway 平台总设计](./PLATFORM_ARCHITECTURE.md)：它从部署拓扑、数据面和控制面一直拆到安全、存储、运维、代码地图和未实现路线。

默认读者是传统前端背景的新工程师和需要做决策的领导。文档写法遵循 [面向领导与前端新人的记录规范](./WRITING_AND_REVIEW_GUIDE.md)，不要求预先理解网关或分布式系统。

## 当前基线

| 迭代 | 版本 | 状态 | 主题 | 记录 |
|---|---:|---|---|---|
| Iteration 1 | 0.1.0 | Completed | 工程骨架、Canonical Schema、Mock Provider | [详细记录](./iterations/iteration-01-foundation.md) |
| Iteration 2 | 0.2.0 | Completed | OpenAI-compatible Provider、SSE、取消与背压 | [详细记录](./iterations/iteration-02-streaming-provider.md) |
| Iteration 3 | 0.3.0 | Completed | 虚拟 Key、租户上下文、模型 ACL | [详细记录](./iterations/iteration-03-identity-acl.md) |
| Iteration 4 | 0.4.0 | Completed | RPM/TPM/并发、预留结算、Redis 原子配额 | [详细记录](./iterations/iteration-04-resource-governance.md) |
| Iteration 5 | 0.5.0 | Completed | 多部署路由、失败切换、冷却与熔断 | [详细记录](./iterations/iteration-05-routing-reliability.md) |
| Iteration 6 | 0.6.0 | Completed | Prometheus 指标、Trace 关联与 Provider 透传 | [详细记录](./iterations/iteration-06-observability.md) |
| Iteration 7 | 0.7.0 | Completed | Prometheus/Grafana/Alertmanager、SLO 与告警 | [详细记录](./iterations/iteration-07-observability-operations.md) |
| Iteration 8 | 0.8.0 | Completed | PostgreSQL 虚拟 Key 控制面、轮换与审计 | [详细记录](./iterations/iteration-08-postgresql-control-plane.md) |
| Iteration 9 | 0.9.0 | Completed | 管理员 OIDC/JWT 身份、RBAC 与个人审计 | [详细记录](./iterations/iteration-09-admin-oidc-rbac.md) |
| Iteration 10 | 0.10.0 | Completed | Tenant Scope、默认拒绝与双人 Key 轮换审批 | [详细记录](./iterations/iteration-10-tenant-scope-approval.md) |
| Iteration 11 | 0.11.0 | Completed | Next.js 管理后台、受限 BFF 与可视化控制面 | [详细记录](./iterations/iteration-11-nextjs-admin-console.md) |
| Iteration 12 | 0.12.0 | Completed | OIDC Code + PKCE、服务端 Session、CSRF 与退出 | [详细记录](./iterations/iteration-12-admin-oidc-session.md) |
| Iteration 13 | 0.13.0 | Completed | 审批拒绝/撤销、决策理由、状态筛选与站内通知 | [详细记录](./iterations/iteration-13-approval-closure-notifications.md) |
| Iteration 14 | — | Deferred | 外部通知 Outbox（按产品优先级后置） | — |
| Iteration 15 | 0.15.0 | Completed | 模型部署目录、凭证引用与热发布 | [详细记录](./iterations/iteration-15-model-deployment-management.md) |
| Iteration 16 | 0.16.0 | Completed | 动态配额策略管理与请求执行 | [详细记录](./iterations/iteration-16-quota-policy-management.md) |
| Iteration 17 | 0.17.0 | Completed | Token 定价、用量聚合与月度预算 | [详细记录](./iterations/iteration-17-cost-budget-governance.md) |
| Iteration 18 | 0.18.0 | Completed (Baseline) | 企业安全护栏与请求前阻断 | [详细记录](./iterations/iteration-18-enterprise-guardrails.md) |
| Iteration 19 | 0.19.0 | Completed | 主组织 Owner 首次注册与密码登录 | [详细记录](./iterations/iteration-19-local-owner-bootstrap.md) |
| Iteration 20 | 0.20.0 | Completed | 主组织注册与登录界面可用性修复 | [详细记录](./iterations/iteration-20-local-auth-ui-polish.md) |

## 如何 Review

1. 领导先读“30 秒领导摘要”和“已知限制与业务影响”。
2. 新工程师先读“前端类比”和“一次请求逐步发生了什么”。
3. 执行 [验证手册](./VERIFICATION.md) 中的零成本自动验证和本地演示。
4. 对照“代码导读”检查模块边界。
5. 对照“测试矩阵”确认失败路径，而不只检查 happy path。
6. 阅读关联 ADR，重点挑战其约束、代价与替代方案。

## ADR

- [ADR 0001：用 Canonical Schema 隔离 Provider](./adr/0001-canonical-provider-boundary.md)
- [ADR 0002：用 Canonical Stream Event 驱动端到端 SSE](./adr/0002-streaming-and-cancellation.md)
- [ADR 0003：虚拟 Key 身份上下文与模型 ACL](./adr/0003-virtual-key-identity-and-model-acl.md)
- [ADR 0004：调用前配额预留与调用后结算](./adr/0004-quota-reservation-and-settlement.md)
- [ADR 0005：只在流式首事件前进行部署切换](./adr/0005-routing-and-pre-stream-fallback.md)
- [ADR 0006：低基数指标与独立 Metrics 凭据](./adr/0006-observability-boundaries.md)
- [ADR 0007：以代码管理 SLI、Dashboard 与告警](./adr/0007-observability-as-code.md)
- [ADR 0008：用 PostgreSQL 事务实现强一致虚拟 Key 生命周期](./adr/0008-strongly-consistent-key-lifecycle.md)
- [ADR 0009：管理 API 使用 OIDC JWT 身份与路由级 RBAC](./adr/0009-oidc-admin-identity-and-rbac.md)
- [ADR 0010：租户范围授权与双人 Key 轮换](./adr/0010-tenant-scope-and-two-person-rotation.md)
- [ADR 0011：独立 Next.js 管理后台与受限 BFF](./adr/0011-nextjs-admin-console-and-bff.md)
- [ADR 0012：OIDC BFF 与服务端不透明 Session](./adr/0012-oidc-bff-server-session.md)
- [ADR 0013：事务内租户通知与独立已读回执](./adr/0013-tenant-notification-inbox.md)
- [ADR 0015：统一治理资源与运行时执行](./adr/0015-governance-resources-and-runtime-enforcement.md)
- [ADR 0016：首次启动主组织 Owner 与本地密码认证](./adr/0016-local-owner-bootstrap.md)

## 值班手册

- [可观测性与告警值班手册](./runbooks/observability-oncall.md)
- [虚拟 Key 控制面操作手册](./runbooks/control-plane-key-operations.md)
- [管理员 OIDC 与 RBAC 运维手册](./runbooks/admin-oidc-rbac.md)
- [租户访问与双人 Key 轮换手册](./runbooks/tenant-access-and-rotation-approval.md)
- [Next.js 管理后台操作手册](./runbooks/admin-console.md)
- [模型、配额、预算与 Guardrail 操作手册](./runbooks/governance-operations.md)

## 后续迭代规则

每轮开始时复制 [迭代记录模板](./iterations/TEMPLATE.md)，先写领导摘要、前端类比、目标、非目标、威胁与验收标准，再开始实现。结束时补齐逐步请求流、实际代码落点、测试证据、手工验证结果、偏差与已知限制。

完成定义：

- 类型检查、自动测试、生产构建全部通过。
- 新能力至少有一个成功路径和一个关键失败路径测试。
- 网络/流式/分布式能力有真实进程或依赖的冒烟验证。
- 安全敏感配置不会出现在日志、测试快照或 Git 中。
- 新的重要架构选择有 ADR。
- README、环境变量样例、迭代记录同步更新。
