# Iteration 6：Prometheus 指标与 W3C Trace 关联

- 版本：0.6.0
- 日期：2026-07-15
- 状态：Completed
- 关联 ADR：[ADR 0006](../adr/0006-observability-boundaries.md)

## 一句话说明

这一轮让网关从“出问题后靠猜”变成可以量化请求、Provider、路由和 Token，并能用同一个 trace id 串起调用链。

## 30 秒领导摘要

| 领导关心的问题 | 回答 |
|---|---|
| 以前的问题 | 虽然网关能切换部署，但无法持续回答成功率、延迟、故障部署、活跃请求和 Token 趋势。 |
| 本轮交付 | 受独立凭据保护的 Prometheus `/metrics`；HTTP/Provider/路由/Token 指标；W3C Trace 接收、回传、日志关联和 Provider 透传。 |
| 业务价值 | 运维可以建立可用性与容量告警；研发可以从客户端请求追到实际部署；管理者能看到模型用量趋势。 |
| 如何证明 | 57 项默认测试通过；本地编译产物 smoke 同时验证 HTTP、SSE 和 Metrics；不调用真实模型。 |
| 最大剩余风险 | 当前只有 Trace 上下文，没有 OpenTelemetry Span/Collector；指标是单进程累积值，需要 Prometheus 定期抓取。 |

### 最短演示

```bash
npm run verify
npm start
```

另一个终端：

```bash
npm run smoke
curl http://127.0.0.1:3000/metrics \
  -H 'Authorization: Bearer local-development-metrics-key'
```

## 新人前置知识与术语

### 阅读前只需要知道

- 日志适合查看一次具体事件；指标适合计算每分钟错误率、P95 延迟和告警。
- Prometheus 定期访问 `/metrics`，读取纯文本时间序列。
- 一次用户操作可能经过浏览器、BFF、AI Gateway 和模型 Provider。
- HTTP Header 可以携带不影响业务 JSON 的调用链上下文。

### 术语表

| 术语 | 小白解释 | 前端类比 |
|---|---|---|
| Counter | 只增不减的累计数，进程重启会从 0 开始 | 页面埋点的累计点击次数 |
| Gauge | 可增可减的当前值 | React state 中当前上传任务数 |
| Histogram | 把数值放进固定区间，计算 P95/P99 | Web Vitals 延迟分桶，而不是保存每次原始值 |
| Label | 一条指标的可聚合维度 | 埋点属性，例如 route、status；不能放无限变化的数据 |
| Cardinality | Label 组合产生的时间序列数量 | 给每个用户创建一个 Redux store key；用户越多内存越大 |
| Trace | 一次调用跨多个服务的完整链路 | 一次页面操作从 fetch 到多个 BFF 请求的共同上下文 |
| Span | Trace 中某一段工作 | Chrome Performance 面板中的一个任务区间 |
| `traceparent` | W3C 定义的 Trace Header | 标准化 correlation id，但还包含 span id 和 flags |
| P95 | 95% 请求不超过的延迟 | 比平均值更能暴露少量特别慢的请求 |

## 前端类比：为什么日志和指标都需要

前端报错平台里，一条 Sentry event 能告诉你某用户在哪里报错；Dashboard 能告诉你今天错误率是否从 0.2% 升到 5%。网关也一样：结构化日志定位某个 request/trace，Prometheus 指标判断整体是否异常。

不能把 request id 放进 Prometheus Label。它相当于把每个用户操作都变成一张永久独立的图；Prometheus 无法复用时间序列，内存与磁盘随请求量持续增长。request id 和 trace id 应留在日志中。

## 一次请求逐步发生了什么

以带有 `traceparent` 的非流式请求为例：

1. 浏览器或 BFF 发送 `traceparent: 00-<trace-id>-<caller-span-id>-01`。
2. 网关校验格式。合法时保留 trace id、生成新的 gateway span id；非法或缺失时生成全新 trace。
3. 网关立即把新的 `traceparent` 设置到响应 Header，错误响应也能获得。
4. 认证、ACL、配额和路由照常执行，安全决策不依赖 Trace Header。
5. ModelRouter 真正调用一个 Deployment 前：Provider active Gauge +1。
6. OpenAI-compatible Adapter 把网关 `traceparent` 放入上游请求 Header。
7. Provider 成功或失败时：active -1；尝试 Counter +1；Duration Histogram 记录本次部署耗时。
8. 如果主部署失败、备用成功，指标中会出现主部署 error 和备用 success 两条 attempt。
9. Provider 返回 Usage 时，分别增加 input/output Token Counter，并标记是否 estimated。
10. HTTP 响应完成时记录 method、路由模板、status 和完整 HTTP 延迟。
11. 结构化日志同时包含 request id 和 trace id，排障人员可以精确搜索。

### 流式请求的区别

Provider active Gauge 从开始连接上游时 +1，直到流式迭代器结束或报错才 -1。因此它代表仍占用上游连接的请求，而不是只统计“等待首 Token”的时间。

流式 Usage 事件到达时记录 Token。如果 Provider 不返回 Usage，配额仍会保守结算，但本轮不会把预留量冒充成 Provider Usage 指标。

## 目标

- 提供 Prometheus 兼容 Metrics Endpoint。
- Metrics 使用独立凭据并支持关闭。
- 记录 HTTP 数量、状态和延迟。
- 把每次 Provider 尝试独立记录为成功或失败。
- 记录 Provider 活跃请求、延迟、Token 和路由健康事件。
- 标签保持低基数，不包含用户输入或唯一请求标识。
- 支持 W3C Trace 上下文延续、回传、日志关联和 Provider 透传。
- 自动测试权限、安全边界、失败切换和流式生命周期。

## 非目标

- OpenTelemetry SDK、Span Processor 或 OTLP 导出。
- Prometheus Server、Grafana、Alertmanager 的实际部署。
- 现成 Dashboard 和 SLO 告警规则。
- 按 Tenant/Project 的 Prometheus Label。
- 金额成本指标和 Provider 价格版本。
- Trace 采样决策、baggage、tracestate 和 exemplar。
- Metrics 多进程合并或进程重启持久化。

## 详细设计

### 指标清单

| 指标 | 类型 | 主要标签 | 回答的问题 |
|---|---|---|---|
| `aigw_http_requests_total` | Counter | method, route, status | 每个接口成功/失败多少次？ |
| `aigw_http_request_duration_seconds` | Histogram | method, route | 网关端到端延迟分布如何？ |
| `aigw_errors_total` | Counter | code | 哪类标准错误增长最快？ |
| `aigw_provider_requests_active` | Gauge | model, deployment, provider, stream | 当前多少上游请求仍未结束？ |
| `aigw_provider_requests_total` | Counter | 上述标签 + outcome/error_code | 哪个部署成功/失败多少次？ |
| `aigw_provider_request_duration_seconds` | Histogram | model, deployment, provider, stream | Provider 尝试耗时如何？ |
| `aigw_routing_events_total` | Counter | model, deployment, event | 冷却、熔断、半开和恢复发生多少次？ |
| `aigw_tokens_total` | Counter | model, deployment, direction, estimated | 输入/输出 Token 使用趋势如何？ |

Histogram 使用秒作为单位，Bucket 为 10ms、25ms、50ms、100ms、250ms、500ms、1s、2.5s、5s、10s 和 30s。Prometheus Histogram bucket 是累积计数。

### 为什么 HTTP 使用路由模板

记录 `/v1/chat/completions` 是低基数；记录原始 URL 可能包含资源 ID、查询参数甚至敏感信息，会产生大量序列。Fastify 的 `request.routeOptions.url` 提供路由模板，未知路由统一记为 `unmatched`。

### Metrics 权限模型

`/metrics` 暴露全局 Provider、错误和用量趋势，不属于某个 Tenant。它不走普通虚拟 Key，而检查独立 `METRICS_BEARER_TOKEN`：

- 开发默认 Token 只为本机体验。
- 生产启用 Metrics 时必须显式配置至少 32 字符。
- 业务 Key 请求 `/metrics` 返回 401。
- `METRICS_ENABLED=false` 时不注册接口；带业务认证访问得到 404。
- 实际部署还应通过内网、Security Group、Kubernetes NetworkPolicy 或 mTLS 限制抓取来源。

Token 比较使用固定时间比较，并且日志不记录 Authorization。

### Provider Attempt 与 HTTP Request 的区别

一次 HTTP Request 可能发生：

```text
HTTP request 1 次
├── primary provider attempt：error
└── secondary provider attempt：success
```

所以 HTTP 成功率高不代表主 Provider 健康。必须把 Provider 尝试单独计数，才能发现备用部署正在悄悄承担全部流量。

### Trace 生成规则

当前接受版本 00 的标准格式：

```text
00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01
│  │                                │                └ trace flags
│  │                                └ caller span id（16 hex）
│  └ trace id（32 hex）
└ version
```

网关保留合法且非全 0 的 trace id，使用加密随机数生成新的 16 位十六进制 span id。Trace flags 原样延续。Trace Header 可以由客户端伪造，因此只用于关联，绝不授权。

严格来说，本轮生成的是可传播的当前上下文；因为尚未创建 OpenTelemetry Span 和 exporter，所以不能宣称已有完整分布式追踪。

### 失败行为

- Metrics Registry 写入是进程内同步操作，不访问网络，不让监控系统故障阻塞业务请求。
- Prometheus 未抓取不会影响网关；只会丢失这段历史趋势。
- Provider 失败仍先转换成统一错误码，再作为有限的 `error_code` Label。
- 下游断连导致流式结束会记录 error attempt，但非 Provider 错误不会触发熔断。
- 进程重启 Counter 清零；Prometheus 对 Counter reset 有标准处理。

## 代码导读

| 文件 | 新人应该看什么 |
|---|---|
| `src/observability/metrics.ts` | Counter/Gauge/Histogram 如何在内存聚合并输出 Prometheus 文本。 |
| `src/observability/types.ts` | Router 与监控实现之间的小接口，避免 Router 依赖 Prometheus。 |
| `src/observability/trace.ts` | `traceparent` 校验、延续和随机 Span ID。 |
| `src/server/routes/metrics.ts` | 独立 Bearer Token 和 text exposition 响应。 |
| `src/routing/model-router.ts` | 每个真实 Provider attempt 的开始、结束、Token 和健康事件。 |
| `src/server/app.ts` | Trace Hook、HTTP 指标 Hook、错误指标和结构化日志。 |
| `src/providers/openai-compatible/provider.ts` | Trace Header 如何继续传给模型服务。 |
| `test/metrics-http.test.ts` | Metrics 权限、核心内容、流式 active 归零和敏感信息检查。 |

推荐新人先读 `metrics-http.test.ts` 看外部行为，再读 MetricsRegistry，最后看 Router 如何发送观察事件。

## 测试与证据

### 自动测试矩阵

| 场景 | 证据 |
|---|---|
| 缺少 Metrics Token 被拒绝 | HTTP 401 测试 |
| 业务 Key 不能读取 Metrics | 独立权限测试 |
| Metrics 可完全关闭 | 带业务认证访问 404 测试 |
| HTTP/Provider/Token 指标可抓取 | Mock 完整请求后 scrape |
| Prompt 和业务 Key 不出现在 Metrics | 负向字符串断言 |
| 主失败、备成功分别计数 | 路由 HTTP 测试 |
| 流式 Provider active 最终归零 | 流式请求后 Gauge=0 |
| 熔断、半开、恢复事件有指标 | 可控时钟 Router 测试 |
| 合法 Trace 保留 trace id 并换 span | HTTP Header 测试 |
| Trace 继续传给 Provider | 可注入 Fetch Client 测试 |
| 生产缺少强 Metrics Token 拒绝启动 | Config 测试 |

### 本轮实际验证证据

```text
Typecheck: passed
Default tests: 57 passed, 2 Redis tests skipped
Test files: 13 passed, 1 Redis integration file skipped
Production build: passed
Compiled process smoke: passed (readiness, model ACL, non-streaming, SSE, protected Prometheus metrics)
External Provider: not called; no model cost incurred
```

## 已知限制与业务影响

- 没有 OpenTelemetry Span：可以按 trace id 搜日志，但还没有自动瀑布图、父子 Span 时长和 OTLP 导出。
- 指标在单进程内：Prometheus 必须抓所有实例并在查询时聚合；重启前未抓取的数据会丢失。
- 没有预置 Dashboard/Alert：指标存在不等于已经有人收到告警，生产上线前必须配置规则和责任人。
- Token 依赖 Provider Usage：不返回 Usage 的流式 Provider 不会进入 Token 指标，不能用于财务对账。
- 没有货币成本：不同部署 Token 单价不同，Token 趋势不能直接等同预算金额。
- Histogram bucket 固定：超低延迟本地模型或超过 30 秒的长模型需要根据真实分布调整。
- 独立 Bearer Token 仍是静态凭据：需要 Secret Manager、轮换和网络隔离；长期可升级为 mTLS。
- `traceparent` 可由外部伪造：不能把 trace id 当可信用户身份或审计主体。
- 没有 Tenant Label 是刻意的安全/容量边界：团队级用量报表应进入受控分析/账单存储，而不是直接扩张 Prometheus 标签。

## 领导 Review 问题

- 第一批 SLO 是网关整体可用性，还是按逻辑模型/部署分别定义？
- Provider 切换率达到多少需要告警？由谁值班响应？
- Token 数据只用于趋势，还是需要升级到财务级金额对账？
- Metrics 抓取是否位于可信内网，是否要求 mTLS？
- 下一轮优先接 OpenTelemetry/Grafana，还是先做 PostgreSQL 控制面？

## 工程师 Review 清单

- [ ] Label 是否都来自有限集合或配置，而不是每请求唯一值？
- [ ] request id、trace id、Tenant、Key、Prompt 是否只在合适的日志/业务存储中？
- [ ] Provider active 在成功、错误、超时和流式结束后都能归零？
- [ ] 主备尝试是否分别计时和计数？
- [ ] `/metrics` 是否不能使用业务虚拟 Key？
- [ ] 生产 Metrics Token 是否强制且长度足够？
- [ ] Trace Header 是否不参与认证与 ACL？
- [ ] 响应、日志和 Provider 是否使用同一个 trace id？
- [ ] 当前能力是否被准确描述为 Trace 关联，而非完整 OpenTelemetry？
