# Next.js 管理后台操作手册

适用版本：0.20.0。面向传统前端背景的新工程师、平台运营和演示人员。

## 先理解两个进程

| 进程 | 地址 | 职责 |
|---|---|---|
| Node.js Gateway | `http://127.0.0.1:3000` | 真正鉴权、授权、修改数据库和写审计 |
| Next.js Console | `http://127.0.0.1:3100` | 展示界面，通过受限 BFF 调用 Gateway |

前端隐藏按钮不能代替权限。即使用户在浏览器 DevTools 手工构造请求，Gateway 仍会返回 401/403/409。

## 本地启动

### 最简单：首次注册主组织

终端 A：

```bash
npm run dev
```

终端 B：

```bash
npm run admin:dev
```

打开 `http://127.0.0.1:3100`，填写组织名称、Owner 用户名和至少 12 位且包含字母/数字的密码。第一次成功后页面自动进入后台，公开注册入口关闭；以后显示账号密码登录。账号文件是 `.data/admin-local-owner.json`，请勿删除，否则会重新开放首次注册。

本模式无需 OIDC 或手工粘贴 Token。没有 PostgreSQL 时，Key 与治理策略修改在重启后不会保留，正式使用仍应启动下方数据库。

### 兼容方式：PostgreSQL + 静态 Token

终端 A，启动 PostgreSQL：

```bash
npm run control-plane:up
```

终端 B，启动 Gateway：

```bash
HOST=127.0.0.1 \
DATABASE_URL='postgres://aigateway:aigateway-local@127.0.0.1:5433/aigateway' \
DATABASE_AUTO_MIGRATE=true \
CONTROL_PLANE_SEED_FROM_ENV=false \
ADMIN_AUTH_MODE=static \
ADMIN_BEARER_TOKEN='请替换为本地临时管理员Token' \
ROTATION_APPROVAL_REQUIRED=true \
METRICS_ENABLED=false \
npm run dev
```

终端 C，启动 Console：

```bash
GATEWAY_API_BASE_URL='http://127.0.0.1:3000' \
ADMIN_CONSOLE_PUBLIC_ORIGIN='http://127.0.0.1:3100' \
ADMIN_CONSOLE_SESSION_SECRET='请替换为至少32字符的本地随机值' \
ADMIN_CONSOLE_ALLOW_DEV_TOKEN_LOGIN=true \
npm run admin:dev
```

打开 `http://127.0.0.1:3100`，在“仅本地开发”区域粘贴终端 B 使用的管理员 Token。Next 验证后把 Token 放进服务端 Session，浏览器只获得 HttpOnly Cookie；刷新页面可以恢复登录。`ADMIN_CONSOLE_ALLOW_DEV_TOKEN_LOGIN` 在 production 即使误设为 true 也会被代码拒绝。

## 接企业 OIDC

Console 和 Gateway 是同一个登录链路的两个客户端：Console 负责让员工登录并取得 Access Token；Gateway 负责验证 Access Token 及角色/租户 Claim。两边的 issuer 必须一致，Console 的 client ID 用于 ID Token audience，Gateway audience 取决于 IdP 发出的 API Access Token。

Console 生产配置示例：

```dotenv
GATEWAY_API_BASE_URL=https://ai-gateway.internal.example
ADMIN_CONSOLE_PUBLIC_ORIGIN=https://ai-admin.example.com
ADMIN_CONSOLE_SESSION_SECRET=使用Secret-Manager注入至少32字符强随机值
ADMIN_CONSOLE_SESSION_TTL_SECONDS=900
ADMIN_CONSOLE_REDIS_URL=rediss://user:password@redis.internal.example:6380

ADMIN_CONSOLE_OIDC_ISSUER=https://identity.example.com/tenant
ADMIN_CONSOLE_OIDC_CLIENT_ID=ai-gateway-admin-console
ADMIN_CONSOLE_OIDC_CLIENT_SECRET=使用Secret-Manager注入
ADMIN_CONSOLE_OIDC_REDIRECT_URI=https://ai-admin.example.com/api/auth/callback
ADMIN_CONSOLE_OIDC_SCOPES=openid profile ai-gateway.admin
ADMIN_CONSOLE_ALLOW_DEV_TOKEN_LOGIN=false
```

在 IdP 注册的 Redirect URI 必须与上面逐字符一致。不要使用通配符 Redirect URI。多实例或会滚动发布的环境必须配 Redis，否则进程重启或请求落到另一实例会丢 Session。

### 登录失败如何定位

| 页面错误码 | 新人先检查什么 |
|---|---|
| `oidc_unavailable` | issuer 是否可达、Discovery 是否完整、生产是否 HTTPS |
| `invalid_callback` | IdP Redirect URI、Cookie 域名、反向代理是否改写路径、回调是否被重复使用 |
| `token_exchange_failed` | client secret、PKCE 支持、ID Token issuer/audience/nonce、JWKS 网络 |
| API 401 | Session 或 Access Token 已过期；重新登录，检查双方时钟 |
| API 403 `csrf_error` | `ADMIN_CONSOLE_PUBLIC_ORIGIN` 与浏览器地址是否完全一致，代理是否保留 Origin |

## 页面说明

### 总览

- “可见 Key”不是全库数量，而是当前 Token Tenant Scope 可见数量。
- “待审批”只统计当前范围内 pending 申请。
- 当前身份区展示 roles、tenantScopes、authMethod 和哈希化 actorId。

### 虚拟 Key

- viewer：只能查看。
- operator：admin 的创建/启停/修改模型权限子集，不能申请轮换。
- admin：可创建轮换申请，但不能批准自己创建的申请。
- 创建后原始 Key 只显示一次；关闭弹层前必须写入 Secret Manager。

### 轮换审批

- 核对 Key、tenant、expected version、申请人和过期时间。
- 默认只看待处理，可筛选已批准、已拒绝、已撤销、已过期和全部。
- 申请人只能“撤销申请”；另一位 admin 才能“批准并轮换”或“拒绝”。
- 三种动作都必须填写 3–500 字符理由；理由会进入审计和通知。
- 自批、跨租户、过期、重复和陈旧版本会由 Gateway 拒绝。
- 静态开发 Token 的 actor 始终相同，只能演示申请和撤销；完整批准/拒绝需两个不同 OIDC subject。

### 通知中心

- 未读角标是当前账号自己的，不会被其他管理员的已读操作清除。
- 申请创建是租户级待办；批准/拒绝/撤销结果定向原申请人。
- “标记已读”只表示已经看过，不会修改审批状态。

### 审计

- 展示操作、资源、actor、角色和时间。
- 不展示原始 Key、Key Hash、Authorization 或 Prompt。

## 自动验证

Gateway 和 Console 已启动时：

```bash
ADMIN_CONSOLE_TOKEN='你的本地管理员Token' npm run smoke:admin
```

Console 需使用 `ADMIN_CONSOLE_ALLOW_DEV_TOKEN_LOGIN=true` 启动。脚本验证：Session/CSRF、创建和禁用 Key、创建轮换申请、短理由 400、申请人撤销、状态筛选、通知已读、审计和退出失效。脚本会在本地测试库创建一个 `console-smoke-*` Key，不得指向生产。

验证真实协议形状但不连接企业 IdP：

```bash
ADMIN_CONSOLE_TOKEN='你的本地管理员Token' npm run smoke:admin-oidc
```

该脚本会自行启动临时 Mock OIDC 和 Next 进程，检查 Discovery、state、nonce、PKCE S256、code exchange、ID Token/JWKS、Session 和 BFF。执行前只需保持本地 Gateway 在 3000 运行，不要同时占用 3100。

## 上线检查

- 企业 IdP Redirect URI、client secret 和 Gateway audience 已由身份团队确认。
- Redis 使用 TLS、鉴权、专用 ACL；故障时告警，不降级到内存。
- `ADMIN_CONSOLE_PUBLIC_ORIGIN` 是唯一正式 HTTPS 地址，反向代理保留 Origin。
- `ADMIN_CONSOLE_ALLOW_DEV_TOKEN_LOGIN=false`，并验证 `/api/auth/dev-token` 返回 404。
- Console 与 Gateway 之间的 TLS、网络策略和服务身份。
- Next.js 依赖公告跟踪、镜像扫描和固定版本升级流程。
- Console 独立域名、CSP nonce、WAF/反向代理和访问日志脱敏。
- 明确 15 分钟会话到期是否满足公司策略；当前没有 Refresh Token 和 IdP Single Logout。

## 停止

分别在 Gateway 和 Console 终端按 `Ctrl+C`，然后：

```bash
npm run control-plane:down
```

该命令保留 PostgreSQL Named Volume。
