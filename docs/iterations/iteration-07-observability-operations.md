# Iteration 7：Prometheus、Grafana、Alertmanager 与 SLO 告警

- 版本：0.7.0
- 日期：2026-07-15
- 状态：Completed
- 关联 ADR：[ADR 0007](../adr/0007-observability-as-code.md)
- 值班手册：[可观测性与告警值班手册](../runbooks/observability-oncall.md)

## 一句话说明

这一轮把网关指标变成可启动的监控、统一 Dashboard、可测试告警和新人值班流程。

## 30 秒领导摘要

| 领导关心的问题 | 回答 |
|---|---|
| 以前的问题 | 有 Metrics，但没有统一看板、SLO 口径、告警规则和处理流程；“有数据”仍不等于“有人能运营”。 |
| 本轮交付 | 固定版本 Prometheus/Grafana/Alertmanager；9 条 SLI Recording Rule；7 条告警；11 面板 Dashboard；值班 Runbook。 |
| 业务价值 | 可持续观察可用性、延迟、Provider 故障和 Token；故障有分级、持续时间、抑制和固定排查顺序。 |
| 验证证据 | 61 项代码测试；promtool/amtool 全通过；真实三组件栈 Target Up、规则加载、查询成功；Grafana 页面视觉 QA 通过。 |
| 最大剩余风险 | 本地 Receiver 不向钉钉/飞书/PagerDuty 发消息；阈值是工程初值，尚未经过生产流量与业务方正式批准。 |

### 最短演示

网关已运行的前提下：

```bash
npm run test:observability
npm run observability:up
npm run observability:check
```

浏览器打开 `http://127.0.0.1:3001`，使用本地开发账号 `admin / local-admin-change-me`，应自动看到 `AI Gateway Overview`。

## 新人工程师导读

### 阅读前需要知道什么

- `/metrics` 是网关当前累计数据，Prometheus 每隔 5 秒抓取并保存历史。
- PromQL 是 Prometheus 查询语言，可以计算 rate、increase、分位数和比例。
- Dashboard 用于观察，Alert 用于通知，两者应复用相同口径。
- 一次偶发错误不一定是事故，告警通常还需要样本量和持续时间。

### 本轮术语

| 术语 | 小白解释 | 前端类比 |
|---|---|---|
| SLI | 实际测量值，例如 5 分钟成功率 | Web Vitals 中真实采集的 LCP |
| SLO | 团队承诺的目标，例如月可用性 99.9% | 前端性能预算目标，不是某一次测量 |
| Recording Rule | 定时预计算复杂 PromQL 并保存为新指标 | Reselect/Computed 把原始 state 变成复用 ViewModel |
| Alert Rule | SLI 超过阈值且持续一段时间后进入告警 | 表单连续异常一段时间才显示全局故障 Banner |
| Pending | 条件已满足，但尚未达到 `for` 持续时间 | 防抖计时中 |
| Firing | 条件持续满足，正式告警 | 已确认需要值班响应 |
| Resolve | 条件恢复，告警结束 | 错误 Banner 撤销，但仍需复盘 |
| Alertmanager | 对告警分组、抑制、静默并发送通知 | 前端通知中心，不负责计算业务条件 |
| Inhibition | 主故障出现时压制由它导致的次生告警 | 接口全断时不再为每个页面弹一条相同 Toast |
| Provisioning | 启动时从仓库文件创建数据源和 Dashboard | 用代码生成路由/菜单，而不是每台机器手工点 UI |

## 从一次请求到一个 Dashboard 点

1. 客户端调用 `/v1/chat/completions`。
2. 网关完成认证、配额、路由和 Provider 调用，并更新内存 Metrics。
3. Prometheus 每 5 秒带独立 Bearer Token 抓取 `/metrics`。
4. 原始 Counter/Gauge/Histogram 进入 Prometheus 时间序列库。
5. Recording Rules 每 30 秒计算五分钟请求速率、5xx 比例、P95、Provider 错误比例和 Token 速率。
6. Grafana 每 10 秒查询这些 SLI，展示总体和部署维度。
7. Alert Rules 每 5 秒评估条件；例如 5xx 比例 >5%、请求速率 >0.1/s，先进入 Pending。
8. 条件持续 10 分钟才变为 Firing，发送到 Alertmanager。
9. Alertmanager 按 alert/service/model/deployment 分组，避免同一事故产生大量独立通知。
10. 值班人员按 Runbook 先确认 Target、再看 HTTP/Provider/路由、最后通过 trace id 查日志。

### 为什么先算 Recording Rule

如果 Dashboard 和 4 条 Alert 都复制一段复杂 Histogram PromQL，未来修改窗口或聚合标签时容易只改其中一处。Recording Rule 类似稳定 API：原始指标是数据库表，SLI 是面向消费方的 ViewModel。

## 背景与问题

Iteration 6 的 Metrics 已能被人工读取，但存在四个运营缺口：

1. 没有历史存储，进程重启后无法看趋势。
2. 没有统一 PromQL，工程师可能用不同口径汇报成功率。
3. 没有告警持续时间、低流量门槛和抑制，容易误报。
4. 没有 Runbook，收到告警后可能直接重启、扩大影响或丢失证据。

## 本轮目标

- 一条命令启动 Prometheus、Grafana 和 Alertmanager。
- Prometheus 使用独立 Token 成功抓取本机网关。
- 把关键原始指标转成稳定 SLI。
- Dashboard 覆盖可用性、延迟、流量、Token、Provider、活跃请求、路由事件和错误码。
- 告警具备 severity、流量门槛、持续时间、Runbook 和抑制。
- 配置、规则和 Dashboard 全部进入 Git Review。
- 用官方 promtool/amtool 和合成时间序列验证。
- 给传统前端背景新人提供可执行值班手册。

## 非目标

- 真实飞书、钉钉、Slack、邮件或 PagerDuty Receiver。
- 正式 99.9% SLO 合同、错误预算和 Burn Rate 多窗口告警。
- Kubernetes Helm、ServiceMonitor、Prometheus Operator。
- 托管 Grafana/Prometheus、长期对象存储和多集群联邦。
- Loki 日志、Tempo Trace 和 OpenTelemetry Collector。
- 金额成本、团队账单和业务级数据仓库。
- 生产级 Grafana SSO/RBAC、HA Alertmanager 和备份恢复。

## 详细设计

### 固定版本

| 组件 | 版本 | 选择理由 |
|---|---:|---|
| Prometheus | 3.12.0 | 当前稳定生产版本，避免已知旧版安全问题；镜像固定可复现。 |
| Alertmanager | 0.32.1 | 当前稳定版本；支持路由、抑制和配置校验。 |
| Grafana | 13.1.0 | 当前稳定版本；使用经典 Dashboard JSON Provisioning，避免实验 Schema。 |

不使用 `latest`。升级版本必须经过配置测试、真实启动和 Dashboard 视觉 QA。

### Compose Profile

Redis 保持原有默认服务。可观测性组件位于 `observability` Profile，工具位于 `tools` Profile：

```text
default profile       → Redis（原有行为不变）
observability profile → Prometheus + Alertmanager + Grafana
tools profile         → promtool + amtool，一次性验证后退出
```

这样 `docker compose up -d redis` 不会意外拉起 Grafana，也不会改变 Iteration 4 的验证方式。

### Prometheus 抓取安全

Prometheus 容器通过 `host.docker.internal:3000/metrics` 抓取本机网关。Token 不写入 YAML，而从 Docker Secret 路径读取：

```yaml
authorization:
  type: Bearer
  credentials_file: /run/secrets/aigw_metrics_token
```

仓库提供 `metrics-token.dev`，只匹配本地默认 Token。生产创建 `observability/secrets/metrics-token`，该文件已被 Git 忽略，再通过 `METRICS_TOKEN_FILE` 指向它。

### SLI Recording Rules

| SLI | 窗口 | 说明 |
|---|---:|---|
| `aigw:http_request_rate5m` | 5m | 按 route/method 的请求速率 |
| `aigw:http_5xx_ratio5m` | 5m | 所有 HTTP 中 5xx 比例 |
| `aigw:http_success_ratio5m` | 5m | `1 - 5xx ratio` |
| `aigw:http_latency_p95_seconds5m` | 5m | 按 Route 的端到端 P95 |
| `aigw:provider_attempt_rate5m` | 5m | 按模型/部署/outcome 的 attempt 速率 |
| `aigw:provider_attempt_total_rate5m` | 5m | 告警流量门槛使用的部署总速率 |
| `aigw:provider_error_ratio5m` | 5m | 按部署的 Provider attempt 错误比例 |
| `aigw:provider_latency_p95_seconds5m` | 5m | 按部署的上游 P95 |
| `aigw:token_rate5m` | 5m | 按模型/部署/方向的 Token 每秒速率 |

### 为什么 4xx 不降低可用性

- 401/403：认证或权限拒绝，是安全控制正确工作。
- 404：逻辑模型不存在或调用错误。
- 429：企业配额或 Provider 限流，需要单独治理，但不等同网关程序崩溃。
- 5xx：网关或上游未能完成合法请求，计入当前工程可用性 SLI。

这只是网关基础 SLI。未来业务 SLO 可能把某些 429 或 Provider fallback 视为失败，必须由产品、财务和平台共同批准。

### 告警降噪

| 机制 | 例子 | 目的 |
|---|---|---|
| 持续时间 | 5xx >5% 持续 10m | 忽略短抖动 |
| 最小流量 | 请求 >0.1/s | 避免 1 次失败等于 100% |
| 分组 | alert/service/model/deployment | 合并同一根因 |
| 重复间隔 | warning 4h，critical 1h | 避免持续刷屏但保留提醒 |
| 抑制 | Target Down 抑制同服务次生告警 | 先处理抓取/进程主故障 |

### Dashboard 布局

第一行给领导和当班工程师 30 秒判断：五分钟可用性、Gateway P95、请求速率、Token 速率。第二行拆 HTTP 状态和 Provider outcome。后续面板定位 Provider error/P95、活跃请求、路由事件和错误码。

Dashboard 提供 `logical_model` 与 `deployment` 两个变量。它默认不可在 UI 持久编辑，避免某台机器手工修改后与仓库不一致。

### 数据保留与生命周期

本地 Prometheus 保留 7 天，三组件使用 Docker named volume。`observability:down` 只停止并移除 Grafana、Prometheus、Alertmanager 容器，不影响可能正在运行的 Redis，也不删除 Volume，方便下次继续观察。明确删除 Volume 才会清空本地历史，因此日常命令不使用它。

## 关键选择与替代方案

| 选择 | 原因 | 未选择方案 | 代价 |
|---|---|---|---|
| Prometheus 原生规则 | 与指标源一致、promtool 可测 | 全部用 Grafana-managed alerts | UI/跨环境更容易漂移 |
| 文件 Provisioning | Git 可 Review 和回滚 | UI 手工创建 | UI 临时修改会被覆盖 |
| 开发 Secret 文件 | YAML 不含 Token | 把 Token 写进 scrape config | 多一个需保持一致的文件 |
| 本地 Profile | 不影响 Redis 原有流程 | 默认启动全部服务 | 命令多一个 `--profile` |
| Target Down 抑制 | 避免主故障派生噪声 | 每条告警独立发送 | 需确认恢复后次生告警状态 |

## 代码导读

| 文件/模块 | 职责 |
|---|---|
| `compose.yaml` | 固定镜像、Profile、端口、Volume、Healthcheck 与 Secret |
| `observability/prometheus/prometheus.yml` | 抓取周期、规则、Alertmanager 和 Gateway Target |
| `observability/prometheus/rules/recording.yml` | 9 条 SLI 预计算 |
| `observability/prometheus/rules/alerts.yml` | 7 条带严重度、持续时间和 Runbook 的告警 |
| `observability/prometheus/rules.test.yml` | 合成 Target Down/Circuit Open 时间序列 |
| `observability/alertmanager/alertmanager.yml` | 分组、重复时间、Receiver 和抑制 |
| `observability/grafana/provisioning/` | 自动配置 Prometheus 数据源和 Dashboard Provider |
| `observability/grafana/dashboards/aigateway-overview.json` | 11 面板 Dashboard-as-Code |
| `scripts/validate-observability.mjs` | 依次运行 Compose、promtool 和 amtool 验证 |
| `scripts/observability-check.mjs` | 验证真实 Target、Rules、Query、Alertmanager 和 Dashboard API |
| `test/observability-assets.test.ts` | 防止镜像漂移、秘密进 YAML、规则/Runbook 丢失和 Dashboard 破坏 |

## 配置与兼容性

新增命令：

```text
npm run test:observability   官方工具验证配置/规则/合成告警
npm run observability:up     启动三组件
npm run observability:check  验证真实运行栈
npm run observability:down   停止监控栈，保留 Volume
```

新增可选环境变量：`METRICS_TOKEN_FILE`、`GRAFANA_ADMIN_USER`、`GRAFANA_ADMIN_PASSWORD`。原有网关 API、Metrics 格式、Redis 命令和 `.env` 继续兼容。

## 测试矩阵

| 场景 | 类型 | 预期 |
|---|---|---|
| 可观测性镜像固定 | Vitest | 无 `latest`，版本精确 |
| Scrape 不含明文 Token | Vitest | 只引用 credentials file |
| 规则/Runbook 数量 | Vitest | 9 Recording、7 Alert、7 Runbook URL |
| Dashboard 可解析且不可编辑 | Vitest | UID 固定、面板 ≥10 |
| Prometheus Config | promtool | 2 个 Rule File，语法成功 |
| PromQL Rule | promtool | 9+7 全部有效 |
| Target Down 合成告警 | promtool unit | 1 分钟后 critical |
| Circuit Open 合成告警 | promtool unit | warning 且标签/注解正确 |
| Alertmanager 路由/抑制 | amtool | 配置成功 |
| Gateway Target | 真实栈 API | `health=up` |
| Rules 加载 | 真实栈 API | 9 Recording、7 Alert |
| Grafana Provisioning | API + 浏览器 | Dashboard 存在、11 面板可渲染 |

## 手工验证

```bash
npm run verify
npm run test:observability
npm run observability:up
npm run smoke
npm run observability:check
```

这组命令下载 Docker 镜像但不会调用真实模型。`smoke` 只调用 `general` Mock，因此没有 Provider Token 费用。

## 实际验证证据

```text
Typecheck: passed
Default tests: 61 passed, 2 Redis integration tests skipped
Test files: 14 passed, 1 skipped
Production build: passed
Prometheus config: SUCCESS, 2 rule files
Recording rules: SUCCESS, 9
Alert rules: SUCCESS, 7
Promtool synthetic alert tests: SUCCESS, 2 scenarios
Alertmanager config: SUCCESS, 1 receiver + 1 inhibition rule
Real Prometheus target: UP, protected /metrics
Real rules API: 9 recording + 7 alerting
Real Grafana API: AI Gateway Overview found
Browser visual QA: 11 panels rendered; availability 100%; P95 9.50ms
External Provider: skipped; no model cost
```

## 已知限制与业务影响

- Local Receiver 不发送消息：本地能看到 Firing，但生产不配置真实 Receiver 就不会有人被叫醒。
- 阈值未经生产基线校准：5%、20%、5 秒、50 活跃请求都是工程初值，可能误报或漏报。
- 当前是短窗口可用性，不是月度 SLO/错误预算；无法回答“本月还能容忍多少失败”。
- Grafana 本地账号不是企业身份：生产需要 SSO/RBAC、Secret Manager 和审计。
- Prometheus/Alertmanager/Grafana 都是单实例：不具备生产 HA、备份和灾难恢复。
- 7 天本地保留不适合审计和容量规划；长期保留需要远程存储或托管服务。
- 没有 Loki/Tempo：Dashboard 不能一键从指标跳到指定 trace/log。
- Provider Error Ratio 在没有错误样本时显示 No data，而不是 0；这是 PromQL 缺少错误序列的结果，告警不会误触发，但领导面板体验后续可优化。
- Alert Runbook URL 当前是 localhost；生产部署必须替换为企业文档与 Dashboard 地址。

## 领导 Review 问题

- 5xx、Provider 错误率和延迟阈值是否符合业务体验？
- 哪些模型属于 P0/P1，是否需要不同 SLO 和通知级别？
- 生产通知接飞书/钉钉/PagerDuty，由哪个团队与谁值班？
- 是否批准 2–4 周观察期，用真实数据校准阈值再承诺 SLO？
- 下一轮优先做 OpenTelemetry/Loki/Tempo，还是 PostgreSQL 控制面和动态策略？

## 工程师 Review 清单

- [ ] 所有镜像是否固定版本且经过安全升级检查？
- [ ] Metrics Token 是否只通过 Secret 文件提供？
- [ ] Dashboard/Alert 是否复用 Recording Rule 口径？
- [ ] 高错误率是否同时有流量门槛和持续时间？
- [ ] Target Down 是否正确抑制次生告警？
- [ ] 每条 Alert 是否有 severity、description 和 Runbook？
- [ ] Promtool 合成测试是否覆盖关键通知行为？
- [ ] UI 修改是否同步回仓库，而非只保存在 Grafana 数据库？
- [ ] 生产 Receiver、SSO、HA 和备份是否被明确列为未完成？

## 偏差记录

原计划名称为“OpenTelemetry/Grafana”。实施前审计发现现有 Trace Context 已足够关联，但原始 Metrics 尚未形成任何运营闭环，因此本轮优先完成 Prometheus/Grafana/Alertmanager、SLO 口径和 Runbook。OpenTelemetry Span/Collector 保留为后续独立迭代，避免同时引入 Trace Backend 与告警系统导致验收范围过大。
