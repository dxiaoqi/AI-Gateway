# ADR 0011：独立 Next.js 管理后台与受限 BFF

- 状态：Accepted
- 日期：2026-07-15
- 版本：0.11.0

## 背景

Iteration 10 已经有完整的管理 API、OIDC/RBAC、Tenant Scope 和双人轮换，但日常操作仍依赖 curl。传统前端背景的运营和领导无法直观看到“谁能看哪些租户、哪些 Key 待审批、操作是否已审计”。继续把 HTML 字符串嵌入 Fastify 虽然依赖少，但会很快遇到组件复用、页面路由、错误状态和未来 OIDC Callback 难维护的问题。

## 决策

在同一仓库建立 `apps/admin-console`，使用 Next.js App Router、React 和 TypeScript。Gateway 与 Console 是两个进程：

```text
Browser :3100
  → Next.js UI
  → same-origin /api/gateway/admin/v1/*
  → restricted Route Handler / BFF
  → Gateway :3000 /admin/v1/*
  → PostgreSQL
```

具体边界：

1. React 只根据角色改善体验；Gateway 仍执行所有 RBAC、Tenant Scope、If-Match 和审批状态校验。
2. 浏览器只调用 Next.js 同源 BFF，不在 Gateway 开启宽泛 CORS。
3. BFF 只允许 `admin/v1/`，拒绝空、`.`、`..`、斜杠和反斜杠异常路径，禁止跟随上游 Redirect。
4. `GATEWAY_API_BASE_URL` 是 Next.js 服务端变量，不使用 `NEXT_PUBLIC_` 暴露内部地址。
5. 本轮 Token 由用户粘贴，只保存在 React 内存；不写 localStorage、sessionStorage、Cookie 或 URL。
6. 一次性 Key 只在创建/批准响应后的专用弹层显示，关闭后从组件状态清除。

## 为什么使用 Next.js

- App Router 默认 Server Component，交互工作台用清晰的 `use client` 边界。
- Route Handler 可作为同源 BFF，为后续 OIDC Callback、短期服务端 Session 和 CSRF 控制留接口。
- 能独立构建和部署，不把前端发布周期绑死在 Gateway 数据面进程上。
- 当前项目 Node.js 20.18 高于 Next.js 16 的最低 Node.js 20.9 要求。

## 未选择方案

| 方案 | 未选择原因 |
|---|---|
| Fastify 内嵌原生 HTML/JS | 首版快，但组件、路由、认证回调和测试边界会快速恶化 |
| 浏览器直连 Gateway + CORS | 扩大管理 API 浏览器暴露面，运行时内部地址也进入客户端配置 |
| 把权限判断放进 Next.js Server Action | 会形成第二套授权真相，仍可能被直接调用 Gateway 绕过 |
| 本轮直接接完整 OIDC 登录 | 企业 IdP 参数、Redirect URI、PKCE/Session/CSRF 选择尚需客户确认 |

## 代价与风险

- 增加第二个 Node.js 进程、React/Next.js 依赖和前端供应链维护。
- 手工 Token 对非工程用户仍不友好，也不能自动续期。
- Token 每次请求会经过 Next.js BFF 内存；必须保持 Header 不落日志。
- Next.js 16.2.10 当前固定的 PostCSS 8.4.31 命中 GHSA-qx2v-qp2m-jg93。该漏洞需要构建时处理不可信 CSS，本项目只编译仓库静态 CSS，暂不具备利用路径；不能采用 npm 建议的 Next 9 破坏性降级，需跟踪上游升级。

## 后续

- 用 Authorization Code + PKCE 接企业 OIDC，并采用 HttpOnly、Secure、SameSite Session。
- 加入 CSRF、防重放、Session 续期和显式退出。
- 审批 reject/cancel、通知和变更单链接。
- Playwright 浏览器回归、无障碍审计和可视化发布预览。

## 参考

- [Next.js 安装与 Node.js 要求](https://nextjs.org/docs/app/getting-started/installation)
- [Next.js Server 与 Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components)
- [Next.js 环境变量](https://nextjs.org/docs/app/guides/environment-variables)
- [Next.js Authentication Guide](https://nextjs.org/docs/app/guides/authentication)
