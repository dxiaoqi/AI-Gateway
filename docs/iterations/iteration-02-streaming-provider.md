# Iteration 2：OpenAI-compatible Provider 与端到端 SSE

- 版本：0.2.0
- 日期：2026-07-15
- 状态：Completed
- 关联 ADR：[ADR 0002](../adr/0002-streaming-and-cancellation.md)

## 一句话说明

这一轮让网关接上了真实模型，并能像聊天产品一样边生成、边把文字返回给用户。

## 30 秒领导摘要

| 领导关心的问题 | 回答 |
|---|---|
| 以前的问题 | 只能调用 Mock 模型且必须等完整答案，无法验证真实供应商和聊天体验。 |
| 本轮交付 | 一个通用 OpenAI-compatible Provider，以及端到端 SSE 流式返回。 |
| 业务价值 | 可以用相同企业接口连接 OpenAI-compatible 服务；用户更快看到首字，应用无需了解供应商流格式。 |
| 如何证明 | 15 项测试、真实 `curl -N` 分片响应、Provider 错误与超时测试通过。 |
| 最大剩余风险 | 没有 retry/fallback；真实 Provider 失败会影响请求，首 Token 后也不能安全切换。 |

### 最短演示

```bash
npm start
```

另一个终端：

```bash
npm run smoke
```

看到 `SSE termination` 和 `SSE response id` 通过，说明流式协议完整。显式设置 `SMOKE_EXTERNAL=true` 才会调用真实 Provider并产生少量费用。

## 新人工程师导读

### 阅读前只需要知道

- 浏览器 `fetch()` 可以使用 `AbortSignal` 取消。
- HTTP Response 不一定一次返回完整 JSON，也可以持续传输数据。
- Node.js Stream 的生产速度可能大于客户端消费速度。

### 本轮术语

| 术语 | 小白解释 | 前端类比 |
|---|---|---|
| SSE | 服务器持续发送一条条 `data:` 事件 | 浏览器 EventSource 或 fetch stream |
| Chunk | 一小段网络数据；不保证刚好是一条 JSON | WebSocket message 的底层字节可能分段到达 |
| TTFT | 从发请求到看到第一个 Token 的时间 | 首屏内容出现时间 |
| Backpressure | 客户端读得慢时，服务端暂停继续读取 | 虚拟列表消费不过来时暂停数据生产 |
| AbortSignal | 一条贯穿调用链的取消信号 | React effect 中取消 fetch |
| Header committed | HTTP 状态和 Header 已发出，不能再改 | `response.write()` 后不能假装之前没开始返回 |
| `[DONE]` | OpenAI 风格 SSE 的结束标记 | 流式协议中的 EOF 业务事件 |

### 用一个流式请求理解全流程

请求：前端发送 `stream=true`，要求 `external` 模型回答问题。

1. Route 完成认证、Schema 和模型解析。
2. OpenAI-compatible Adapter 用真实 Provider 模型名发起上游 fetch。
3. 网关先等待 Provider 的第一个合法事件，暂时不向客户端发 200。
4. 若此时 Provider 401、429 或 timeout，客户端仍能收到正常 JSON 错误和正确状态码。
5. 收到 `response_start` 后，网关提交 `text/event-stream` Header。
6. SSE Parser 把任意网络字节拼回一条条完整事件；不能假设一个 chunk 就是一条 JSON。
7. Adapter 把供应商事件翻译成 `content_delta`、`usage`、`response_end`。
8. Route 再编码成客户端熟悉的 OpenAI-compatible chunk。
9. 如果客户端读得慢，`write()` 返回 false，网关暂停读取上游，等待 `drain`。
10. 如果浏览器关闭页面，close/abort 会取消上游 fetch，避免模型继续产生无用 Token。
11. 最后返回 Usage、finish reason 和 `[DONE]`。

### 为什么首 Token 后不自动换模型

可以把流式回答理解为用户已经看到一位客服说了半句话。此时换另一位客服继续说，语气、事实和 JSON/Tool Call 状态可能完全不同。网关只能在第一个 Token 之前安全 retry/fallback；之后失败应明确告诉客户端流中断。

### 从前端代码看项目

```text
OpenAICompatibleProvider ≈ 对第三方 SDK 的 service adapter
parseSseData             ≈ 增量解析 fetch response.body
CanonicalStreamEvent     ≈ 前端状态机消费的统一 action
AbortSignal              ≈ 浏览器 fetch cancellation
write()/drain            ≈ producer/consumer 节流
```

## 1. 背景与问题

AI 交互的主要用户体验依赖流式返回。SSE 的难点不只是输出 `data:`：上游可能任意切分字节，Usage 可能只在尾块出现，客户端可能中途断开，慢客户端会形成背压，而且 Header 发出后无法再改变 HTTP 状态。

## 2. 本轮目标

- 扩展 Provider 契约支持 Canonical Stream Event。
- 实现可配置 OpenAI-compatible Provider 的非流式与流式调用。
- 实现任意分片 SSE Parser。
- 处理 timeout、Abort、客户端断开和下游背压。
- 保证下游 OpenAI-compatible chunk、Usage 与 `[DONE]`。

## 3. 非目标

- Tool Call、Reasoning、Image/Audio 流。
- Retry、fallback、熔断；首 Token 后尤其不切模型。
- 精确 Token 估算和成本账本。

## 4. 设计

### Canonical 事件序列

```text
response_start
content_delta *
usage ?
response_end
```

HTTP 层把事件重新编码成 OpenAI-compatible `chat.completion.chunk`。所有 chunk 复用同一个 response id，客户端看到逻辑模型名；首事件额外带实际 Provider 模型。

### Header 提交边界

Provider 的第一个事件必须是 `response_start`。Route 在取到该事件前不发送 200：

```text
连接/认证/首事件失败 → 标准 JSON + 正确 HTTP 状态
response_start 成功 → 提交 SSE 200
之后失败 → SSE error event，不能修改状态码
```

### 取消链路

同一个 `AbortSignal` 连接 Provider Fetch、Response Body Reader、请求 aborted、响应 close 和 Provider timeout。客户端断开时取消上游，以避免继续产生无用 Token。

### 背压

当 `ServerResponse.write()` 返回 false，暂停读取 Provider 并等待 `drain`；等待期间同时监听 close/abort，避免内存无限增长或永久挂起。

### Provider 错误

| 上游情况 | 网关结果 |
|---|---|
| 401/403 | 502 `provider_authentication_error` |
| 429 | 429 `provider_rate_limited`, retryable |
| 5xx/网络失败 | 502 `provider_unavailable`, retryable |
| 非法 JSON/SSE | 502 `provider_invalid_response` |
| timeout | 504 `provider_timeout`, retryable |

上游错误正文不会直接透传，避免 Provider 回显敏感输入。

## 5. 代码落点

| 文件 | 职责 |
|---|---|
| `src/core/canonical-schema.ts` | Canonical Stream Event |
| `src/providers/openai-compatible/sse.ts` | 增量 SSE 字节解析 |
| `src/providers/openai-compatible/provider.ts` | Provider 请求、响应、错误映射 |
| `src/server/routes/chat-completions.ts` | 下游 SSE、Header 边界、背压、取消 |
| `test/sse.test.ts` | 任意分片与多行 data |
| `test/openai-compatible-provider.test.ts` | Provider 契约与错误 |
| `test/stream-timeout.test.ts` | 首事件 timeout |

## 6. 配置

| 变量 | 必需 | 说明 |
|---|---|---|
| `OPENAI_COMPAT_BASE_URL` | 与 Model 同时 | 通常包含 `/v1` |
| `OPENAI_COMPAT_MODEL` | 与 Base URL 同时 | 实际 Provider 模型 |
| `OPENAI_COMPAT_API_KEY` | 视 Provider | 本地 vLLM 可省略 |
| `OPENAI_COMPAT_LOGICAL_MODEL` | 否 | 默认 `external` |
| `PROVIDER_TIMEOUT_MS` | 否 | 默认 30000 |

## 7. 测试矩阵

| 场景 | 预期 | 测试 |
|---|---|---|
| SSE JSON 跨 chunk | 正确重组 | `sse.test.ts` |
| CRLF 与多行 data | 正确解析 | `sse.test.ts` |
| 非流式 Provider | Canonical Response | `openai-compatible-provider.test.ts` |
| 流式尾块 Usage | usage 在 end 前出现 | 同上 |
| Provider 429 | 统一可重试错误 | 同上 |
| 网络失败 | 502 可重试 | 同上 |
| 首事件超时 | JSON 504 | `stream-timeout.test.ts` |
| Mock SSE | `[DONE]` 和统一 id | `gateway.test.ts` |

## 8. 实际验证证据

```text
Typecheck: passed
Build: passed
Tests: 15/15 passed
Real curl -N SSE: passed
Production dependency audit: 0 known vulnerabilities
```

真实 `curl -N` 观察到 start、多个 content delta、Usage、finish 和 `[DONE]`。

## 9. 已知限制

- 当前 Canonical Event 只覆盖文本。
- 一些 OpenAI-compatible Provider 不支持 `stream_options.include_usage`，需要能力配置。
- Header 后错误只能通过 SSE 传递，部分 SDK 可能不会标准解析该错误。
- 尚未记录 TTFT 和 inter-token latency。
- 没有 retry/fallback，网络抖动直接失败。

对领导的影响：已经具备真实试用的调用体验，但单 Provider 故障仍会直接影响业务可用性，不能宣称高可用。

## 领导 Review 问题

- 用户是否确实需要流式体验，TTFT 是否应成为后续 SLO？
- 真实 Provider 故障时，哪些业务允许失败，哪些必须 fallback？
- 是否接受首 Token 后不切换模型这一一致性原则？
- 是否需要为真实 Provider 冒烟调用设置费用上限？

## 10. Review 清单

- [ ] 是否在首事件前才提交 Header？
- [ ] 慢客户端是否能反压上游读取？
- [ ] 客户端断开是否取消 Provider Fetch？
- [ ] 每个 chunk 是否使用同一 response id？
- [ ] Provider 错误正文是否可能泄露 Prompt？
- [ ] 首 Token 后是否错误地尝试 fallback？

## 11. 偏差记录

真实 Provider Adapter 与 SSE 在同一迭代交付，便于用同一 Canonical Event 验证两侧协议。没有引入独立 Undici 包，使用 Node.js 内置 Fetch，并通过 `FetchClient` 注入实现无网络契约测试。
