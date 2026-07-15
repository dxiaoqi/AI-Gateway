# Iteration 12：管理后台正式登录与服务端会话

- 版本：0.12.0
- 日期：2026-07-15
- 状态：Completed
- 操作手册：[管理后台登录与会话](../runbooks/admin-console.md)

## 0. 一句话说明

把“在网页粘贴管理员 Token”升级成企业 SSO：浏览器只拿一张不可读的会话票据，Access Token 留在 Next.js 服务端，并为所有写操作增加 CSRF 防护。

## 1. 30 秒领导摘要

| 领导关心的问题 | 本轮回答 |
|---|---|
| 员工怎么登录 | 跳转企业 OIDC，使用 Authorization Code + PKCE；不在本项目保存员工密码。 |
| Token 在哪里 | Access Token 存在服务端 Session Store；浏览器只有 `HttpOnly` Cookie，JavaScript 读不到。 |
| 页面刷新怎么办 | Cookie 恢复服务端会话，不再要求重新粘贴 Token。 |
| 跨站请求怎么办 | SameSite Cookie 是第一层；Origin + 自定义 CSRF Header 是第二层。 |
| 多实例怎么办 | 生产连接 Redis；内存 Store 只用于单进程本地开发。 |
| 怎么证明可用 | Next 生产构建、会话/CSRF 真进程 smoke、Mock OIDC 全流程 smoke、默认全量测试。 |

## 2. 给传统前端工程师的类比

以前的方式类似把数据库密码放进 React state：虽然没有写 localStorage，但每个请求都由浏览器直接带着它。现在更像常见的 BFF 登录：

```text
浏览器                         Next.js BFF                         企业 IdP / Gateway
   |  点击 SSO                    |                                      |
   |----------------------------->|  生成 state/nonce/PKCE               |
   |<-----------------------------|  302 到 IdP                           |
   |------------------------------ OIDC 登录 --------------------------->|
   |<----------------------------- authorization code ------------------|
   |  callback + code             |                                      |
   |----------------------------->|  code + verifier 换 Token ---------->|
   |                              |  验证 ID Token 签名/iss/aud/nonce     |
   |<-----------------------------|  只下发 HttpOnly 随机会话 Cookie      |
   |  /api/gateway + Cookie       |                                      |
   |----------------------------->|  从 Store 取 Token，请求 Gateway ---->|
```

Cookie 像“行李寄存牌”，不是行李本身。即使用户看到 Cookie 字符串，也看不到里面的 Access Token；服务端只保存 Cookie 随机 ID 的 SHA-256 键。

## 3. 本轮目标与非目标

已完成：

- OIDC Discovery、Authorization Code、PKCE S256、state 和 nonce。
- ID Token 的签名、算法、issuer、audience、subject、expiry、nonce 校验。
- HMAC 签名的随机 Session ID，HttpOnly/SameSite Cookie。
- Redis Session Store；未配置 Redis 时使用开发内存 Store。
- Session TTL 不超过上游 Access Token TTL。
- BFF 从服务端 Session 注入 Bearer Token，浏览器不再发送 Authorization。
- 写请求和退出同时校验 Origin 与 `X-CSRF-Token`。
- 退出删除 Store 记录和 Cookie；过期 Session 返回 401。
- 显式、本地且非 production 才可开启的静态 Token 登录兼容入口。

本轮不做：

- Refresh Token 自动续期；当前到期后重新 SSO，减少长期凭据风险。
- IdP Single Logout；当前只撤销 Console 本地会话。
- 审批 reject/cancel、通知和变更单联动，进入 Iteration 13。
- Anthropic 原生协议，继续暂缓。

## 4. 请求链路细节

### 4.1 发起登录

1. `/api/auth/login` 从固定 issuer 拉取 Discovery，拒绝重定向。
2. 生产要求 OIDC URL 使用 HTTPS；仅开发允许 localhost HTTP。
3. 生成 32 字节随机 `state`、`nonce` 和 PKCE verifier。
4. verifier 做 SHA-256 得到 challenge，发送 `code_challenge_method=S256`。
5. state/nonce/verifier 存服务端 5 分钟，浏览器只得到事务 Cookie。

### 4.2 处理回调

1. `/api/auth/callback` 一次性消费事务；重复回调会失败。
2. 使用常量时间比较 state。
3. code + 原始 verifier 发送 Token Endpoint；机密客户端用 Basic 认证。
4. 从 JWKS 校验 ID Token，并检查 issuer、audience、算法、exp、sub、nonce。
5. 创建服务端 Session，TTL 取“后台配置 TTL”和“Access Token 剩余时间”的较小值。
6. 成功/失败跳转都使用固定 `ADMIN_CONSOLE_PUBLIC_ORIGIN`，不信任请求 Host。

### 4.3 日常 API

1. React 启动时调用 `/api/auth/session`，仅获得 CSRF Token 和过期时间。
2. 浏览器请求同源 `/api/gateway/admin/v1/*`，Cookie 自动发送。
3. Next 用 Cookie 找 Session，再给内部 Gateway 注入 Authorization。
4. POST/PATCH 必须同时具备同源 Origin 和正确 CSRF Header。
5. Gateway 仍执行真正的 RBAC、Tenant Scope、If-Match 和审批状态校验。

## 5. 为什么需要三种随机值

| 值 | 防什么 | 是否发给 IdP |
|---|---|---:|
| state | 攻击者把自己的登录回调塞给受害者，即登录 CSRF | 是 |
| nonce | 把旧 ID Token 重放到本次登录 | 是，随后必须出现在 ID Token |
| PKCE verifier | Authorization Code 被截获后在别处换 Token | 否，只发送其 SHA-256 challenge |

三者用途不同，不能只生成一个字符串复用。

## 6. Session 与 Cookie 设计

| 项目 | 设计 |
|---|---|
| Cookie 名 | `aigw_admin_session` |
| Cookie 内容 | 32 字节随机 ID + HMAC 签名，不含 Token/用户资料 |
| 属性 | HttpOnly、SameSite=Lax、Path=/；production 自动 Secure |
| Store 键 | 随机 ID 的 SHA-256，不把原始 Cookie 当数据库键 |
| Store 值 | Access Token、CSRF Token、expiresAt |
| 默认 TTL | 900 秒，可配置 60–43200 秒 |
| 生产 Store | Redis，带原子 TTL |
| 开发 Store | 当前 Next 进程的内存 Map，重启即退出 |

`ADMIN_CONSOLE_SESSION_SECRET` 和 `ADMIN_CONSOLE_REDIS_URL` 生产必填。Redis 未配置或不可用时请求会失败，不静默降级到内存，避免多实例出现“有时登录、有时掉线”。

## 7. CSRF 设计

Cookie 会被浏览器自动携带，所以攻击网站可能诱导浏览器发 POST。保护方式：

- Cookie `SameSite=Lax` 降低跨站自动携带机会。
- 写请求必须有 `Origin == ADMIN_CONSOLE_PUBLIC_ORIGIN`。
- 写请求必须有 `X-CSRF-Token`；跨站普通表单无法自定义这个 Header。
- CSRF Token 与 Session 绑定，常量时间比较。
- 登录兼容入口虽然尚无 Session，也必须校验 Origin，防登录 CSRF。

GET 只能读取，不应产生副作用；如果未来新增有副作用的 GET，必须先修 API 语义。

## 8. 代码导读

| 文件 | 新人工程师应该先看什么 |
|---|---|
| `lib/oidc.ts` | Discovery、PKCE、换 Token、ID Token 校验 |
| `lib/session.ts` | Cookie ID、Redis/内存 Store、TTL、一次性 OIDC 事务 |
| `lib/security.ts` | Origin 和 CSRF 常量时间比较 |
| `app/api/auth/login/route.ts` | 登录重定向参数 |
| `app/api/auth/callback/route.ts` | 回调的 fail-closed 顺序 |
| `app/api/gateway/[...path]/route.ts` | 从 Session 取 Token 和写请求 CSRF |
| `components/admin-console.tsx` | 页面只持有短期 CSRF Token，不持有 Access Token |
| `scripts/admin-oidc-flow-smoke.mjs` | 可执行的 Mock IdP，展示完整协议顺序 |

## 9. 验证证据

```text
Next TypeScript: passed
Next production build: passed; 6 auth routes + restricted BFF recognized
Session smoke: login -> HttpOnly session -> no-CSRF 403 -> write/audit -> cross-origin logout 403 -> logout -> old cookie 401
OIDC smoke: discovery -> state/nonce -> PKCE S256 -> code exchange -> ID token -> session -> BFF
```

Mock OIDC 不是“把函数调用一遍”：它临时生成 RSA Key、提供 Discovery/JWKS/authorize/token HTTP 接口，再由真实 Next 进程完成重定向和 Cookie 流程。测试不会调用外部 IdP，也不会产生模型费用。

## 10. 本轮发现并修复的问题

第一次 OIDC smoke 发现成功回调被 Next 生成到了 `http://localhost:3100/`，而配置的公共地址是 `127.0.0.1`。这说明不能依赖请求 Host 生成安全跳转。已改成所有登录成功/失败跳转都以 `ADMIN_CONSOLE_PUBLIC_ORIGIN` 为基准。

## 11. 已知限制与风险

- 暂无 Refresh Token：15 分钟默认会话到期后重新登录，体验与长期凭据风险之间偏安全。
- OIDC 事务在 Redis 使用原子 `GETDEL`；开发内存 Store 由单个 JavaScript 事件循环串行访问。
- IdP logout 尚未接入；共享设备还应由企业浏览器策略和 IdP 会话控制补充。
- 内部 Next→Gateway 本地为 HTTP；生产必须内网 TLS/网络策略/服务身份。
- Next/PostCSS 的两个 moderate 审计例外仍按 Iteration 11 方案跟踪。

## 12. 下一轮

Iteration 13 优先补管理后台审批闭环：reject/cancel、审批理由、待办通知和状态筛选。随后推进分页搜索、模型/配额策略管理与 Secret Manager 交付。Anthropic 原生协议继续列为“暂缓”，不占当前管理面迭代。

## 13. 参考标准

- [OAuth 2.0 Security Best Current Practice (RFC 9700)](https://www.rfc-editor.org/rfc/rfc9700.html)
- [PKCE (RFC 7636)](https://www.rfc-editor.org/rfc/rfc7636.html)
- [Next.js Authentication Guide](https://nextjs.org/docs/app/guides/authentication)
- [Next.js cookies API](https://nextjs.org/docs/app/api-reference/functions/cookies)
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/CSRF_Prevention_Cheat_Sheet.html)
