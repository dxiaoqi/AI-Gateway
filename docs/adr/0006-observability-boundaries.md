# ADR 0006：低基数指标、独立 Metrics 凭据与 W3C Trace

- 状态：Accepted
- 日期：2026-07-15

## 背景

前五轮已经能认证、限额、路由和故障切换，但运营人员仍无法回答：哪个部署失败最多、切换是否发生、流式请求是否堆积、Token 使用量如何、一次客户端请求经过了哪些系统。

直接记录更多日志不足以解决聚合告警；不受约束地给 Prometheus 添加 Tenant、request id 或 Prompt 标签，又会为每个请求创建新时间序列，导致监控系统内存和存储成本失控。Metrics 还包含全公司的模型与错误分布，不能让任意业务 Key 读取。

## 决策

1. 网关原生暴露 Prometheus text exposition 格式，不在第一版绑定某个监控厂商。
2. 只使用配置枚举或有限集合做标签：HTTP method/route/status、逻辑模型、部署、Provider、stream、outcome、错误码、Token 方向与 estimated。
3. 明确禁止 request id、trace id、Tenant、Project、Application、Key、Prompt、原始 URL 和错误消息成为指标标签。
4. `/metrics` 使用独立 `METRICS_BEARER_TOKEN`，不接受业务虚拟 Key；生产启用时要求显式配置强 Token。
5. HTTP 和 Provider 延迟用 Histogram，计数用 Counter，活跃 Provider 请求用 Gauge。
6. 每个真实上游尝试单独记录。一次请求主失败、备成功必须表现为两个 Provider attempt，而不是一个成功请求。
7. 接受 W3C `traceparent` 版本 00：保留合法 trace id，生成网关 span id；非法或缺失时生成新上下文。
8. 网关把当前 `traceparent` 返回给客户端、写入结构化日志，并传给 OpenAI-compatible Provider。
9. 本轮不引入 OpenTelemetry SDK；当前实现是 Trace 关联基础，不声明已经产生或导出完整 Span。

## 前端类比

Counter 类似埋点事件总数；Gauge 类似当前购物车数量，可增可减；Histogram 类似把 Web Vitals 按延迟区间统计，以便计算 P95，而不是为每个用户创建一个变量。

`traceparent` 类似前端在 Axios interceptor 中携带 correlation id，但格式是跨厂商标准，并区分整条 trace 与当前 span。它不是登录 Token，也不用于授权。

## 后果

正面结果：Prometheus 可以抓取稳定指标；故障切换、熔断事件和 Token 可聚合告警；客户端与 Provider 日志可按 trace id 关联；监控凭据与业务权限分离。

代价：进程内 Counter 在重启后清零，由 Prometheus 保存历史；没有 OpenTelemetry Collector 时无法看到 Span 瀑布图；内置 Histogram bucket 是统一值，未针对每个模型调优；独立 Token 需要安全分发和轮换。

## 被否决的替代方案

- 将 request id 或 Tenant 作为 Prometheus label：时间序列数量随请求/客户增长，没有上界。
- 允许所有业务 Key 访问 Metrics：会泄露其他团队的模型、错误与用量趋势。
- 只写日志、不提供 Metrics：无法高效计算速率、分位数和告警。
- 第一版直接绑定云厂商 APM：降低可移植性，并在指标边界尚未稳定时引入较大依赖面。
- 把 Trace id 当认证凭据：Trace Header 来自调用方，可伪造，只能用于关联。

## 复审触发条件

当接入 OpenTelemetry Collector、需要 exemplar、费用指标、多进程聚合、mTLS 抓取或真实 SLO Dashboard 时复审本决策。
