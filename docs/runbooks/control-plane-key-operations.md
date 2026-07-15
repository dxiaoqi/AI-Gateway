# 虚拟 Key 控制面操作手册

适用版本：0.10.0。读者不需要 PostgreSQL 运维经验。生产管理员凭据应使用 [OIDC 与 RBAC 手册](./admin-oidc-rbac.md)；本文中的静态 Token 命令只用于本地开发。

## 先理解三个凭据

| 凭据 | 谁使用 | 能做什么 | 不能做什么 |
|---|---|---|---|
| 业务虚拟 Key | 业务应用 | 调模型、查自己可见模型 | 创建或修改 Key |
| 管理员 Token | 平台管理员/自动化 | 创建、禁用、改权限、轮换、查审计 | 直接调用模型 |
| Key Pepper | 网关进程 | 计算不可逆摘要 | 不能发给调用方，也不能随意更换 |

管理员 Token 与 Pepper 应进入 Secret Manager。本地示例值不能用于共享环境。

## 首次启动

```bash
npm run control-plane:up
DATABASE_URL='postgres://aigateway:aigateway-local@127.0.0.1:5433/aigateway' npm run db:migrate
```

网关 `.env` 至少增加：

```dotenv
DATABASE_URL=postgres://aigateway:aigateway-local@127.0.0.1:5433/aigateway
ADMIN_BEARER_TOKEN=请替换为至少32字符的随机值
DATABASE_AUTO_MIGRATE=false
CONTROL_PLANE_SEED_FROM_ENV=false
```

生产推荐由发布 Job 执行 `db:migrate`，应用进程保持 `DATABASE_AUTO_MIGRATE=false`。

## 创建 Key

```bash
curl -i http://127.0.0.1:3000/admin/v1/virtual-keys \
  -H "Authorization: Bearer $ADMIN_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "keyId":"frontend-assistant-prod",
    "tenantId":"business-a",
    "projectId":"assistant",
    "applicationId":"web-prod",
    "allowedModels":["general"]
  }'
```

响应中的 `key` 只展示这一次。立即写入调用方的 Secret Manager，不要贴到 IM、工单或代码仓库。记录响应 `ETag: "1"`；它是版本号，不是秘密。

## 禁用泄露的 Key

先列出 Key，读取当前 `version`：

```bash
curl http://127.0.0.1:3000/admin/v1/virtual-keys \
  -H "Authorization: Bearer $ADMIN_BEARER_TOKEN"
```

再禁用，例如当前版本为 3：

```bash
curl -i -X PATCH http://127.0.0.1:3000/admin/v1/virtual-keys/frontend-assistant-prod \
  -H "Authorization: Bearer $ADMIN_BEARER_TOKEN" \
  -H 'If-Match: "3"' \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}'
```

成功返回以后，旧 Key 的下一次请求应为 401。若返回 409，说明他人已修改：重新读取版本和状态，不能盲目重试旧请求。

## 轮换 Key

开发环境默认仍允许下面的直接轮换，以兼容本地调试。生产环境从 0.10.0 起默认返回 `409 approval_required`，必须改走[双人轮换流程](./tenant-access-and-rotation-approval.md)：

```bash
curl -i -X POST http://127.0.0.1:3000/admin/v1/virtual-keys/frontend-assistant-prod/rotate \
  -H "Authorization: Bearer $ADMIN_BEARER_TOKEN" \
  -H 'If-Match: "4"'
```

无论直接轮换还是审批轮换，当前都是“单 Key 立即切换”，没有新旧 Key 重叠宽限期。高可用无损轮换应先创建第二个 Key、更新调用方、验证后再禁用第一个 Key。

## 查审计

```bash
curl 'http://127.0.0.1:3000/admin/v1/audit-events?limit=50' \
  -H "Authorization: Bearer $ADMIN_BEARER_TOKEN"
```

检查 action、resourceId、beforeState、afterState、requestId、traceId。审计不应包含 `key`、`keyHash` 或 Authorization。

## PostgreSQL 故障

现象：`/health/live` 仍为 200，`/health/ready` 为 503，业务认证失败。含义是进程活着，但不能安全接流量。

排查顺序：

1. `docker compose ps postgres` 或检查托管数据库状态。
2. 验证 `DATABASE_URL` 的网络、账号与 TLS 配置，不打印完整 URL 密码。
3. 执行 `npm run db:migrate`，确认 Schema 已存在。
4. 检查数据库连接数是否达到上限；总连接预算约为实例数乘 `DATABASE_POOL_MAX`。
5. 恢复后确认 `/health/ready` 返回 200，再恢复流量。

禁止把认证临时切回环境变量；这样可能让已经禁用的泄露 Key 重新生效。

## Pepper 事故

Pepper 丢失会导致数据库中所有摘要无法再匹配；Pepper 泄露会降低摘要保护。当前版本没有在线 Pepper 双读轮换：

- 丢失：恢复 Secret 备份，否则必须为所有应用签发新 Key。
- 泄露：按安全事故处理，准备新 Pepper、批量重新签发 Key 并安排切换窗口。
