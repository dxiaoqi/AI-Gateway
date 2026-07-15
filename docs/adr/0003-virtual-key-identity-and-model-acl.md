# ADR 0003：虚拟 Key 身份上下文与模型 ACL

- 状态：Accepted
- 日期：2026-07-15

## 背景

单一共享 API Key 无法回答“谁在调用、成本归属哪个项目、能否使用某个模型”。如果只在 `/v1/models` 隐藏模型但调用接口不校验，还会形成直接越权路径。明文 Key 进入数据库或日志也会扩大泄露风险。

## 决策

采用以下层级身份：

```text
Virtual Key
  → Tenant
  → Project
  → Application
  → Allowed Logical Models
```

虚拟 Key 使用带服务端 Pepper 的 HMAC-SHA256 摘要查找。认证成功后，只把非敏感的 `keyId`、`tenantId`、`projectId`、`applicationId` 和 `allowedModels` 放入请求上下文。

模型权限同时在两个位置执行：

- `GET /v1/models` 只返回调用方可见的逻辑模型。
- 调用模型前执行 ACL；无权限返回 403，未知模型在有通配权限时返回 404。

健康检查只有 `/health/live` 和 `/health/ready` 两个精确路径免认证。生产环境要求 Key 和 Pepper 至少 32 个字符。

## 结果

正面影响：

- 后续 Token、预算、日志和计费天然具有租户归属。
- 模型发现与模型调用使用相同授权语义。
- 认证仓库只保存不可逆摘要，不保存原始 Key。
- `AuthService` 依赖仓库接口，后续可替换 PostgreSQL。

代价与限制：

- 当前配置仍通过环境变量输入原始 Key，适合引导期而非大规模生命周期管理。
- 当前仓库在进程内，Key 变更需要重启。
- HMAC Pepper 轮换需要双 Pepper 验证或批量重新摘要方案。
- OIDC、Workload Identity、Key 吊销时间和管理审计尚未实现。
