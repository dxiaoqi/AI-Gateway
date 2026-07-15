# Iteration 1：可运行网关骨架与 Provider 边界

- 版本：0.1.0
- 日期：2026-07-15
- 状态：Completed
- 关联 ADR：[ADR 0001](../adr/0001-canonical-provider-boundary.md)

## 一句话说明

这一轮把一份架构想法变成了第一个能启动、能调用、能测试的 AI Gateway。

## 30 秒领导摘要

| 领导关心的问题 | 回答 |
|---|---|
| 以前的问题 | 每个业务如果直接连接模型厂商，未来换模型、统计成本、统一安全策略都要逐个改应用。 |
| 本轮交付 | 一个统一 `/v1/chat/completions` 入口，以及不依赖真实模型的 Mock 演示。 |
| 业务价值 | 前端和业务应用以后只认企业网关和逻辑模型名，不必知道供应商细节。 |
| 如何证明 | 7 项自动测试、生产构建和真实 HTTP 请求均通过。 |
| 最大剩余风险 | 只有单 Key、没有流式、没有真实 Provider，尚不能供团队试用。 |

### 最短演示

```bash
npm run verify
npm start
```

另一个终端运行 `npm run smoke`。看到 `status: passed`，说明 HTTP 入口和 Mock Provider 正常。当前 smoke 还会验证后续迭代能力，但其中 `non-streaming` 检查就是本轮核心结果。

## 新人工程师导读

### 阅读前只需要知道

- HTTP API 接收 JSON，再返回 JSON。
- TypeScript interface 描述对象形状。
- 前端通常会把不同接口封装到 service 层，避免页面直接处理后端差异。

### 本轮术语

| 术语 | 小白解释 | 前端类比 |
|---|---|---|
| AI Gateway | 所有应用访问模型前经过的统一入口 | 面向多个后端服务的 BFF |
| Provider | OpenAI、Azure、自建模型等实际服务方 | 不同支付/地图 SDK 供应商 |
| Adapter | 把供应商格式翻译成内部统一格式 | 把不同 API Response 转成统一 ViewModel |
| Canonical Schema | 网关内部约定的标准对象 | 页面只使用的统一 DTO |
| 逻辑模型 | 应用使用的稳定名称，如 `general` | 前端使用 `primaryApi`，不关心真实域名 |
| Registry | 根据逻辑模型找到具体 Provider | 根据 key 从 service map 选择实现 |

### 用一个请求理解全流程

请求：前端发送 `model=general` 和一条“你好”。

1. Fastify Route 收到 JSON，类似 Next.js API Route。
2. Schema 检查 `model`、`messages` 是否存在；格式错立即返回 400。
3. onRequest Hook 检查 Bearer Key，类似服务端路由守卫。
4. Route 把 `max_tokens` 等外部字段翻译成内部 `CanonicalChatRequest`。
5. Registry 查找 `general`，得到 Mock Provider。
6. Mock Provider 生成确定性的回答和估算 Token。
7. Route 把内部 Response 翻译回 OpenAI-compatible JSON。
8. 日志只记录 request id、状态和耗时，不记录 Key 与 Prompt。

最重要的一点：第 4 和第 7 步形成“翻译边界”。将来接入别的模型，只新增 Adapter，不要求前端改请求。

### 从前端代码看项目

```text
src/server/routes       ≈ API Routes / Controller
src/core                ≈ 共享 domain types
src/providers           ≈ services/adapters
ProviderRegistry        ≈ implementation map
Fastify hooks           ≈ route guard / interceptor
```

## 1. 背景与问题

项目初始只有调研文档。第一步需要证明 Node.js 可以承载一个结构清晰、可测试、不会立即绑定某家 Provider 的网关。若直接在 HTTP Route 中调用模型 SDK，后续多模型、路由、流式和测试都会被供应商字段污染。

## 2. 本轮目标

- 建立可构建、可测试、可启动的 TypeScript/Fastify 工程。
- 提供 OpenAI-compatible `POST /v1/chat/completions` 非流式入口。
- 定义 Canonical Request/Response 与 `ModelProvider` 接口。
- 用 `general` 逻辑模型映射 Mock Provider。
- 建立认证、健康检查、统一错误和结构化日志基线。

## 3. 非目标

- 真实 Provider、SSE、Tool Calling。
- 多租户、持久化、限流和预算。
- Provider fallback、熔断、OpenTelemetry。

## 4. 设计

### 请求流

```text
HTTP JSON
→ Schema Validation
→ Bearer Key
→ OpenAI Request → CanonicalChatRequest
→ ProviderRegistry.resolve(logicalModel)
→ ModelProvider.complete()
→ CanonicalChatResponse → OpenAI Response
```

### 核心边界

- HTTP 层拥有 OpenAI-compatible 字段名，例如 `max_tokens`。
- Core 层使用供应商无关字段，例如 `maxOutputTokens`。
- Provider 返回实际 Provider 模型，客户端仍看到逻辑模型 `general`。
- Registry 是逻辑模型与 Provider 的唯一映射点。

### 错误语义

`GatewayError` 统一携带 `statusCode`、`code` 和 `retryable`。客户端错误响应始终包含 `request_id`，便于关联日志。

### 安全与隐私

- 健康检查免认证，其余接口需要 Bearer Key。
- 不记录 Authorization 和请求正文。
- 默认 Key 仅用于开发。

## 5. 关键选择

| 选择 | 原因 | 代价 |
|---|---|---|
| Fastify | Schema、inject 测试、低开销插件模型 | 后续 SSE 需要直接管理 raw response |
| TypeBox | Schema 与 TypeScript 类型共用定义 | 复杂 Provider Schema 仍需运行时解析 |
| Canonical Schema | 隔离外部 API 和 Provider | 需要持续版本管理 |
| Mock Provider | 无密钥、确定性测试 | Token 只能估算，不代表真实模型行为 |

## 6. 代码落点

| 文件 | 职责 |
|---|---|
| `src/core/canonical-schema.ts` | 内部请求、响应、Usage |
| `src/providers/provider.ts` | Provider 契约 |
| `src/providers/registry.ts` | 逻辑模型解析 |
| `src/providers/mock-provider.ts` | 确定性本地 Provider |
| `src/server/routes/chat-completions.ts` | HTTP/Canonical 转换 |
| `src/server/app.ts` | Fastify 生命周期、认证、错误、日志 |
| `src/config.ts` | 环境配置校验 |

## 7. API 契约

```http
POST /v1/chat/completions
Authorization: Bearer <gateway-key>
Content-Type: application/json
```

支持字段：`model`、`messages`、`temperature`、`max_tokens`、`metadata`。Iteration 1 对 `stream=true` 明确返回 400，避免假装支持。

## 8. 测试矩阵

| 场景 | 预期 | 测试 |
|---|---|---|
| Readiness | 200，无需认证 | `gateway.test.ts` |
| 缺少 Key | 401 `authentication_error` | `gateway.test.ts` |
| Mock completion | OpenAI-compatible 200 | `gateway.test.ts` |
| 未知模型 | 404 `model_not_found` | `gateway.test.ts` |
| 配置非法 | 启动前失败 | `config.test.ts` |

## 9. 实际验证证据

```text
Typecheck: passed
Build: passed
Tests: 7/7 passed
Real HTTP process: passed
```

真实进程请求返回 `Mock response: 你好，AI Gateway`，包含逻辑模型、Provider 模型、估算 Usage 和 request id。

## 10. 已知限制

- 单 Key、明文配置，不适合企业多租户。
- 无 SSE，无法验证背压和客户端断开。
- Mock Token 使用字符数估算。
- Provider Registry 只在启动时构建。

对领导的影响：本轮证明架构可行，但还只是“能跑的底座”，不应承诺生产使用。

## 领导 Review 问题

- 统一入口是否符合公司未来多模型策略？
- 应用只使用逻辑模型名，是否能减少供应商锁定？
- 在没有真实 Provider 和流式体验前，是否只定位为技术验证？

## 11. Review 清单

- [ ] HTTP 字段是否泄漏进 Provider 以外的核心逻辑？
- [ ] 应用是否只依赖逻辑模型名？
- [ ] 未知模型和非法请求是否有稳定错误码？
- [ ] 日志是否避免 Key 和 Prompt？
- [ ] Mock Provider 是否足够确定性？

## 12. 偏差记录

原计划使用 Undici 直接依赖；本轮没有真实上游请求，因此延后到 Provider 迭代。Node.js 内置 Fetch 同样由 Undici 实现，后续通过可注入 Fetch Client 保持测试性。
