# AI Gateway 可观测性与告警值班手册

适用版本：0.7.0。

## 这份手册解决什么问题

收到告警时，值班人员不应先改代码或重启所有服务。本手册提供固定顺序：确认告警是真实的、判断影响范围、止损、收集证据、恢复并复盘。

## 入口

| 系统 | 本地地址 | 用途 |
|---|---|---|
| Grafana | `http://127.0.0.1:3001/d/aigw-overview/ai-gateway-overview` | 总览、趋势、部署对比 |
| Prometheus Targets | `http://127.0.0.1:9090/targets` | 判断抓取是否成功 |
| Prometheus Alerts | `http://127.0.0.1:9090/alerts` | 查看 Pending/Firing 和表达式 |
| Alertmanager | `http://127.0.0.1:9093` | 查看分组、静默和通知状态 |

生产地址、值班群、工单系统和负责人必须由部署团队补充，不能沿用 localhost。

## 告警分级

| 告警 | 默认级别 | 首要含义 | 第一动作 |
|---|---|---|---|
| `AIGatewayTargetDown` | Critical | Prometheus 一分钟无法抓取网关 | 先查网关进程和网络，不要先判断业务错误率 |
| `AIGatewayHigh5xxRatio` | Critical | 有持续流量且 5xx 超过 5% 达十分钟 | 看 route/status、日志 trace id 和近期发布 |
| `AIGatewayHighLatency` | Warning | 某接口 P95 超过 5 秒达十分钟 | 对比 Gateway 与 Provider P95，定位等待发生在哪层 |
| `AIProviderHighErrorRatio` | Warning | 某部署错误率持续超过 20% | 看备用是否接管、错误码、供应商状态页 |
| `AIProviderCircuitOpened` | Warning | 部署五分钟内触发熔断 | 确认 deployment、fallback 成功率和认证/限流错误 |
| `AIProviderActiveRequestsHigh` | Warning | 某部署活跃请求超过 50 达十分钟 | 看流式占比、客户端断连、Provider 延迟和并发配额 |
| `AIGatewayQuotaRejectionsHigh` | Warning | 五分钟内配额拒绝超过 10 且持续 | 判断真实容量不足还是单个应用异常流量 |

## 通用处理流程

1. 记录告警开始时间、名称、severity、logical_model、deployment 和 instance。
2. 打开 Grafana，时间范围设为告警前 15 分钟到当前。
3. 在 Prometheus Targets 确认 Target 是否 Up；如果 Down，其他面板可能只是旧数据。
4. 比较 HTTP 5xx、Gateway P95、Provider error/P95、active requests 和路由事件。
5. 从结构化日志选择一个失败请求，用 trace id 关联网关与 Provider。
6. 判断影响：全部模型、单逻辑模型、单部署、单 Tenant，还是单个调用方错误。
7. 只执行已授权、可回滚的止损动作，例如下调故障部署权重、切到已批准备用或限制异常应用。
8. 观察至少一个完整告警窗口，确认指标恢复，而不是看到一个成功请求就结束。
9. 记录根因、止损动作、恢复时间、用户影响和待办。

## Target Down 专项

依次检查：

```bash
curl http://127.0.0.1:3000/health/ready
curl http://127.0.0.1:3000/metrics \
  -H 'Authorization: Bearer local-development-metrics-key'
docker compose --profile observability ps
```

- Health 失败：网关进程或依赖故障。
- Health 成功、Metrics 401：Prometheus credentials file 与网关 Token 不一致。
- 本机 Metrics 成功、Prometheus Target Down：检查容器到 Host 的网络和 `host.docker.internal`。
- Target Up、Grafana 无数据：检查数据源和 Dashboard 查询时间范围。

## Provider 故障专项

重点对比：

- `aigw:provider_error_ratio5m`
- `aigw:provider_attempt_rate5m` 按 outcome
- `increase(aigw_routing_events_total[5m])`
- `aigw:provider_latency_p95_seconds5m`

如果主部署 error 上升但 HTTP 仍成功，说明备用正在接管。这不是“没有事故”，而是冗余容量正在被消耗；应在备用耗尽前修复主部署。

认证错误通常不是供应商临时故障。检查 Secret 版本、权限和过期时间，不要通过无限增加重试掩盖配置错误。

## 告警静默规则

- 只对已确认的维护窗口或重复告警创建 Silence。
- Silence 必须有创建人、原因、工单和到期时间。
- 不要为了“让面板变绿”静默未知根因。
- Target Down 会抑制同一服务的次生告警，这是配置行为；恢复抓取后应重新观察其他规则。

## 本地故障演练

### 不停止服务的规则演练

```bash
npm run test:observability
```

Promtool 使用合成时间序列验证 Target Down 和 Circuit Open 告警，不影响真实网关。

### Target Down 真实演练

1. 保持监控栈运行。
2. 手工停止本地网关进程。
3. 在 Prometheus Targets 观察 Target Down。
4. 一分钟后在 Alerts/Alertmanager 观察 `AIGatewayTargetDown`。
5. 重新启动网关，确认 Target 恢复 Up，告警随后 Resolve。

不要在共享或生产环境执行这项演练，除非已有变更审批和流量隔离。

## 复盘模板

```text
告警：
开始/发现/恢复时间：
影响模型与部署：
影响请求与用户范围：
根因：
自动切换是否生效：
止损动作：
为什么现有测试/告警没有更早发现：
需要调整的阈值或 Dashboard：
负责人和截止时间：
```
