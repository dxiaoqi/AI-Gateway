# Iteration 15：模型部署管理

- 版本：0.15.0（与 15–18 合并交付后仓库版本为 0.18.0）
- 日期：2026-07-15
- 状态：Completed
- 关联 ADR：[ADR 0015](../adr/0015-governance-resources-and-runtime-enforcement.md)

## 0. 一句话说明

管理员可以在后台创建、启停模型部署，发布后无需重启即可改变模型路由。

## 1. 30 秒领导摘要

| 领导关心的问题 | 回答 |
|---|---|
| 以前的问题 | 模型部署只在环境变量里，变更依赖开发和重启 |
| 本轮交付 | 模型部署数据库、API、后台表单、RBAC、租户边界、版本保护和热发布 |
| 业务价值 | 模型供应商切换从“改代码”变为受控运营动作 |
| 验证证据 | 自动化验证创建后立即可调用，停用后立即返回模型不存在 |
| 最大剩余风险 | 供应商凭证仍通过环境变量注入，尚未连接 Vault/KMS |

### 最短演示

后台进入“模型部署”，创建一个 `mock` 部署；调用该逻辑模型成功；点击停用后再次调用得到 `model_not_found`。

## 2. 新人工程师导读

| 术语 | 小白解释 | 前端类比 |
|---|---|---|
| 逻辑模型 | 调用方看到的稳定模型名 | 前端调用的稳定 API 路径 |
| 部署 | 逻辑模型背后的真实供应商实例 | API 路径后面的某台服务 |
| priority | 哪组部署先尝试，数字越小越优先 | 路由匹配优先级 |
| weight | 同优先级部署的流量比例 | A/B 实验权重 |
| credentialEnv | API Key 所在环境变量名 | 只保存 Secret 的引用，不保存值 |

一次发布：表单提交 → 网关验证管理员权限和全局范围 → 校验供应商配置与凭证引用 → PostgreSQL 写入并审计 → 更新 Provider Registry → 新请求按新部署选路。

## 3. 目标与非目标

目标：模型部署 CRUD 的创建、列表、启停，乐观锁，热生效，不泄露凭证。

非目标：删除部署、在线修改全部字段、Vault/KMS、按地域和质量动态路由。

## 4. 详细设计

- 模型部署属于全局资源，`tenantId` 必须为 `*`，普通租户管理员不能发布全局模型。
- OpenAI-compatible 部署保存 `baseUrl`、`providerModel` 和 `credentialEnv`；服务验证引用的环境变量已经配置。
- `If-Match` 必须等于当前版本，避免两位管理员互相覆盖。
- 启用时 `upsert` Registry；停用时删除部署。逻辑模型没有可用部署就按现有语义返回 404。
- PostgreSQL 启动时载入已启用部署，自动迁移由 schema version 5 保证。

## 5. 代码导读

| 文件 | 职责 |
|---|---|
| `src/governance/service.ts` | 校验部署并热发布 |
| `src/providers/registry.ts` | 支持 upsert/remove |
| `src/server/routes/admin-governance.ts` | 管理 API、RBAC、If-Match |
| `components/governance-panel.tsx` | 对新人友好的部署表单与列表 |

## 6. 测试与手工验证

自动化覆盖：创建并即时调用、错误版本冲突、正确版本停用、停用后路由不可用。执行：

```bash
npx vitest run test/governance-http.test.ts
npm run admin:build
```

## 7. 已知限制

- 只支持 `mock` 和 `openai-compatible`；Anthropic 原生协议继续暂缓。
- 创建后目前只能启停，修改 endpoint/权重可通过 API 更新完整 `spec`，后台字段编辑将在后续增强。
- 多实例会各自在启动时加载，运行期间的热发布只更新收到管理请求的实例；生产需配置变更广播。
