# Iteration 11：Next.js 管理后台 MVP

- 版本：0.11.0
- 日期：2026-07-15
- 状态：Completed
- 关联 ADR：[ADR 0011](../adr/0011-nextjs-admin-console-and-bff.md)
- 操作手册：[Next.js 管理后台](../runbooks/admin-console.md)

## 0. 一句话说明

把已经安全但只能用 curl 的管理 API，变成传统前端和平台运营能看懂、能操作、仍无法绕过后端权限的管理工作台。

## 1. 30 秒领导摘要

| 领导关心的问题 | 回答 |
|---|---|
| 以前的问题 | OIDC、租户隔离和审批已经完成，但没有界面，领导无法演示、运营不适合长期使用 curl。 |
| 本轮交付 | 独立 Next.js 管理后台、身份总览、Key 生命周期、轮换审批、审计、一次性 Secret 提示、同源受限 BFF。 |
| 安全边界 | UI 只决定显示什么；Gateway 继续决定允许什么。Token 只在 React 内存，不写浏览器持久存储。 |
| 验证证据 | React/Next production build、80 项默认测试、真实 Next→BFF→Gateway→PostgreSQL smoke、浏览器可视检查。 |
| 剩余风险 | 尚未接 OIDC Redirect/PKCE；审批没有 reject/cancel/通知；Next 上游 PostCSS 公告需跟踪。 |

## 2. 给新人工程师的前端类比

### 两层前端/后端关系

把 Gateway 想成支付后台，把 Console 想成运营后台。按钮是否显示类似前端路由守卫，只改善体验；真正扣款前仍必须由后端验证用户、商户和订单状态。本项目同理：

```text
React canWrite/canApprove
  只控制按钮

Gateway RBAC + Tenant Scope + If-Match + Approval State
  才是不能绕过的权限边界
```

### 为什么需要 BFF

浏览器如果直接请求 3000，需要 CORS，并会知道内部 Gateway 地址。现在浏览器只请求 3100 的 `/api/gateway/...`，Next Route Handler 再转发到 3000，类似前端开发常用的 dev proxy，但它运行在生产服务端并且有严格路径白名单。

### Token 为什么只放 React state

localStorage 方便，但任何同源 XSS 都能长期读取。当前 MVP 刷新要重新登录，换来 Token 不落盘。未来正式 OIDC 会换成服务端 Session，而不是把长寿命 Token 重新塞回 localStorage。

## 3. 本轮目标

- Next.js App Router + React + TypeScript 独立 workspace。
- viewer/operator/admin 对应的只读、编辑和审批体验。
- 总览、Key、审批、审计四个视图。
- 创建/启停/模型 ACL/轮换申请/批准完整操作。
- 一次性 Key 明确提示并关闭即清除。
- Next BFF 只代理 admin/v1，Gateway 地址不进入客户端 Bundle。
- 完整新人启动、验证和生产差距说明。

## 4. 非目标

- 完整企业 OIDC 登录页、Callback、PKCE 和 Session。
- 审批 reject/cancel、消息通知和变更单系统。
- 删除 Key、分页 Cursor、批量操作和导出。
- 模型、部署、配额和价格策略管理页面。
- Anthropic 原生协议；根据本轮方向明确后移。
- 视觉回归平台和完整 WCAG 审计。

## 5. 逐步请求流

1. 用户打开 3100，Next 静态渲染登录页。
2. 用户粘贴 Token；React input 提交后立即清空，Token 进入组件 state。
3. React 并发调用 `/api/gateway/admin/v1/me`、Key、审批、审计。
4. Route Handler 检查路径只能是 admin/v1，要求 Bearer Header。
5. BFF 从服务端变量读取 Gateway 地址，转发 Authorization/Content-Type/If-Match，不跟随 Redirect。
6. Gateway 验证 JWT/静态凭据、role、tenant scope 和资源状态。
7. PostgreSQL 在授权范围内查询或事务写入；响应原路返回。
8. React 使用 text JSX 渲染服务端数据，不使用 `dangerouslySetInnerHTML`。
9. 用户退出后 state 和页面数据清空；刷新也不会恢复 Token。

## 6. 页面与角色矩阵

| 能力 | viewer | operator | admin |
|---|---:|---:|---:|
| 总览/Key/审批/审计 | ✓ | ✓ | ✓ |
| 创建 Key | 隐藏 + API 403 | ✓ | ✓ |
| 启停/模型 ACL | 隐藏 + API 403 | ✓ | ✓ |
| 申请/批准轮换 | 隐藏 + API 403 | 隐藏 + API 403 | ✓，仍受双人规则 |
| 跨租户数据 | SQL 层不可见 | SQL 层不可见 | 仅 scope 内可见 |

## 7. 代码导读

| 文件 | 职责 |
|---|---|
| `apps/admin-console/app/page.tsx` | App Router 入口 |
| `apps/admin-console/components/admin-console.tsx` | React 状态、四个工作台和管理动作 |
| `apps/admin-console/app/api/gateway/[...path]/route.ts` | 同源受限 BFF |
| `apps/admin-console/app/globals.css` | 响应式视觉系统，不依赖外部字体/图片 |
| `src/server/routes/admin-virtual-keys.ts` | 新增 `/admin/v1/me`，其余权威 API 保持不变 |
| `scripts/admin-console-smoke.mjs` | 真实三层冒烟 |
| `test/admin-console-assets.test.ts` | Token 存储和 BFF 边界静态回归 |

## 8. 安全设计

- Token 不写 localStorage/sessionStorage/Cookie/URL。
- `GATEWAY_API_BASE_URL` 无 `NEXT_PUBLIC_`，只在服务端读取。
- BFF 拒绝非 admin/v1 和路径穿越片段。
- BFF 禁止跟随 Redirect，避免凭据被上游重定向带走。
- Next 页面返回 no-store、DENY frame、nosniff 和 no-referrer Header。
- 不使用 `dangerouslySetInnerHTML`，所有 API 字段由 React 转义。
- 一次性 Key 关闭弹层后从 state 清除；不进入审计和普通日志。

## 9. 实际验证证据

```text
Default test files: 19 passed, 2 optional integration files skipped
Default tests: 80 passed, 3 optional integration tests skipped
Gateway TypeScript build: passed
Next.js 16.2.10 production build: passed
Next route output: static page + dynamic restricted BFF
Real Next -> BFF -> Gateway -> PostgreSQL smoke: passed
PostgreSQL Schema v3 and concurrent approval integration: 1 passed
Browser login and virtual-key table visual inspection: passed
External Provider/IdP: not called; cost 0
```

Smoke 成功文本：

```text
Admin console smoke passed: Next shell -> restricted BFF -> identity -> create -> disable -> audit
```

## 10. 依赖审计例外

`npm audit` 报告 Next.js 16.2.10 固定的 PostCSS 8.4.31 有 2 个 moderate 记录，根因是同一公告 GHSA-qx2v-qp2m-jg93。利用需要构建时 stringify 不可信 CSS；本项目只编译版本库静态 CSS，不接收用户 CSS，因此当前不可达。

不能执行 `npm audit fix --force`，因为 npm 会建议破坏性降级到 Next 9。处理策略：固定当前 Next 版本、CI 保留审计、关注 Next 更新，一旦上游放宽到 PostCSS 8.5.10+ 立即升级并重新构建。

## 11. 已知限制与业务影响

- 人工粘贴 Token 适合本地和受控演示，不适合面向普通企业员工上线。
- 刷新必须重新输入 Token；这是安全取舍，不是登录 Bug。
- 静态 Token 只有一个 actor，无法在 UI 完成双人审批。
- 没有分页，当前 API 上限 200 Key/审批、100 审计，大租户需要 Cursor。
- 没有 reject/cancel/通知，审批人仍需主动打开页面。
- 没有 Secret Manager 集成，Key 交付仍依赖人工复制。
- BFF 与 Gateway 之间当前本地 HTTP；生产必须使用内网 TLS/服务身份。

## 12. 领导 Review 问题

- 正式登录使用哪个企业 IdP，是否允许 Next.js 自己维护 Session？
- Console 与 Gateway 是否同域部署，反向代理和证书由谁负责？
- 下一轮先做 OIDC 登录，还是审批 reject/cancel/通知？
- 哪些页面需要给业务租户自助，哪些只给平台团队？

## 13. 下一轮建议

优先 Iteration 12：OIDC Authorization Code + PKCE、服务端 Session、CSRF、退出和 Token 续期；同时加入审批 reject/cancel 和待办通知的最小闭环。Anthropic 原生协议继续后移，不占用管理面产品化资源。
