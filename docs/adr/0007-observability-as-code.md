# ADR 0007：以代码管理 SLI、Dashboard 与告警

- 状态：Accepted
- 日期：2026-07-15

## 背景

Iteration 6 已经暴露低基数指标，但只有 `/metrics` 不等于系统可运营。不同工程师如果在 UI 中各自写 PromQL、Dashboard 和告警，环境间会漂移，阈值没有 Review 记录，故障时也无法确认某个面板是否代表统一口径。

直接针对原始指标写每条告警还会重复复杂表达式。一次短暂 5xx 或低流量下的单次失败，不应立刻通知值班人员，否则告警噪声会让真正事故被忽略。

## 决策

1. Prometheus 抓取、Recording Rule、Alert Rule、Alertmanager 和 Grafana Provisioning 全部作为代码进入仓库。
2. 固定 Prometheus 3.12.0、Alertmanager 0.32.1 和 Grafana 13.1.0，不使用 `latest`。
3. 先用 Recording Rule 将原始指标转换为稳定 SLI（服务水平指标），Dashboard 和 Alert 尽量复用该 SLI。
4. 可用性只把 5xx 视为网关失败；401/403/404/429 是明确的客户端或治理结果，不直接降低网关可用性。
5. 高错误率告警同时要求最小流量和持续时间；短抖动只留在图表，不立刻升级。
6. Target Down 为 critical；Provider 错误率、熔断、活跃请求和配额拒绝为 warning，后续由业务 SLO 审批调整。
7. Alertmanager 按 alert/service/model/deployment 分组；Target Down 时抑制同服务的次生告警。
8. Dashboard 使用文件 Provisioning，默认不可在 UI 持久修改；修改必须回到 JSON 和 Code Review。
9. Metrics Token 通过 Docker credentials file 挂载；开发样例可提交，真实生产 Secret 文件必须被忽略。
10. Promtool 合成时间序列测试是告警验收的一部分，不能只检查 YAML 能否解析。

## 前端类比

Recording Rule 类似前端 Selector：把原始 Redux state 转换成稳定 ViewModel，多个组件和规则复用同一个定义。Dashboard-as-Code 类似 Storybook/组件代码进入 Git，而不是只在某个人浏览器里手工搭页面。

告警的 `for: 10m` 类似防抖，但它要求条件持续成立，而不是简单延迟发送。最小流量门槛类似只有样本量足够时才展示实验结论。

## 后果

正面结果：本地一条命令可复现监控栈；Dashboard、SLI、告警和版本可 Review；PromQL 有官方工具验证；新人能按 Runbook 处理告警。

代价：Grafana UI 临时修改会被 Provisioning 覆盖；固定版本需要主动升级；本地 Receiver 不会真的通知外部系统；阈值仍是工程初始值，不代表业务已经批准正式 SLO。

## 被否决的替代方案

- 只在 Grafana UI 创建面板和告警：难以 Review、复制、回滚和防止环境漂移。
- 所有 4xx 都算不可用：会把调用方错误、权限拒绝和企业限额误判为网关宕机。
- 单次失败立即告警：低流量和偶发网络抖动会产生大量噪声。
- 把开发 Metrics Token 直接写进 Prometheus YAML：容易形成生产复制粘贴泄密。
- 使用 `latest` 镜像：同一提交在不同时间启动会得到不同软件版本。

## 复审触发条件

生产试运行获得 2–4 周真实流量后，应根据延迟分布、业务等级和误报情况复审阈值、窗口、严重度与通知路由。接入 Kubernetes、托管 Prometheus 或 Grafana Cloud 时也需复审部署形式，但保留 Observability-as-Code 原则。

## 官方依据

- Prometheus 配置与抓取：[prometheus.io](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)
- Alertmanager 配置：[prometheus.io](https://prometheus.io/docs/alerting/latest/configuration/)
- Grafana Provisioning：[grafana.com](https://grafana.com/docs/grafana/latest/administration/provisioning/)
