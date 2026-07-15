# ADR 0012：OIDC BFF 与服务端不透明 Session

- 状态：Accepted
- 日期：2026-07-15
- 版本：0.12.0

## 背景

Iteration 11 让浏览器把管理员 Access Token 交给受限 BFF，但 Token 仍由 React 持有，刷新即丢失，也不适合企业员工正式登录。我们需要在不削弱 Gateway RBAC/租户边界的前提下支持企业 SSO、多实例和显式退出。

## 决策

使用 OIDC Authorization Code + PKCE。Next.js 作为 confidential/public OIDC client 和 BFF：在服务端换取并保存 Access Token，浏览器只持有 HMAC 签名的随机 Session ID Cookie。生产 Session Store 使用 Redis。所有 Cookie 认证的状态变更同时验证 Origin 和 Session 绑定 CSRF Token。

Gateway 不接受 Console Session Cookie，只接受由 Next 从 Session 取出后注入的 Access Token，并继续独立验证 JWT、角色和租户范围。

## 原因

- Access Token 不进入客户端 JavaScript，减少 XSS 直接窃取凭据的暴露面。
- 不透明 Session 可服务端立即删除，支持退出与集中 TTL。
- PKCE、state、nonce 分别约束 code 截获、登录 CSRF 和 ID Token 重放。
- Gateway 保持资源服务器边界，不需要理解某个前端框架的 Cookie。
- Redis 让多 Next 实例共享 Session，滚动发布不会必然让所有员工退出。

## 被否决方案

| 方案 | 未采用原因 |
|---|---|
| Access Token 放 localStorage | 同源 XSS 可长期读取，难以集中撤销。 |
| Access Token 放可读 Cookie | 仍暴露给 JavaScript，且自动携带带来更强 CSRF 风险。 |
| JWT 自包含 Session Cookie | Token 和用户状态进入浏览器，服务端主动撤销需要额外黑名单，轮换复杂。 |
| 只用 SameSite、不做 CSRF Token | SameSite 是纵深防御，不能覆盖所有部署/浏览器/同站跨源场景。 |
| Next 直接成为权限权威 | 前端 BFF 不应复制 Gateway 的 RBAC/租户规则，容易漂移。 |

## 后果

正面：刷新可恢复登录、Token 不在浏览器、可服务端过期/退出、多实例可用。代价：增加 Redis 与 OIDC Client 配置；Next 成为安全敏感 BFF，需要保护 Session secret、固定 public origin、监控 Redis 和回调失败率。

当前不使用 Refresh Token。Session 到期要求重新 SSO；若以后需要静默续期，必须单独设计 Refresh Token 加密存储、轮换、撤销和并发刷新。
