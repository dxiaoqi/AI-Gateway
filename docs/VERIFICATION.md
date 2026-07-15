# 当前版本验证手册

适用版本：`0.18.0`。

验证分为三层。第一层不启动端口、不访问真实模型，适合每次提交前执行；第二层验证真实 HTTP/SSE；第三层显式调用你配置的真实 Provider，会消耗少量 Token。

## 1. 零成本自动验证

```bash
npm install
npm run verify
```

`npm run verify` 依次执行：

```text
TypeScript strict typecheck
→ Vitest 单元与 HTTP 集成测试
→ Gateway TypeScript production build
→ Next.js production build
```

当前基线预期：

```text
Test Files: 20 passed, 2 integration files skipped
Tests:      85 passed, 3 integration tests skipped
Gateway build: success
Next.js build: success
```

覆盖范围：此前全部能力，以及模型部署热发布、动态配额、成本预算、Guardrail 阻断、OIDC 签名与 Claims、tenant scope、双人轮换、BFF 路径限制和生产构建。

只验证 Iteration 15–18：

```bash
npx vitest run test/governance-http.test.ts
```

预期 3 项端到端测试通过，分别覆盖模型热启停、配额/护栏执行、计费/预算阻断。

Redis 集成测试默认跳过，避免要求每位新人先安装 Redis。需要验证真实 Lua 时：

```bash
docker compose up -d redis
REDIS_TEST_URL=redis://127.0.0.1:6380 npm run test:redis
docker compose down
```

预期额外 2 项测试通过。

## 2. 本地 HTTP/SSE 冒烟验证

终端 A：

```bash
npm run build
npm start
```

终端 B：

```bash
npm run smoke
```

默认 smoke 只调用本地 `general` Mock 模型，不访问真实 Provider，不产生模型费用。它验证：

- `/health/ready`
- 认证后的 `/v1/models`
- 非流式 OpenAI-compatible 响应
- SSE Content-Type
- `[DONE]` 结束事件
- 所有流式 chunk 的 response id 一致
- `finish_reason=stop`
- 受保护的 `/metrics` 及核心指标族

预期输出：

```json
{
  "status": "passed",
  "visibleModels": ["external", "general"],
  "external": "skipped"
}
```

如果使用 `GATEWAY_VIRTUAL_KEYS_JSON` 而没有设置旧的 `GATEWAY_API_KEY`，为 smoke 单独提供一个有权访问 `general` 的 Key：

```bash
SMOKE_GATEWAY_API_KEY='你的测试虚拟Key' npm run smoke
```

## 3. 真实 Provider 验证

确认 `.env` 已配置 `OPENAI_COMPAT_BASE_URL`、`OPENAI_COMPAT_MODEL` 和必要时的 `OPENAI_COMPAT_API_KEY`，然后在网关运行期间执行：

```bash
SMOKE_EXTERNAL=true npm run smoke
```

脚本会向 `external` 发送一个最多 8 个输出 Token 的请求。输出只包含 Provider 名称、实际模型和 usage，不输出任何密钥。

本轮实际验证记录：

```text
HTTP 200
logical model: external
provider: openai-compatible
provider model: gpt-4.1-mini-2025-04-14
usage: 12 input + 2 output
usage estimated: false
```

## 4. 多部署失败切换验证

零成本的自动验证已在 `test/model-router.test.ts` 和 `test/routing-http.test.ts` 中模拟主部署故障，无需真实关闭供应商：

```bash
npx vitest run test/model-router.test.ts test/routing-http.test.ts
```

预期 8 项通过。HTTP 响应中的关键证据为：

```json
{"gateway":{"provider":"secondary-provider","deployment":"secondary","route_attempts":2}}
```

流式测试还会断言：主部署发出首事件后再失败，备用部署调用次数为 0。

## 5. 手工检查模型 ACL

为两个虚拟 Key 配置不同 `allowedModels`，启动后分别调用：

```bash
curl http://127.0.0.1:3000/v1/models \
  -H 'Authorization: Bearer YOUR_KEY'
```

调用越权模型：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Authorization: Bearer LIMITED_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "external",
    "messages": [{"role": "user", "content": "should be denied"}]
  }'
```

预期为 HTTP 403：

```json
{
  "error": {
    "type": "authorization_error",
    "code": "authorization_error"
  }
}
```

## 6. 手工检查 Metrics 与 Trace

先产生一条请求，再抓取指标：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Authorization: Bearer local-development-key' \
  -H 'Content-Type: application/json' \
  -d '{"model":"general","messages":[{"role":"user","content":"metrics demo"}]}'

curl http://127.0.0.1:3000/metrics \
  -H 'Authorization: Bearer local-development-metrics-key'
```

应看到 `aigw_http_requests_total`、`aigw_provider_requests_total`、`aigw_provider_request_duration_seconds` 和 `aigw_tokens_total`。使用业务 Key 请求 `/metrics` 应返回 401。

Trace 验证：

```bash
curl -i http://127.0.0.1:3000/health/ready \
  -H 'traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01'
```

响应 `traceparent` 应保留 `aaaaaaaa...` trace id，但 span id 不再是 `bbbb...`。

## 7. 安全检查

```bash
git check-ignore -v .env
npm audit --omit=dev
```

确认：

- `.env` 被 `.gitignore` 排除。
- 日志不包含 Authorization、Provider Key、Key Hash 或 Prompt 正文。
- `NODE_ENV=production` 下短 Key、短 Pepper 或缺少必要 Key 会使进程启动失败。

## 8. Prometheus/Grafana/Alertmanager 完整验证

先启动网关，然后验证所有配置与合成告警：

```bash
npm run build
npm start
```

另一个终端：

```bash
npm run test:observability
npm run observability:up
npm run smoke
npm run observability:check
```

预期 `observability:check`：

```json
{
  "status": "passed",
  "recordingRules": 9,
  "alertRules": 7,
  "dashboard": "AI Gateway Overview"
}
```

访问地址：

- Grafana：`http://127.0.0.1:3001`
- Prometheus Targets：`http://127.0.0.1:9090/targets`
- Prometheus Alerts：`http://127.0.0.1:9090/alerts`
- Alertmanager：`http://127.0.0.1:9093`

本地 Grafana 默认账号仅用于开发：`admin / local-admin-change-me`。生产必须覆盖密码并放在 Secret Manager 中。

结束后：

```bash
npm run observability:down
```

## 9. Review 时应重点观察

- `general` 与 `external` 是逻辑模型名，不是 Provider 部署名。
- Provider 失败发生在 SSE Header 之前时，应返回 JSON 错误；Header 之后只能返回 SSE error event。
- 首 Token 发出后不进行模型切换。
- 只有 Provider 类故障会切换；客户端请求错误、权限错误和网关配额错误不会重试。
- 路由健康状态当前在单进程内存中，多实例间不会共享熔断结果。
- Metrics 标签不能加入 request id、原始 URL、Tenant、Key、Prompt 等无界值。
- `/metrics` 是全局运行数据，必须使用独立凭据并限制网络访问。
- 当前 Trace 是关联上下文，还不是完整 OpenTelemetry Span 导出。
- Recording Rule 先计算 SLI，Alert Rule 再加阈值、流量门槛和持续时间，避免短抖动告警。
- 本地 Alertmanager Receiver 不发送外部消息；生产必须配置真实通知渠道和责任人。
- `/v1/models` 的过滤不能替代调用路径 ACL，两处必须同时存在。
- 未配置 DATABASE_URL 时 Key 仓库仍是内存兼容模式；数据库模式才具备动态吊销和多实例一致读取。
- 配额必须在 Provider 调用前预留，否则并发请求会同时穿透额度。
- 请求结束后只把预留 Token 调整成实际 Usage；RPM 不退款，避免失败请求被用于绕过流量保护。
- Redis 预留必须一次检查所有匹配层级，不能出现租户已扣、应用却拒绝的半完成状态。

## 10. PostgreSQL 控制面验证

警告：集成测试会清空轮换申请、审计和虚拟 Key 表。只使用下面的本地测试库，禁止把 `POSTGRES_TEST_URL` 指向共享或生产数据库。

```bash
npm run control-plane:up
POSTGRES_TEST_URL='postgres://aigateway:aigateway-local@127.0.0.1:5433/aigateway' npm run test:postgres
```

预期：PostgreSQL 容器 healthy，`1 passed`。测试覆盖 Schema v4 连续迁移、创建、即时禁用、旧版本冲突、租户范围、批准/拒绝/撤销理由、申请过期、个人通知已读、并发批准仅一次成功、旧 Key 失效、新 Key 生效和无秘密审计。

真实 HTTP 生命周期需要两个终端。终端 A：

```bash
DATABASE_URL='postgres://aigateway:aigateway-local@127.0.0.1:5433/aigateway' \
ADMIN_BEARER_TOKEN='local-control-plane-admin-token' \
DATABASE_AUTO_MIGRATE=true \
CONTROL_PLANE_SEED_FROM_ENV=false \
METRICS_ENABLED=false \
npm start
```

终端 B：

```bash
ADMIN_BEARER_TOKEN='local-control-plane-admin-token' npm run smoke:control-plane
```

预期输出：

```text
Control-plane smoke passed for smoke-...: create -> disable -> enable -> rotate -> audit
```

该脚本不打印创建出的 Key、不调用真实模型，只访问 Mock 模型列表。结束后：

```bash
npm run control-plane:down
```

Named Volume 会保留，容器移除后下次启动数据仍在。若确实要清空本地库，必须显式删除 Volume；日常命令不会执行该破坏性操作。

## 11. OIDC/JWT、Tenant Scope 与双人审批验证

执行本地真实网络冒烟：

```bash
npm run smoke:oidc
```

脚本会：

1. 临时生成 RSA 私钥和 JWKS 公钥。
2. 启动本地 JWKS HTTP Server。
3. 启动配置为 OIDC 模式的真实 Gateway 监听端口。
4. 签发两个租户的 viewer/operator/admin、第二位同租户 admin 和错误 audience JWT。
5. 验证 viewer 只读、operator 能创建但不能轮换，tenant-a 看不到 tenant-b 数据。
6. 验证生产式直接轮换被拒绝、申请人不能自批、第二位同租户 admin 批准成功。
7. 验证审计保存 requester/approver subject、issuer、roles 和 tenant scopes。
8. 验证多个 JWT 只抓取一次 JWKS。

预期：

```text
OIDC smoke passed: JWKS -> JWT -> tenant scope -> RBAC -> two-person rotation -> actor audit; JWKS fetched once
```

脚本不访问真实 IdP、不打印 JWT、不调用模型。真实企业 IdP 接入还必须人工验证：错误 issuer、错误 API audience、过期 Token 为 401；缺失 tenant Claim 返回空列表且资源操作 403；tenant-a Token 看不到 tenant-b；operator 轮换为 403；申请人自批为 409；第二位同租户 admin 批准成功。

特别检查：

- 401 表示 Token 无法建立身份，403 表示身份有效但角色不足。
- 不得通过解码但未验签的 JWT 决定权限。
- `ADMIN_OIDC_ALLOWED_ALGORITHMS` 只能包含批准的非对称算法。
- 生产静态模式默认启动失败；break-glass 必须显式设置 override 并经过审批。
- `*` 代表全局租户范围，只能发给极少的平台管理员；普通管理员必须明确列出 tenantId。
- 生产保持 `ROTATION_APPROVAL_REQUIRED=true`，批准前必须核对申请绑定的 Key version。

## 12. Next.js 管理后台验证

先按[管理后台操作手册](./runbooks/admin-console.md)启动 PostgreSQL、Gateway 和 Console，然后：

```bash
ADMIN_CONSOLE_TOKEN='你的本地管理员Token' npm run smoke:admin
```

预期：

```text
Admin console smoke passed: session -> CSRF -> key -> request/cancel reason -> status filter -> notification/read -> audit -> logout
```

脚本实际经过两个端口和真实 PostgreSQL：

1. GET Next 页面，确认标题和防 iframe Header。
2. 不带 Session 调 BFF 得到 401。
3. 尝试代理非 `/admin/v1` 路径得到 404。
4. 本地登录把 Token 换成 HttpOnly 服务端 Session。
5. 无 CSRF 的写请求得到 403；正确 Origin + CSRF 可写入。
6. 经 BFF 创建并禁用 Key，验证 `If-Match` 透传。
7. 创建轮换申请，确认过短理由返回 400，再由申请人带理由撤销。
8. 用 `status=cancelled` 查到终态，并读取/标记站内通知。
9. 再查 Key 与审计，确认状态和审计已经落库。
10. 跨站退出得到 403；正常退出后旧 Cookie 调 Session/BFF 均为 401。

该脚本会创建 `console-smoke-*` 测试 Key，只能用于本地测试数据库。它不会调用模型或打印 Token/新 Key。

完整 OIDC 协议本地验证（保持 Gateway 运行，不要占用 3100）：

```bash
ADMIN_CONSOLE_TOKEN='你的本地管理员Token' npm run smoke:admin-oidc
```

预期包含：

```text
Admin OIDC flow smoke passed: discovery -> state/nonce -> PKCE S256 -> code exchange -> ID token -> server session -> BFF
```

手工浏览器检查：打开 `http://127.0.0.1:3100`，登录后确认审批状态筛选、决策理由弹窗、通知未读角标与标记已读；刷新后应保持登录，退出后刷新应回到登录页。

当前 `npm audit` 有 2 个 moderate，均来自 Next.js 16.2.10 固定的 PostCSS 8.4.31 和同一公告。项目不处理用户 CSS，当前利用路径不可达；禁止执行会降级到 Next 9 的 `npm audit fix --force`，详见 [Iteration 11 依赖审计例外](./iterations/iteration-11-nextjs-admin-console.md#10-依赖审计例外)。
