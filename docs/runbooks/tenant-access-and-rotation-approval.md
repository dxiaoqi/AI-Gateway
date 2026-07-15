# 租户访问与双人轮换操作手册

适用版本：0.13.0。

## 先区分 Role 和 Tenant Scope

Role 回答“能做什么”，Tenant Scope 回答“能对谁做”。两者必须同时允许：

```text
operator + tenant-a → 可以修改 tenant-a，不能轮换，也看不到 tenant-b
admin + tenant-a    → 可以为 tenant-a 申请/批准轮换，看不到 tenant-b
admin + *           → 平台级全局管理员，应极少授予
```

Token 示例 Claim：

```json
{
  "groups": ["ai-gateway-admins"],
  "ai_gateway_tenants": ["tenant-a", "tenant-c"]
}
```

缺少 `ai_gateway_tenants` 不是全局权限，而是无租户权限。

## 配置

```dotenv
ADMIN_OIDC_TENANT_CLAIM=ai_gateway_tenants
ROTATION_APPROVAL_REQUIRED=true
ROTATION_APPROVAL_TTL_MS=900000
```

生产默认要求审批。`ROTATION_APPROVAL_TTL_MS=900000` 表示 15 分钟；太长会让旧上下文长期有效，太短会增加重复申请。

## 申请轮换

申请人必须是 admin，并对 Key 的 tenantId 有访问权。先从 Key 列表读取当前 version，例如 4：

```bash
curl -i -X POST \
  http://127.0.0.1:3000/admin/v1/virtual-keys/frontend-prod/rotation-requests \
  -H "Authorization: Bearer $REQUESTER_ACCESS_TOKEN" \
  -H 'If-Match: "4"'
```

返回 201 和 `rotationRequest.requestId`。此时旧业务 Key 仍正常工作，也没有生成新 Key。

## 第二人批准

把 requestId 交给同一租户的另一名 admin。不要传递申请人的 Access Token：

```bash
curl -i -X POST \
  http://127.0.0.1:3000/admin/v1/rotation-requests/REQUEST_ID/approve \
  -H "Authorization: Bearer $APPROVER_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"已核对 CHG-1234、回滚方案和变更窗口"}'
```

成功响应中的 `key` 只出现一次。批准人应把它写入调用方 Secret Manager，并按变更窗口更新应用。旧 Key 在事务提交后立即失效。

## 拒绝或撤销

另一位同租户 admin 可以拒绝，Key 不会变化：

```bash
curl -X POST http://127.0.0.1:3000/admin/v1/rotation-requests/REQUEST_ID/reject \
  -H "Authorization: Bearer $REVIEWER_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"缺少回滚方案和业务负责人确认"}'
```

只有原申请人可以撤销自己的申请：

```bash
curl -X POST http://127.0.0.1:3000/admin/v1/rotation-requests/REQUEST_ID/cancel \
  -H "Authorization: Bearer $REQUESTER_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"本次发布窗口已取消"}'
```

理由去除首尾空格后必须为 3–500 字符，并作为审计和结果通知的一部分保存。

## 查询待审批

```bash
curl 'http://127.0.0.1:3000/admin/v1/rotation-requests?limit=100&status=pending' \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

只会返回 Token tenantScopes 覆盖的申请。viewer 可查看，只有 admin 可申请或批准。

## 查询通知与标记已读

```bash
curl 'http://127.0.0.1:3000/admin/v1/notifications?unreadOnly=true' \
  -H "Authorization: Bearer $ACCESS_TOKEN"

curl -X POST http://127.0.0.1:3000/admin/v1/notifications/NOTIFICATION_ID/read \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

申请通知按租户广播；批准、拒绝、撤销结果定向原申请人。每个人的已读状态独立。

## 常见失败

| HTTP/code | 含义 | 处理 |
|---|---|---|
| 403 `authorization_error` | 角色不足或不属于该租户 | 检查 groups、tenant Claim 与映射，不能临时加 `*` 绕过 |
| 409 `approval_required` | 调用了旧的直接 rotate API | 改走 rotation-requests 流程 |
| 409 `approval_conflict` 自批 | 申请人与批准人相同 | 换另一名同租户 admin |
| 409 自己 reject | 申请人错误使用拒绝 | 使用 cancel 表达主动撤回 |
| 409 他人 cancel | 非申请人试图撤销 | 由原申请人操作，或由 Reviewer reject |
| 400 理由校验 | 理由少于 3 或超过 500 字符 | 填写可审计的具体原因 |
| 409 已有 pending | 同一个 Key 已有申请 | 查询现有申请；等待批准或过期 |
| 409 expired | 超过审批窗口 | 读取最新 Key version，重新申请 |
| 409 Key changed | 等待期间 Key version 变化 | 重新 Review 当前状态并新建申请 |
| 409 already approved | 重复点击或并发批准 | 不要重试；查询申请和审计确认首次结果 |

## 值班检查

1. 确认 request 的 tenantId、keyId、expectedKeyVersion 和申请人。
2. 确认变更单、调用方联系人和切换窗口。
3. 批准前重新查看 Key 当前状态和模型 ACL。
4. 批准后立即保存一次性 Key；不要放进聊天、截图或工单。
5. 验证新 Key 200、旧 Key 401。
6. 查询 audit，确认 `rotation_requested` 和 `rotated/rejected/cancelled` 的 actor 与理由。
7. 打开通知中心，确认申请待办和结果通知；不要把“标记已读”误认为“已处理”。

## IdP 租户范围回收

人员调岗时从 IdP 移除 tenantId。已签发 JWT 在过期前仍可能保留旧 scope，因此管理 Token 应短期有效。紧急事件应同时撤销 IdP 会话，并检查该 subject 在相关租户的审计。

## Break-glass

静态 Token 的 tenantScopes 是 `*`，但 actor 始终相同，无法自己完成双人审批。只有业务明确批准跳过双人控制时，才临时设置：

```dotenv
ROTATION_APPROVAL_REQUIRED=false
```

这属于高风险降级：必须记录审批、限制窗口、完成后立即恢复 true 并重启。
