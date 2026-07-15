# 管理员 OIDC 与 RBAC 运维手册

适用版本：0.10.0。该手册面向身份平台工程师、网关值班人员和传统前端背景的新工程师。

## 系统做什么、不做什么

网关验证企业身份平台签发的 JWT Access Token，类似后端 API 校验登录态。网关不提供登录页，不保存员工密码，也不负责 MFA。浏览器或 CLI 如何从 IdP 获取 Access Token 由企业身份平台决定。

## 角色设计

| 内部角色 | 适用人员 | 能力 |
|---|---|---|
| viewer | 审计、支持、只读值班 | 查 Key 元数据和审计 |
| operator | 日常平台运营 | viewer + 创建、启停、修改模型 ACL |
| admin | 极少数安全管理员 | operator + 申请或批准 Key 轮换 |

轮换会立即让旧业务 Key 失效，因此只授予 admin。前端隐藏按钮只是体验优化，真实权限由服务端每条路由强制执行。

## IdP 前置配置

1. 创建专用于 AI Gateway 管理 API 的 audience/resource，例如 `ai-gateway-admin`。
2. 创建三个组，例如 `ai-gateway-viewers/operators/admins`。
3. 确保 Access Token 包含稳定 `sub`、正确 `iss/aud/exp` 和 groups/roles Claim。
4. 使用 RS256/ES256 等非对称签名，并发布含 `kid` 的 JWKS。
5. 建议 Token 有效期 5–15 分钟；人员移组不会让已签发 JWT 瞬间失效。

## 网关配置

```dotenv
ADMIN_AUTH_MODE=oidc
ADMIN_OIDC_ISSUER=https://identity.example.com/tenant-a
ADMIN_OIDC_AUDIENCE=ai-gateway-admin
ADMIN_OIDC_JWKS_URL=https://identity.example.com/tenant-a/.well-known/jwks.json
ADMIN_OIDC_ROLE_CLAIM=groups
ADMIN_OIDC_TENANT_CLAIM=ai_gateway_tenants
ADMIN_OIDC_ROLE_MAP_JSON={"ai-gateway-viewers":"viewer","ai-gateway-operators":"operator","ai-gateway-admins":"admin"}
ADMIN_OIDC_ALLOWED_ALGORITHMS=RS256
ADMIN_OIDC_TOKEN_TYP=JWT
```

`ADMIN_OIDC_ROLE_CLAIM` 支持点路径，例如 Keycloak 常见的 `realm_access.roles`。`ADMIN_OIDC_TENANT_CLAIM` 指向字符串或字符串数组，内容为允许管理的 tenantId，只有平台级人员才使用 `*`。Role Map 的 Key 是外部组名，Value 只能是 viewer/operator/admin；角色或租户范围缺失都按无权限处理。

生产 issuer 和 JWKS URL 必须是 HTTPS。不要为了排障关闭 issuer、audience、algorithm 或 expiration 验证。

## 上线前验收

分别获取 viewer、operator、admin Token：

1. viewer：GET Key 为 200，POST 创建为 403。
2. operator：POST 创建/PATCH 修改为 2xx，POST rotate 为 403。
3. admin A：创建轮换申请为 201，但批准自己的申请为 409。
4. 同租户 admin B：批准申请为 200；不同租户 admin 为 403。
5. 用另一个 audience、另一个 issuer、过期 Token：均为 401。
6. 查看 audit，确认 actorSubject、actorIssuer、actorRoles、actorTenantScopes、authMethod 正确。

完整审批命令见[租户访问与双人轮换手册](./tenant-access-and-rotation-approval.md)。

自动化等价验证：

```bash
npm run smoke:oidc
```

## 401 与 403 的区别

| 状态 | 含义 | 排查 |
|---|---|---|
| 401 | 无法证明是谁 | Token 是否过期；iss/aud/typ/alg；kid 是否在 JWKS；JWKS 网络/TLS |
| 403 | 已证明身份，但角色不允许 | Claim 路径是否正确；外部组是否进入 Token；Role Map 是否配置 |

网关故意不在 401 响应里告诉外部调用方“具体哪个 Claim 错了”。内部排查需对照 IdP 日志、网关配置和 JWKS，不要把完整 Token 发到聊天群或工单。

## JWKS 轮换与故障

- IdP 应先把新公钥加入 JWKS，再开始签发新 `kid`，保留旧公钥直到旧 Token 全部过期。
- 网关缓存 JWKS；已缓存 Key 可继续使用。遇到未知 `kid` 时会重新拉取，并受 cooldown 控制。
- 若 JWKS 故障与新 Key 轮换同时发生，新 Token 会 401。先恢复 JWKS，不要临时放宽签名校验。
- 本地冒烟会验证多次 Token 校验只拉取一次 JWKS。

## 人员离职或角色回收

1. 立即在 IdP 禁止账号/移出组并停止签发。
2. 已签发 JWT 在过期前可能有效；高风险场景按 IdP 能力撤销会话或签名 Key。
3. 查询 `actorSubject` 的近期审计，确认是否有敏感操作。
4. 若怀疑他已拿到业务 Key，按控制面手册禁用或轮换对应 Key。

## Break-glass 静态 Token

只有 IdP 故障且业务明确批准时使用：

```dotenv
ADMIN_AUTH_MODE=static
ADMIN_BEARER_TOKEN=至少32字符的临时强随机值
ADMIN_ALLOW_STATIC_IN_PRODUCTION=true
```

它拥有 admin 全权限。必须限制入口网络、记录审批、设置恢复截止时间；OIDC 恢复后立即删除 override、轮换静态 Token 并重启。静态审计只能识别 Token 指纹，不能证明具体员工。
