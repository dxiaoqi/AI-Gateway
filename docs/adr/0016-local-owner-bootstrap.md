# ADR 0016：首次启动主组织 Owner 与本地密码认证

- 状态：Accepted
- 日期：2026-07-15
- 关联迭代：Iteration 19

## 背景

只有 OIDC 的管理后台在企业 IdP 尚未接入时无法使用。把共享管理员 Token 直接交给浏览器虽然简单，但没有用户名、无法区分个人，也容易泄露长期凭据。

## 决策

- 增加 Gateway `local` 管理员认证模式。开发环境没有 static/OIDC 配置时默认启用；生产必须显式选择。
- 系统没有账号时开放一次性主组织注册，使用独占文件创建保证并发请求最多一个成功。
- 第一个账号固定是唯一 Owner，拥有 `admin` 与全租户范围；创建后注册入口永久关闭。
- 密码使用随机盐和 Node.js `scrypt` 派生 64 字节摘要，文件权限为 `0600`，不保存明文。
- 登录成功签发 15 分钟 HS256 Access Token。Gateway 自己验证 issuer、audience、typ、算法、签名与过期时间。
- Next.js 将 Access Token 放入现有服务端 Session，浏览器仍只获得 HttpOnly Cookie 与 CSRF Token。
- 生产首次注册要求 BFF 额外发送服务器端 `ADMIN_LOCAL_BOOTSTRAP_TOKEN`，浏览器不能读取该值。

## 为什么不直接让 Next.js 使用静态 Token

那样所有本地用户在 Gateway 看来都是同一个 `static:*` Actor，审计无法回答“谁做的”，双人审批也没有升级空间。本方案让 Gateway 认识 `local:<accountId>` 身份。

## 代价与边界

- 当前只支持一个 Owner，没有邀请、找回密码、修改密码和 MFA。
- 账号文件需要持久卷；多 Gateway 实例不能共享本地文件，应改用 OIDC 或未来的数据库账号仓库。
- 修改密码或停用账号后，已签发令牌最长还可使用 15 分钟；紧急吊销需要轮换签名密钥并重启。
- 本地模式解决“无 IdP 可进入”，不替代大型企业最终的 SSO、条件访问与离职回收。
