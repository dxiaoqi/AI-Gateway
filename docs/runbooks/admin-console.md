# Next.js 管理后台操作手册

适用版本：0.11.0。面向传统前端背景的新工程师、平台运营和演示人员。

## 先理解两个进程

| 进程 | 地址 | 职责 |
|---|---|---|
| Node.js Gateway | `http://127.0.0.1:3000` | 真正鉴权、授权、修改数据库和写审计 |
| Next.js Console | `http://127.0.0.1:3100` | 展示界面，通过受限 BFF 调用 Gateway |

前端隐藏按钮不能代替权限。即使用户在浏览器 DevTools 手工构造请求，Gateway 仍会返回 401/403/409。

## 本地启动

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
GATEWAY_API_BASE_URL='http://127.0.0.1:3000' npm run admin:dev
```

打开 `http://127.0.0.1:3100`，粘贴终端 B 使用的管理员 Token。该 Token 只在当前页面内存；刷新页面必须重新输入。

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
- 自批、跨租户、过期、重复和陈旧版本会由 Gateway 拒绝。
- 静态开发 Token 的 actor 始终相同，不能完成双人审批；完整流程需两个不同 OIDC subject。

### 审计

- 展示操作、资源、actor、角色和时间。
- 不展示原始 Key、Key Hash、Authorization 或 Prompt。

## 自动验证

Gateway 和 Console 已启动时：

```bash
ADMIN_CONSOLE_TOKEN='你的本地管理员Token' npm run smoke:admin
```

脚本验证：Next 页面、安全 Header、无 Token 401、非 admin 路径 404、BFF 身份、创建、禁用和审计。脚本会在本地测试库创建一个 `console-smoke-*` Key，不得指向生产。

## 生产前必须补齐

- 企业 OIDC Redirect/Callback + Authorization Code PKCE，而不是人工粘贴 Token。
- HttpOnly/Secure/SameSite Session、CSRF 和退出撤销策略。
- Console 与 Gateway 之间的 TLS、网络策略和服务身份。
- Next.js 依赖公告跟踪、镜像扫描和固定版本升级流程。
- Console 独立域名、CSP nonce、WAF/反向代理和访问日志脱敏。

## 停止

分别在 Gateway 和 Console 终端按 `Ctrl+C`，然后：

```bash
npm run control-plane:down
```

该命令保留 PostgreSQL Named Volume。
