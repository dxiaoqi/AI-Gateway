# Enterprise AI Gateway

一个以可运行迭代方式建设的 Node.js/TypeScript 企业 AI Gateway。目前完成 **Iteration 19**：除模型部署、动态配额、成本预算和 Guardrail 外，在没有企业 OIDC 时也可首次注册唯一主组织 Owner，并使用用户名密码进入管理后台。Iteration 14 外部通知按产品优先级后置。

更完整的能力与实施路线见 [AI_GATEWAY_RESEARCH.md](./AI_GATEWAY_RESEARCH.md)。

详细设计、每轮实现记录、ADR 与 Review 入口见 [docs/README.md](./docs/README.md)。

## 环境要求

- Node.js 20.18+
- npm 10+

## 本地启动

```bash
npm install
cp .env.example .env
npm run dev
```

启动入口会自动读取项目根目录的 `.env`，系统环境变量优先级更高。生产环境必须设置强随机的 Key 和 `GATEWAY_KEY_PEPPER`，两者至少 32 个字符。

服务默认监听 `http://localhost:3000`。

## 发起请求

```bash
curl http://localhost:3000/v1/chat/completions \
  -H 'Authorization: Bearer local-development-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "general",
    "messages": [
      {"role": "user", "content": "你好，AI Gateway"}
    ]
  }'
```

当前 `general` 是逻辑模型名，映射到本地 Mock Provider。响应中的 `gateway` 字段用于展示实际 Provider、部署、路由尝试次数、Provider 模型、request id 和 usage 是否为估算值。

查看当前 Key 有权使用的模型：

```bash
curl http://localhost:3000/v1/models \
  -H 'Authorization: Bearer local-development-key'
```

流式调用：

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H 'Authorization: Bearer local-development-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "general",
    "stream": true,
    "messages": [{"role": "user", "content": "流式回答"}]
  }'
```

### 接入 OpenAI-compatible Provider

设置以下环境变量后，网关会注册默认名为 `external` 的逻辑模型：

```bash
export OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1
export OPENAI_COMPAT_MODEL=your-provider-model
export OPENAI_COMPAT_API_KEY=your-secret
export OPENAI_COMPAT_LOGICAL_MODEL=external
npm run dev
```

对于开发环境中不要求鉴权的本地 vLLM 等 Provider，可以不设置 `OPENAI_COMPAT_API_KEY`。不要把真实密钥写入仓库或提交 `.env`。

同一个逻辑模型需要主备或加权部署时，使用 `OPENAI_COMPAT_DEPLOYMENTS_JSON`。JSON 只写密钥所在的环境变量名，不直接写密钥：

```bash
export PRIMARY_PROVIDER_KEY=your-primary-secret
export BACKUP_PROVIDER_KEY=your-backup-secret
export OPENAI_COMPAT_DEPLOYMENTS_JSON='[{"id":"primary","logicalModel":"external","baseUrl":"https://api.openai.com/v1","providerModel":"model-a","apiKeyEnv":"PRIMARY_PROVIDER_KEY","priority":1,"weight":80},{"id":"backup","logicalModel":"external","baseUrl":"https://provider-b.example/v1","providerModel":"model-b","apiKeyEnv":"BACKUP_PROVIDER_KEY","priority":2,"weight":20}]'
```

数字越小优先级越高；只有同一优先级内才按 `weight` 分流。默认单次请求最多尝试 3 个不同部署。429 会短时冷却该部署，连续 Provider 故障达到阈值会打开熔断器。

### 配置多租户虚拟 Key

`GATEWAY_API_KEY` 是向后兼容的单 Key 开发模式。多租户模式使用一行 JSON：

```bash
GATEWAY_KEY_PEPPER=replace-with-strong-random-pepper
GATEWAY_VIRTUAL_KEYS_JSON=[{"keyId":"team-a-key","key":"aigw_replace_with_strong_random_key","tenantId":"tenant-a","projectId":"project-a","applicationId":"assistant-a","allowedModels":["general","external"]}]
```

网关启动时使用 HMAC-SHA256 和 Pepper 生成 Key 摘要，认证仓库不保存明文。每个请求会获得 `tenantId`、`projectId`、`applicationId` 和模型权限；`/v1/models` 以及实际模型调用执行相同 ACL。不设置 `DATABASE_URL` 时继续使用这套兼容模式。

### 启用 PostgreSQL 虚拟 Key 控制面

```bash
npm run control-plane:up
DATABASE_URL='postgres://aigateway:aigateway-local@127.0.0.1:5433/aigateway' npm run db:migrate
```

本地开发可使用静态管理员 Token：

```dotenv
DATABASE_URL=postgres://aigateway:aigateway-local@127.0.0.1:5433/aigateway
ADMIN_AUTH_MODE=static
ADMIN_BEARER_TOKEN=local-development-admin-key-change-me
DATABASE_AUTO_MIGRATE=false
CONTROL_PLANE_SEED_FROM_ENV=false
```

生产环境默认禁止共享静态 Token，应改为企业 OIDC：

```dotenv
ADMIN_AUTH_MODE=oidc
ADMIN_OIDC_ISSUER=https://identity.example.com/tenant
ADMIN_OIDC_AUDIENCE=ai-gateway-admin
ADMIN_OIDC_JWKS_URL=https://identity.example.com/tenant/.well-known/jwks.json
ADMIN_OIDC_ROLE_CLAIM=groups
ADMIN_OIDC_TENANT_CLAIM=ai_gateway_tenants
ADMIN_OIDC_ROLE_MAP_JSON={"ai-gateway-viewers":"viewer","ai-gateway-operators":"operator","ai-gateway-admins":"admin"}
ADMIN_OIDC_ALLOWED_ALGORITHMS=RS256
ADMIN_OIDC_TOKEN_TYP=JWT
ROTATION_APPROVAL_REQUIRED=true
ROTATION_APPROVAL_TTL_MS=900000
```

创建/批准轮换时原始 Key 只返回一次；数据库只存 HMAC 摘要。更新和轮换申请必须带当前版本 `If-Match`。OIDC/RBAC 接入见 [管理员身份手册](./docs/runbooks/admin-oidc-rbac.md)，Key 日常操作见 [控制面操作手册](./docs/runbooks/control-plane-key-operations.md)，生产轮换见 [租户访问与双人轮换手册](./docs/runbooks/tenant-access-and-rotation-approval.md)。

### 启动 Next.js 管理后台

管理后台是独立 workspace，默认监听 `http://127.0.0.1:3100`。开发环境没有配置 static/OIDC 时，Gateway 默认启用本地 Owner 模式。最短启动方式：

```bash
npm run dev
# 另一个终端
npm run admin:dev
```

打开 `http://127.0.0.1:3100`：第一次填写组织名称、Owner 用户名和强密码，创建后注册入口自动关闭，以后直接用该账号登录。账号文件默认保存在 `.data/admin-local-owner.json`，已被 Git 忽略。浏览器只保留 HttpOnly Cookie，不持有 Gateway Access Token。

没有 `DATABASE_URL` 时，Owner 账号会持久化，但 Key 和治理策略仍是内存控制面，重启会恢复环境种子；正式使用应配置 PostgreSQL。多实例或大型企业生产环境仍推荐 OIDC。完整配置、协议说明和排障见 [管理后台操作手册](./docs/runbooks/admin-console.md)。

健康检查：

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

### 查看 Prometheus 指标

`/metrics` 使用独立凭据，不接受普通业务虚拟 Key：

```bash
curl http://localhost:3000/metrics \
  -H 'Authorization: Bearer local-development-metrics-key'
```

生产环境启用指标时必须设置至少 32 个字符的 `METRICS_BEARER_TOKEN`。指标包含 HTTP 数量/延迟、Provider 尝试/活跃数/延迟、路由健康事件和 Token；不把 request id、租户、Key 或 Prompt 放进标签。

客户端可以发送标准 W3C `traceparent`。网关保留 trace id、生成新的 span id，在响应 Header 和结构化日志中返回，并继续传给 OpenAI-compatible Provider。

### 启动完整监控栈

先保持网关运行，再执行：

```bash
npm run test:observability
npm run observability:up
npm run smoke
npm run observability:check
```

Grafana 位于 `http://127.0.0.1:3001`，本地默认账号为 `admin / local-admin-change-me`。Dashboard、Prometheus 抓取配置、9 条 Recording Rule 和 7 条告警全部在 `observability/` 中版本化。生产必须覆盖 Grafana 密码、Metrics Token 文件和 Alertmanager Receiver。

关闭监控组件（不会停止 Redis，也不会删除监控数据 Volume）：

```bash
npm run observability:down
```

## 开发验证

```bash
npm run verify
```

完整验证分层、预期结果、真实 HTTP/SSE 和可选真实 Provider 检查见 [当前版本验证手册](./docs/VERIFICATION.md)。本地网络冒烟需要先在一个终端执行 `npm start`，再在另一个终端执行 `npm run smoke`；默认只调用 Mock Provider，不产生模型费用。

Redis 配额集成测试：

```bash
docker compose up -d redis
REDIS_TEST_URL=redis://127.0.0.1:6380 npm run test:redis
docker compose down
```

PostgreSQL 控制面集成测试会清空指定测试库中的 Key/审计表，只能指向本地测试库：

```bash
npm run control-plane:up
POSTGRES_TEST_URL='postgres://aigateway:aigateway-local@127.0.0.1:5433/aigateway' npm run test:postgres
npm run control-plane:down
```

本地真实 JWKS/JWT/RBAC 冒烟：

```bash
npm run smoke:oidc
```

脚本临时生成 RSA Key，启动本地 JWKS 和 Gateway，验证 viewer/operator/admin、错误 audience、租户隔离、双人轮换和 actor 审计，不需要真实 IdP。

## 当前范围

已完成：

- `POST /v1/chat/completions`
- `GET /v1/models`，按调用方模型权限过滤
- OpenAI-compatible 请求/响应基础格式
- Canonical Request/Response
- Canonical Stream Event 与 SSE 分片解析
- `ModelProvider` 接口及 Provider Registry
- Mock Provider 与 `general` 逻辑模型
- 可配置 OpenAI-compatible Provider 与 `external` 逻辑模型
- SSE 背压、客户端断连取消、上游 timeout 和 usage 尾块
- 多虚拟 Key、HMAC-SHA256 摘要和 Tenant/Project/Application 上下文
- 模型 ACL 与标准 401/403 错误
- Tenant/Project/Application/Key 分层配额策略
- RPM、TPM、最大并发与调用前原子预留
- Provider Usage 结算和未使用 Token 退款
- 内存 Store 与 Redis Lua 多实例 Store
- 一个逻辑模型注册多个部署
- 优先级路由、同级权重分流和有限失败切换
- Provider 429 冷却、连续故障熔断和半开恢复探测
- 流式首事件前可切换，首事件后禁止拼接其他部署回答
- 独立凭据保护的 Prometheus `/metrics`
- HTTP、Provider、路由事件和 Token 低基数指标
- W3C `traceparent` 延续、响应回传、日志关联和 Provider 透传
- 固定版本的 Prometheus、Alertmanager 和 Grafana 本地栈
- 9 条 SLI Recording Rule、7 条告警和 promtool 合成告警测试
- 自动 Provision 的 11 面板 Grafana Dashboard
- Alertmanager 分组、重复间隔、Target Down 抑制和新人值班手册
- PostgreSQL 持久化虚拟 Key 与版本化 Schema migration
- 管理端创建、列出、启停、模型权限修改、轮换和审计 API
- 一次性原始 Key 返回、HMAC 摘要存储和独立 Admin Token
- `If-Match` 乐观并发控制、变更与审计同事务
- 数据库模式下禁用/轮换即时生效和 PostgreSQL Readiness
- 企业 OIDC JWT 管理员认证和远程 JWKS 公钥缓存
- issuer、audience、expiration、subject、typ 与算法白名单验证
- viewer/operator/admin 路由级 RBAC 权限矩阵
- actor subject、issuer、roles 和认证方式的 PostgreSQL 审计
- 生产环境静态 Admin Token 默认禁用与显式 break-glass
- JWT tenant scope、缺失范围默认拒绝与跨租户对象写保护
- Key、审计和轮换申请列表的 Repository/SQL 层租户过滤
- 生产默认双人 Key 轮换审批、自批/过期/陈旧版本保护
- PostgreSQL 行锁和 pending 唯一约束保证并发批准最多一次成功
- 轮换 reject/cancel、必填决策理由与五态审批状态机
- 租户级站内通知、定向结果通知和每管理员独立已读回执
- Next.js App Router + React + TypeScript 独立管理后台
- 身份总览、Key 创建/搜索/启停/模型权限、轮换审批和审计工作台
- 只代理 `/admin/v1` 的同源 BFF，Gateway 内部地址保持服务端配置
- OIDC Authorization Code + PKCE、state、nonce 与 JWKS ID Token 验证
- Redis/内存服务端 Session、HttpOnly Cookie、CSRF、退出与过期控制
- 浏览器不持有 Gateway Access Token；一次性 Key 专用提示与关闭清除
- PostgreSQL 模型部署目录、凭证引用、启停与进程内热发布
- 租户/项目/应用/Key 四级动态 RPM、TPM、并发策略管理
- CNY/USD 模型定价、本月用量聚合与租户月度预算硬阻断
- PII、Prompt Injection、Content Safety 租户 Guardrail 基线
- 统一治理资源 RBAC、Tenant Scope、If-Match 乐观锁和治理审计
- Next.js 模型、配额、成本预算和安全护栏管理页面
- 首次启动主组织 Owner 注册、scrypt 密码摘要与本地账号登录
- 短期签名管理员 Token、登录失败限速和 local Actor 审计
- 上游超时与统一错误格式
- JSON Schema 请求校验
- 健康检查和优雅退出
- 结构化请求完成日志
- 单元与 HTTP 集成测试

明确未实现：

- Anthropic 原生协议与 Tool Calling（按当前产品方向明确后移）
- Provider 账单对账、原子预算预留、预算预警投递和多币种汇率
- 跨网关实例共享的路由健康状态与全局自适应负载均衡
- OpenTelemetry SDK/Collector 导出与分布式 Span
- 外部邮件/IM/Webhook 通知投递、正式 SLO 审批和团队级责任人轮值
- project/application 细粒度管理员范围、专业 DLP/内容安全服务和输出护栏
- 本地成员邀请、密码找回/MFA、多实例账号仓库与紧急 Token 吊销

这些能力会按照迭代计划逐步加入，避免在核心协议与流式行为稳定前过早引入分布式状态。OpenAI-compatible Adapter 已可连接真实服务，但当前自动化测试完全使用可注入 HTTP Client，不消耗模型额度。

## 目录

```text
src/
├── admin-auth/ # OIDC/JWT、JWKS、角色映射和管理 API RBAC
├── auth/       # 虚拟 Key、认证仓库、租户上下文和模型 ACL
├── control-plane/ # PostgreSQL migration、Key 生命周期、审计和运行时
├── core/       # Canonical schema、错误与请求上下文
├── governance/ # 模型、动态配额、定价预算、Guardrail 与用量聚合
├── providers/  # Provider 接口、实现和逻辑模型注册
├── quota/      # Token 估算、策略匹配、预留/结算和 Redis Store
├── routing/    # 多部署选择、冷却、熔断和失败切换
├── observability/ # Prometheus 指标、路由观察接口和 Trace 上下文
├── server/     # Fastify 应用、Schema 和 HTTP 路由
├── config.ts
└── index.ts
test/           # 单元与 HTTP 集成测试
observability/  # Prometheus、Alertmanager、Grafana、规则、Dashboard 与开发 Secret 样例
docs/adr/       # 架构决策记录
apps/admin-console/ # Next.js App Router 管理后台与受限 BFF
```

## 安全说明

默认 Key、静态 Admin Token 和 Pepper 只用于本地开发。服务不会记录 Authorization Header、JWT、Key 摘要或请求正文；普通日志只记录哈希化 actor id 和内部 roles。受控的 PostgreSQL 审计表会保存 subject、issuer、roles 和 tenant scopes，用于责任追溯，因此必须配置数据库访问控制与保留期限。生产应使用 OIDC，为每名管理员签发权威 tenant scope，并保持双人轮换开启。当前 Guardrail 是正则基线而非专业 DLP；project/application 细粒度管理员范围和 Pepper 在线轮换仍属于后续迭代。
