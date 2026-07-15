# ADR 0002：用 Canonical Stream Event 驱动端到端 SSE

- 状态：Accepted
- 日期：2026-07-15

## 背景

不同模型供应商的流式事件格式并不一致。网关还需要处理任意字节分片、TTFT、客户端断开、上游超时、Node.js 写入背压以及最后一个 Usage 事件。如果把供应商 SSE 直接透传，后续无法统一观测、审计、Tool Calling 和错误。

## 决策

Provider 把上游事件转换成以下内部事件：

```text
response_start
content_delta*
usage?
response_end
```

HTTP 层再把 Canonical Stream Event 编码成 OpenAI-compatible SSE。HTTP 层只有在成功取得 `response_start` 后才发送 200 和 SSE Header，这样连接失败、认证失败和首 Token 超时仍可以返回正常 JSON 错误。

每个请求使用同一个 `AbortSignal` 串联：

- Provider timeout
- 客户端请求 aborted
- 下游 response close
- Provider fetch 和 response body reader

下游 `write()` 返回 false 时等待 `drain`，同时监听 abort/close，防止慢客户端导致无界内存增长或永远等待。

## 结果

正面影响：

- Provider SSE 分片方式不会泄漏到 HTTP 层。
- 所有下游 chunk 使用稳定的逻辑模型名和 response id。
- 首事件前错误保持结构化 HTTP 错误；首事件后的错误使用 SSE error event。
- 客户端断开能够取消 Provider 请求，减少无效 Token 消耗。

代价与限制：

- Header 发出后无法再修改 HTTP 状态码。
- 当前事件只覆盖文本与 Usage；Tool Call、Reasoning、Audio 等需要新增事件类型。
- Provider 在首 Token 后失败时不会自动切换模型，避免拼接两个模型的输出。
