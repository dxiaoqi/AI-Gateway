# Iteration 5：多部署路由、失败切换、冷却与熔断

- 版本：0.5.0
- 日期：2026-07-15
- 状态：Completed
- 关联 ADR：[ADR 0005](../adr/0005-routing-and-pre-stream-fallback.md)

## 一句话说明

这一轮让一个稳定的逻辑模型名可以连接多个真实部署；主部署短时故障时，网关能在明确边界内自动选择备用部署。

## 30 秒领导摘要

| 领导关心的问题 | 回答 |
|---|---|
| 以前的问题 | 每个逻辑模型只有一个部署；供应商限流、超时或区域故障会直接影响全部业务。 |
| 本轮交付 | 多部署优先级/权重路由、有限失败切换、429 冷却、熔断与半开恢复；响应和日志可追踪实际部署。 |
| 业务价值 | 应用代码和模型名保持不变，网关集中执行主备策略，降低单点 Provider 故障影响。 |
| 如何证明 | 50 项默认测试通过，其中 8 项专门验证路由；HTTP 测试证明主部署失败后命中备用部署。 |
| 最大剩余风险 | 健康状态只在单个网关进程内；多实例会各自判断，尚未形成全局熔断。 |

### 本轮演示

```bash
npm run verify
npx vitest run test/model-router.test.ts test/routing-http.test.ts
```

第二条命令应显示 8 项通过，不访问真实 Provider，也不产生模型费用。

## 新人工程师导读

### 阅读前只需要知道

- 客户端请求 `general` 或 `external`，这叫逻辑模型名，不一定等于供应商模型名。
- 一个 Provider 是对某家模型服务协议的适配器；一个 Deployment 是“某个 Provider 的一套实际地址、模型和密钥配置”。
- Promise reject 或异步迭代器 throw 都可能代表上游失败。
- SSE（Server-Sent Events，服务端推送事件）一旦向浏览器发出第一条数据，响应就已经开始。

### 术语与前端类比

| 术语 | 小白解释 | 前端类比与差异 |
|---|---|---|
| Logical Model | 客户端长期使用的稳定名称 | 像前端调用 `/api/search`，不关心背后哪台服务器；但这里还涉及模型语义和成本。 |
| Deployment | 一个可独立调用的模型落点 | 像同一 API 的不同 origin；它有自己的地址、密钥、模型和健康状态。 |
| Priority | 主备顺序，数字越小越先选 | 像 CDN 主源和备用源。只有高优先级没有健康候选时才看下一层。 |
| Weight | 同优先级内部的相对流量权重 | 像灰度发布 80/20；它是长期概率，不保证每 10 个请求精确 8/2。 |
| Fallback | 本次请求改试另一个部署 | 像 API 主域名网络失败后尝试备用域名；不是把所有 4xx 都再发一次。 |
| Cooldown | 429 后暂时不再选择该部署 | 像按钮被服务端限流后短时禁用，避免立刻重复点击。 |
| Circuit Breaker | 连续故障后暂停调用 | 像保险丝；保护故障服务和调用方，避免每个请求都等待相同超时。 |
| Half-open | 熔断时间结束后放行一个探测 | 像恢复网络后先发一个轻量请求，不立即恢复全部流量。 |
| Retry Budget | 一次请求最多尝试几个部署 | 像 Axios retry 上限；防止一个用户请求放大成无限上游流量。 |

### 一个具体配置

```json
[
  {
    "id": "primary",
    "logicalModel": "external",
    "baseUrl": "https://provider-a.example/v1",
    "providerModel": "model-a",
    "apiKeyEnv": "PRIMARY_PROVIDER_KEY",
    "priority": 1,
    "weight": 80
  },
  {
    "id": "backup",
    "logicalModel": "external",
    "baseUrl": "https://provider-b.example/v1",
    "providerModel": "model-b",
    "apiKeyEnv": "BACKUP_PROVIDER_KEY",
    "priority": 2,
    "weight": 20
  }
]
```

因为 `primary` 优先级是 1、`backup` 是 2，正常情况下所有流量先去 `primary`。这里的 80 和 20 不会跨优先级分流；如果希望真正 80/20，两者必须使用相同 priority。

`apiKeyEnv` 存的是环境变量名字，不是密钥本身。真实密钥仍由部署环境注入，避免整段路由 JSON 被复制到文档或配置中心时泄密。

## 一次非流式请求逐步发生了什么

以客户端请求 `model=external` 为例：

1. Fastify `onRequest` 认证虚拟 Key，建立 Tenant/Project/Application 身份。
2. ACL（访问控制列表）检查该 Key 是否能调用 `external`。
3. QuotaService 在调用 Provider 前预留 RPM、TPM 和并发额度。
4. ModelRouter 从 Registry 取得 `external` 的全部部署。
5. 跳过仍在 429 冷却、熔断开启或已有半开探测的部署。
6. 找到健康候选中的最小 priority；只在该层按 weight 选择一个。
7. 调用部署 A。成功就清零其连续故障并返回。
8. 如果 A 返回可切换的 Provider 错误，记录健康状态，再选择一个尚未尝试的部署。
9. 达到 `ROUTING_MAX_ATTEMPTS`、没有候选或遇到不可切换错误时停止。
10. 成功响应在 `gateway` 中回报 provider、deployment 和 route_attempts。
11. QuotaService 按最终 Usage 结算；全部 Provider 失败则取消 Token 预留和并发，但 RPM 不退款。

示例成功元数据：

```json
{
  "gateway": {
    "provider": "secondary-provider",
    "deployment": "secondary",
    "route_attempts": 2,
    "provider_model": "secondary-model"
  }
}
```

`route_attempts=2` 表示本次业务请求实际触发了两次上游尝试，可能影响延迟和供应商侧请求计数。

## 一次流式请求逐步发生了什么

1. 认证、ACL 和配额预留与非流式相同。
2. Router 创建部署 A 的异步迭代器，并等待第一条 Canonical 事件。
3. A 在第一条事件前超时或失败：迭代器被关闭，允许尝试部署 B。
4. B 返回 `response_start`：路由选择完成，此时才提交 HTTP 200 和 SSE Header。
5. 第一条 SSE 中写入 deployment 和 route_attempts，之后持续转发 B 的内容。
6. B 在中途失败：返回 SSE error event 并结束，不调用部署 C。

### 为什么首事件后不能切换

假设模型 A 已输出“本次合同可以”，随后断开；模型 B 从头回答“本次合同不可以”。如果网关把两段拼接，用户会看到语义矛盾的文本，审计也无法回答哪家模型生成了最终内容。中途失败虽然体验不好，但明确失败比静默混合答案更安全。

## 目标

- 一个逻辑模型支持多个 Deployment。
- 支持优先级和同级权重选择。
- 每次请求限制最大尝试次数，每个部署最多尝试一次。
- 对明确的 Provider 故障做失败切换。
- 对 429 做冷却，对连续故障做熔断和半开恢复。
- 非流式与流式都接入 Router。
- 响应与日志提供不含秘密的路由证据。

## 非目标

- 基于实时价格、延迟或输出质量的动态打分。
- 跨进程、跨区域共享熔断状态。
- 后台主动健康探测和 Provider SLA 仪表盘。
- 对同一 Deployment 原地重复请求。
- 流式首 Token 后无缝续写。
- 对 Tool Calling 等有副作用的请求自动重试。

## 详细设计

### Registry 与 Router 的职责分开

ProviderRegistry 只保存“有哪些部署”，类似只读配置表。ModelRouter 负责“这次选谁”和“部署当前是否健康”。HTTP Route 不再直接 `registry.resolve()` 后调用 Provider。

保留旧的 `register(logicalModel, provider)` 形式；没有写路由选项时使用默认 priority=100、weight=1，因此之前的单部署测试和接入方式仍然工作。

### 选择算法

```text
全部 Deployment
→ 排除本次已尝试
→ 排除冷却/熔断/半开占用
→ 取最小 priority 层
→ 按 weight 随机选一个
→ 原子式占用半开探测资格
```

JavaScript 单进程事件循环保证“检查并设置 `halfOpenInFlight`”之间没有 `await`，因此同一进程同时只有一个请求获得半开资格。

### 哪些错误可以切换

| 错误 | 是否切换 | 理由 |
|---|---|---|
| `provider_unavailable` | 是 | 部署或网络故障，备用部署可能正常。 |
| `provider_timeout` | 是 | 当前部署超时，备用可能更快。 |
| `provider_rate_limited` | 是，并冷却 | 当前供应商额度繁忙，继续撞击会恶化。 |
| `provider_authentication_error` | 是 | 某部署密钥可能失效，备用配置可能独立。 |
| `provider_invalid_response` | 是 | 某适配目标返回异常协议。 |
| `invalid_request_error` | 否 | 同一错误请求发给更多部署只会放大流量。 |
| `authorization_error` | 否 | 企业权限拒绝不能用换 Provider 绕过。 |
| `quota_*_exceeded` | 否 | 企业资源限制优先于供应商可用性。 |

当前认证错误允许切换是为了主备使用独立凭据，但会熔断并暴露运维问题；生产必须同时告警，不能长期依赖备用掩盖错误配置。

### 冷却与熔断状态

每个逻辑模型+部署维护：连续失败数、429 冷却截止时间、熔断截止时间、半开探测是否占用。成功后全部清零。

- 429 不累计普通熔断失败，单独进入 cooldown。
- 超时、不可用、认证错误、无效响应累计连续失败。
- 达到阈值后在 `circuitOpenMs` 内跳过。
- 到期后第一个请求半开；成功关闭，失败重新打开。

### 配置项

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `ROUTING_MAX_ATTEMPTS` | 3 | 单个客户端请求最多尝试的不同部署数。 |
| `ROUTING_RATE_LIMIT_COOLDOWN_MS` | 30000 | Provider 429 后跳过多久。 |
| `ROUTING_CIRCUIT_FAILURE_THRESHOLD` | 3 | 连续多少次故障后熔断。 |
| `ROUTING_CIRCUIT_OPEN_MS` | 30000 | 熔断保持多久后允许半开探测。 |
| `OPENAI_COMPAT_DEPLOYMENTS_JSON` | 未设置 | 多部署定义；可与旧单部署变量兼容。 |

这些时间是每个网关进程本地计算的毫秒值，不是 Provider 返回的 SLA。

## 代码导读

| 文件 | 新人应该看什么 |
|---|---|
| `src/providers/registry.ts` | 一个逻辑模型如何保存多个部署及其静态配置。 |
| `src/routing/model-router.ts` | 候选选择、错误分类、冷却、熔断、完整与流式尝试循环。 |
| `src/server/routes/chat-completions.ts` | 配额之后如何调用 Router，以及流式首事件边界。 |
| `src/config.ts` | 如何校验部署 JSON，并从 `apiKeyEnv` 解析秘密。 |
| `src/server/app.ts` | 默认 Mock 和配置部署如何注册，Router 如何注入 Route。 |
| `test/model-router.test.ts` | 最集中、最容易阅读的路由规则示例。 |
| `test/routing-http.test.ts` | 从 HTTP 请求到响应元数据/SSE 的完整证据。 |

推荐阅读顺序：Registry → Router 的 `complete()` → 单元测试 → Route → `startStream()`。

## 测试与证据

### 自动测试矩阵

| 场景 | 证据 |
|---|---|
| 主部署不可用后备用成功 | Router 单元测试 + HTTP 集成测试 |
| 非 Provider 请求错误不重试 | Router 单元测试，备用调用次数为 0 |
| 同优先级权重选择 | 注入固定 random 的确定性测试 |
| Provider 429 后冷却 | 连续两次请求，主部署只被调用一次 |
| 连续失败后熔断 | 第三次请求跳过主部署 |
| 熔断到期半开并恢复 | 注入可控 clock，恢复探测成功 |
| 流式首事件前故障切换 | Router 流式单元测试 |
| 流式首事件后故障不切换 | HTTP SSE 测试，备用调用次数为 0 |
| 旧的单部署流式超时仍为 504 | 原有回归测试 |
| 多部署 JSON 与密钥引用校验 | Config 测试 |

### 本轮实际结果

```text
Typecheck: passed
Default tests: 50 passed, 2 Redis tests skipped
Test files: 12 passed, 1 Redis integration file skipped
Production build: passed
Routing-only tests: 8 passed
Compiled server smoke: passed (readiness, model ACL, non-streaming, SSE termination, SSE response id)
External Provider: not called in this iteration; no model cost incurred
```

## 已知限制与业务影响

- 健康状态仅在内存：10 个网关实例可能各自用 3 次失败才熔断，故障供应商会收到更多流量。
- 权重是随机概率：低流量窗口会明显偏离 80/20，不能当作精确财务分账。
- 没有读取 Provider `Retry-After`：所有 429 使用统一冷却时间，可能恢复过早或过晚。
- 切换会增加尾延迟：先等主部署失败再尝试备用，用户可能经历两段等待。
- 备用模型可能价格更高或回答行为不同：上线前必须确认数据区域、合规、能力和成本等价性。
- 当前任何普通聊天请求都可能安全地在首事件前切换；未来 Tool Calling、文件写入或外部副作用需要幂等键与更严格规则。
- 没有后台主动探测：没有业务请求时不会发现恢复，半开只能由下一次真实请求触发。
- 没有 Prometheus/OpenTelemetry 指标：现阶段只能从结构化日志和响应元数据观察路由结果。

## 领导 Review 问题

- 哪些模型部署在合规、数据驻留和能力上允许互为主备？
- 备用模型成本更高时，是优先保证可用性还是拒绝请求？
- 可接受的最大失败切换延迟是多少？
- 多实例上线前，是否需要优先做共享健康状态和告警？
- deployment 信息是否可返回给内部客户端，还是只应保留在日志？

## 工程师 Review 清单

- [ ] ACL 和企业配额是否都发生在路由尝试之前？
- [ ] 单次请求是否不会重复尝试同一部署？
- [ ] `maxAttempts` 是否能阻止请求放大失控？
- [ ] 非 Provider 错误是否立即停止？
- [ ] 只在同一 priority 层使用 weight？
- [ ] 429 冷却与连续故障熔断是否分开处理？
- [ ] 半开状态是否一次只放行一个请求？
- [ ] 流式首事件后是否绝不切换？
- [ ] 响应和日志是否不包含密钥、Authorization 或 Prompt？
- [ ] 旧单部署配置和真实 `.env` 是否继续兼容？
