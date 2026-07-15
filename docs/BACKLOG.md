# AI Gateway 待实现能力清单

- 基线版本：0.20.0
- 更新日期：2026-07-15
- 维护方式：每轮完成后更新状态、证据和下一步，不以口头承诺代替验收

## 30 秒领导摘要

当前系统已经具备“可运行的企业 AI Gateway 基线”：模型接入、流式转发、虚拟 Key、多租户权限、配额、路由容错、审计、OIDC、管理后台、预算和基础 Guardrail 都能运行。

剩余工作主要不是再做一个代理接口，而是把现有能力提升为可供多人、多实例、长期运营的企业产品。下一阶段建议优先完成管理后台成员体系和生产控制面，再推进高级安全、成本对账与可观测性增强。Anthropic 原生协议继续暂缓。

## 状态怎么读

| 状态 | 小白解释 |
|---|---|
| Planned | 已确认需要做，等待进入某一轮开发 |
| Deferred | 明确暂缓，不进入近期迭代 |
| External | 依赖公司平台、IdP 或运维团队共同完成 |
| Baseline exists | 已有基础版本，下面记录的是生产化增强，不是从零开始 |

## 建议迭代顺序

| 建议迭代 | 优先级 | 主题 | 主要交付 | 为什么先做 | 状态 |
|---|---|---|---|---|---|
| Iteration 21 | P0 | 主组织成员与账号管理 | PostgreSQL 账号仓库、邀请成员、角色分配、停用账号、密码重置流程 | 当前只有唯一 Owner，无法形成多人管理与双人审批闭环 | Planned |
| Iteration 22 | P0 | 多实例控制面一致性 | 配置版本缓存、失效广播、模型部署热发布广播、共享路由健康状态 | 单实例能运行，但多实例可能看到不同配置或健康状态 | Planned |
| Iteration 23 | P0 | Secret 与服务身份 | Secret Manager 适配、Provider 凭证版本、BFF→Gateway mTLS/服务身份、Pepper 轮换 | 生产不能长期依赖环境变量和内部明文 HTTP | Planned / External |
| Iteration 24 | P1 | 管理后台规模化体验 | Cursor 分页、服务端搜索、完整模型部署编辑、批量操作、空状态与错误详情 | 当前适合小规模运营，大租户数据量增长后体验不足 | Planned |
| Iteration 25 | P1 | 高级 Guardrail | 输出检查、企业 DLP/内容审核适配、脱敏、例外审批、安全事件指标 | 当前正则基线不能覆盖复杂敏感数据和多模态输入 | Planned / External |
| Iteration 26 | P1 | 成本与预算准确性 | 原子预算预留、日/项目/应用预算、预警、汇率、退款、供应商账单对账 | 当前金额是网关估算，高并发时可能短暂超预算 | Planned |
| Iteration 27 | P2 | Trace 与生产可观测性 | OpenTelemetry SDK/Collector、Trace Backend、告警阈值校准、监控 HA/备份 | 已有指标和 Trace ID，但还没有完整分布式 Span 与生产 HA | Planned / External |

## 详细待实现矩阵

| 能力域 | 当前已有 | 仍待实现 | 业务影响 | 优先级 |
|---|---|---|---|---|
| 本地管理员账号 | 唯一 Owner、scrypt、登录限速、短期 Token | 成员邀请、角色调整、账号停用、密码找回、MFA、数据库账号仓库、紧急 Token 吊销 | 目前适合首次落地和演示，不适合多人长期运营 | P0 |
| 企业身份 | OIDC Code+PKCE、RBAC、Tenant Scope | Refresh Token/会话续期、IdP logout、即时撤权或 introspection | 权限变更可能要等短 Token 到期才完全生效 | P1 |
| 控制面一致性 | PostgreSQL Key/治理资源、单实例热发布 | 跨实例失效广播、缓存版本、共享路由健康、变更事件 | 多实例可能暂时使用不同配置 | P0 |
| Secret 管理 | 凭证只保存环境变量引用，Key 仅返回一次 | Vault/云 Secret Manager、凭证轮换、访问审计、Pepper 在线轮换 | 环境变量运维成本高，轮换依赖人工 | P0 |
| 内部通信 | 同源 BFF、受限代理路径 | Next→Gateway TLS、服务身份、网络策略 | 当前本地 HTTP 不能直接视为生产边界 | P0 / External |
| 管理后台 | 总览、Key、模型、配额、预算、护栏、审批、通知、审计 | Cursor 分页、完整字段编辑、批量操作、导出、组织成员页面 | 超过数百条数据后操作效率下降 | P1 |
| 模型发布 | 模型目录、启停、运行时热发布 | 草稿、审批、定时发布、灰度、回滚、跨实例广播 | 高风险模型变更缺少正式发布流程 | P1 |
| 配额 | 四级 RPM/TPM/并发、Redis 原子计数 | 策略模拟、草稿审批、滑动窗口/令牌桶、缓存与失效广播 | 当前固定窗口在边界允许短时突发 | P1 |
| 成本预算 | 定价、月度聚合、租户预算硬阻断 | 原子预留、预警投递、多层预算、汇率、退款、账单 reconciliation | 高并发可能超限，财务不能直接用作结算依据 | P1 |
| Guardrail | 输入 PII/注入/安全正则策略 | 输出护栏、专业 DLP、图片/文件、脱敏、例外审批、评估集 | 不能替代企业 DLP 和专业内容安全平台 | P1 / External |
| 可观测性 | Prometheus、Grafana、Alertmanager、Trace ID | OTel Span/Collector、Trace Backend、真实值班 Receiver、阈值校准、HA/备份 | 本地闭环完整，生产运营仍需平台团队接入 | P2 / External |
| 路由 | 优先级、权重、失败切换、冷却、熔断 | 全局共享健康状态、自适应负载、区域/成本/延迟策略 | 多实例各自判断健康，流量决策不完全一致 | P1 |
| 审计与合规 | 管理操作审计、Actor、租户过滤 | 保留/归档策略、不可篡改存储、SIEM 投递、数据主体治理 | 长期合规和调查流程尚未形成 | P1 / External |
| API 能力 | OpenAI-compatible Chat Completions 与 SSE | Tool Calling 完整回归、Embeddings/Responses 等接口评估 | 当前主要覆盖对话生成场景 | P2 |

## 明确暂缓

| 能力 | 状态 | 重新启动条件 |
|---|---|---|
| Anthropic 原生 Messages 协议 | Deferred | 明确出现必须使用原生协议、且 OpenAI-compatible 适配不能满足的客户需求 |
| Iteration 14 外部邮件/IM/Webhook Outbox | Deferred | 确定企业通知渠道、责任团队、重试与死信保留要求 |

说明：预算预警、审批提醒等业务事件仍会产生站内记录；暂缓的是向飞书、钉钉、邮件或 Webhook 的可靠外部投递。

## 外部团队需要提供什么

| 团队 | 需要提供 | 没有它会怎样 |
|---|---|---|
| 身份平台 | OIDC Issuer、Client、Claim/Group 设计、MFA 与撤权策略 | 只能继续使用本地 Owner，无法接入企业统一身份 |
| Secret 平台 | Vault/云 Secret Manager、服务身份和轮换机制 | Provider 凭证继续依赖环境变量 |
| 数据库平台 | PostgreSQL HA、备份、恢复演练、迁移发布流程 | 控制面持久化无法达到生产 SLA |
| Redis 平台 | Redis HA、TLS、容量与故障策略 | 多实例配额和 Session 无法达到生产 SLA |
| 可观测性平台 | OTel Collector/Trace Backend、告警 Receiver、值班责任人 | 有指标但不能形成企业告警和追踪闭环 |
| 网络平台 | 域名、证书、WAF/Ingress、Next→Gateway 服务网络策略 | 只能保持本地端口部署方式 |

## 每轮完成定义

一个条目只有同时满足以下条件才从本清单移入“已完成”：

1. 成功路径和至少一个关键失败路径有自动化测试。
2. TypeScript 检查、Gateway 构建、Next.js 构建全部通过。
3. 涉及数据库、Redis、浏览器或多实例时，有对应真实进程验收。
4. 新人工程师能通过迭代文档理解请求经过哪些组件、失败时去哪里排查。
5. 领导能看到业务价值、剩余风险以及需要外部团队决定的事项。
