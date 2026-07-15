# ADR 0001：用 Canonical Schema 隔离 Provider

- 状态：Accepted
- 日期：2026-07-15

## 背景

AI Gateway 需要同时接入不同模型供应商。它们在请求字段、流式事件、Tool Calling、错误、Usage 和认证方式上存在差异。如果 HTTP 路由直接调用某家 SDK，应用协议会被供应商实现细节污染，后续路由和切换成本很高。

## 决策

网关内部定义版本化 Canonical Request/Response，所有 Provider 实现统一的 `ModelProvider` 接口。外部 OpenAI-compatible API 只是一种入口协议，不等于内部领域模型。

逻辑模型名与 Provider 部署名分离：应用请求 `general`，Provider Registry 决定它实际映射到哪个 Provider 和模型。

## 结果

正面影响：

- HTTP 协议、策略链和 Provider 适配相互隔离。
- 后续可以在不修改应用的情况下做模型切换和 fallback。
- 测试可使用 Mock Provider，不依赖外部 API 或密钥。
- Provider 错误和 Usage 可以在同一层归一化。

代价：

- Canonical Schema 需要版本管理。
- 供应商特有能力不能假装成完全可互换，需要能力发现或显式扩展字段。
- 每增加一个 Provider 都需要维护适配与契约测试。

## 后续

Iteration 2 将扩展 Canonical Stream Event，并实现真实 Provider Adapter。任何供应商专有字段必须明确决定：提升为公共能力、放入扩展字段，或返回不支持错误，不能静默丢弃。
