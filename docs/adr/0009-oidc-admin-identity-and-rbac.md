# ADR 0009：管理 API 使用 OIDC JWT 身份与路由级 RBAC

- 状态：Accepted
- 日期：2026-07-15
- 版本：0.9.0

## 背景

Iteration 8 用一个静态 Admin Token 保护全部管理操作。它能隔离业务 Key，但不能证明具体操作人，也不能限制“只能查看”或“可以禁用但不能轮换”。共享 Token 离职难回收、泄露影响全部权限，审计只有 Token 指纹。

## 决策

1. 网关作为 OAuth/OIDC Resource Server，接受企业身份系统签发的 Bearer JWT；本轮不实现网页登录和 Authorization Code Flow。
2. 使用远程 JWKS 验证非对称签名，并固定校验 issuer、audience、expiration、subject、`typ` 和算法白名单。
3. 从可配置 Claim 路径读取 IdP 角色/组，并通过显式映射转成内部 `viewer`、`operator`、`admin`。
4. 每条管理路由声明所需 permission，由服务端 RBAC 强制校验；JWT 有效但权限不足返回 403。
5. 审计保存稳定 actor id、原始 subject、issuer、内部 roles 和 `authMethod=oidc`。
6. 静态 Token 仅作本地兼容和 break-glass；生产默认拒绝，只有显式设置 `ADMIN_ALLOW_STATIC_IN_PRODUCTION=true` 才允许。

## 权限矩阵

| 操作 | viewer | operator | admin |
|---|:---:|:---:|:---:|
| 查询虚拟 Key | ✓ | ✓ | ✓ |
| 查询审计 | ✓ | ✓ | ✓ |
| 创建虚拟 Key |  | ✓ | ✓ |
| 启停/修改模型 ACL |  | ✓ | ✓ |
| 轮换虚拟 Key |  |  | ✓ |

## 安全约束

- 不接受 `none`、HS256 等对称算法，避免把公开 JWKS Key 错当 HMAC Secret。
- 不根据 Token 自带 `alg` 自动放行；必须同时属于配置白名单。
- Token 最大 16 KiB，减少异常超大 Header 的资源消耗。
- issuer 和 audience 必须精确匹配，阻止其他租户或其他 API 的 Token 替换攻击。
- 生产 issuer/JWKS 必须使用 HTTPS；JWKS URL 是受信任部署配置，不从请求或未验证 Token 动态发现。
- 角色只接受显式映射；未知组不产生任何权限。
- JWT 验证失败统一返回 401，不向调用方暴露签名、kid 或 Claim 细节。

## 未选择方案

| 方案 | 未选择原因 |
|---|---|
| 继续共享静态 Token | 无个人身份、无最小权限、离职和泄露治理差 |
| 网关自己保存管理员账号密码 | 重复建设 MFA、生命周期、风控和恢复能力 |
| 只在前端隐藏按钮 | 不能阻止直接调用 HTTP API |
| 每个请求调用 IdP introspection | 可即时撤销但强依赖 IdP 网络和吞吐；本轮先做可离线验签 JWT |
| 自动读取任意 OIDC discovery URL | 扩大 SSRF/配置漂移边界；本轮显式配置 issuer 与 JWKS |
| 将外部 group 直接当 permission | IdP 命名变化会直接改变代码权限语义 |

## 代价与后果

- 管理 API 可用性依赖 IdP 签发和 JWKS Key；已有 Key 缓存可短期继续验证，但新 `kid` 需要拉取成功。
- JWT 是权限快照：员工被移出组后，已签发 Token 在过期前仍可能有效。生产应使用短有效期并由 IdP 控制签发。
- 原始 subject 进入审计表，可能属于个人数据，需要访问控制、保留期限和导出治理。
- IdP Claim 格式不同，需要平台团队维护 role claim 与 role map。
