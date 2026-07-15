# Iteration 4：RPM、TPM、并发与 Redis 原子配额

- 版本：0.4.0
- 日期：2026-07-15
- 状态：Completed
- 关联 ADR：[ADR 0004](../adr/0004-quota-reservation-and-settlement.md)

## 一句话说明

这一轮让网关可以在花钱调用模型之前，先确认团队是否还有请求、Token 和并发额度。

## 30 秒领导摘要

| 领导关心的问题 | 回答 |
|---|---|
| 以前的问题 | 某个应用可以无限并发调用模型，耗尽供应商配额或产生不可控费用。 |
| 本轮交付 | 按 Tenant/Project/Application/Key 配置 RPM、TPM 和最大并发；调用前预留，调用后结算。 |
| 业务价值 | 防止单个团队挤占全公司资源，并为预算和成本中心治理建立执行点。 |
| 如何证明 | 40 项默认测试、2 项真实 Redis Lua 测试、完整网关 200→429 冒烟验证。 |
| 最大剩余风险 | Token 还是通用估算；没有金额预算、管理界面和 Provider 账单对账。 |

### 最短演示

```bash
docker compose up -d redis
REDIS_TEST_URL=redis://127.0.0.1:6380 npm run test:redis
```

真实结果应为 2 项 Redis 测试通过。默认 `npm run verify` 不要求 Redis，方便新人先运行项目。

## 新人工程师导读

### 阅读前只需要知道

- 模型按 Token 计费，输入和输出都会消耗 Token。
- 多个 Promise 可以同时发请求，不能假设请求会依次执行。
- Redis Lua 可以把“检查再修改”作为一个不可被其他请求插入的操作。

### 本轮术语

| 术语 | 小白解释 | 前端类比 |
|---|---|---|
| RPM | 每分钟最多多少次请求 | API rate limit |
| TPM | 每分钟最多使用多少 Token | 按流量大小计费的带宽额度 |
| Max Concurrent | 同时正在处理的请求上限 | 同时进行的上传任务数 |
| Reservation | 在真正消费前先占住预计额度 | 电商下单先锁库存、酒店先冻结房间 |
| Settlement | 完成后用实际用量修正预留 | 支付预授权后按实际账单扣款 |
| Atomic | 多个检查和修改要么全成功，要么全不发生 | Redux reducer 一次生成完整新 state，而不是改一半 |
| Lua Script | 在 Redis 内一次执行的逻辑 | 把多次 API 往返变成一个服务端事务动作 |
| TTL | 占位多久自动失效 | 前端缓存/验证码的过期时间 |
| Fixed Window | 按自然分钟重新计数 | 每分钟整点清零的计数器 |

### 为什么不能回答完再扣 Token

假设团队还剩 1000 Token，同时来了 20 个请求，每个可能用 100 Token：

```text
错误做法：20 个请求都先看到“剩余 1000” → 全部调用 → 最终使用 2000
正确做法：每个请求先原子预留 100 → 只有前 10 个能进入 Provider
```

这和前端抢购库存类似：不能等支付完成后才检查库存，否则大量用户会同时买到最后一件商品。

### 一次请求逐步发生了什么

1. 请求先完成 Key 认证和模型 ACL。
2. 网关生成 Canonical Request；没有 `max_tokens` 时使用统一默认上限。
3. Estimator 根据消息长度估算输入 Token。
4. `预留 Token = 估算输入 + 最大输出`，这是保守上界。
5. QuotaService 根据 AuthContext 找到所有匹配策略，例如 Tenant 额度和 Application 额度。
6. Store 一次检查 RPM、TPM、并发以及全部层级。
7. 任一策略超限：返回 429，Provider 根本不会被调用，因此不产生模型费用。
8. 全部通过：请求数 +1、Token 预留、活动并发 +1。
9. Provider 返回实际 Usage，例如预留 520，实际只用 23。
10. Settlement 把 Token 从 520 调整为 23，并释放活动并发。
11. 如果 Provider 失败，RPM 保留，但 Token 预留退款、并发释放。

### 为什么 RPM 不退款

RPM 保护的是网关和 Provider 的请求压力，而不是费用。即使请求格式错误或 Provider 拒绝，它仍消耗了认证、网络和解析资源。如果失败请求也退款，攻击者可以用大量失败请求绕过限流。

### 为什么需要 Redis

单进程内存 Map 类似浏览器 tab 内的 state。启动两个网关实例后，每个实例都以为自己有完整额度，实际限制会翻倍。Redis 像所有实例共享的服务端 store；Lua 确保两个实例同时请求时仍只有一个能拿到最后额度。

## 1. 本轮目标

- 支持 RPM、TPM 和最大并发。
- 支持 Tenant/Project/Application/Key 多层策略同时生效。
- 实现预留、实际 Usage 结算、失败退款和幂等释放。
- 提供内存 Store 和 Redis Lua Store。
- 生产启用配额时强制使用 Redis。

## 2. 非目标

- 美元/人民币金额预算和价格版本。
- 滑动窗口、令牌桶和请求优先级。
- 精确 Provider tokenizer。
- 配额管理 API、界面和审批流。
- 多 Redis Slot 分片、跨区域全局额度。

## 3. 策略模型

```json
{
  "id": "tenant-default",
  "scope": "tenant",
  "scopeId": "tenant-a",
  "limits": {
    "requestsPerMinute": 60,
    "tokensPerMinute": 10000,
    "maxConcurrent": 5
  }
}
```

一个请求可能同时匹配多条策略，例如公司 Tenant 100k TPM、项目 20k TPM、应用 5k TPM。必须全部通过。

## 4. 内存与 Redis 两种实现

| 实现 | 用途 | 优点 | 限制 |
|---|---|---|---|
| InMemoryQuotaStore | 默认开发、单元测试 | 无依赖、容易理解 | 多实例各自计数，不能用于生产 |
| RedisQuotaStore | 多实例和生产 | Lua 原子、共享状态、TTL | 需要 Redis；当前集中在一个 Cluster Slot |

两个 Store 实现相同接口，因此 HTTP Route 不关心状态保存在哪里。

## 5. Redis 数据结构

```text
Hash  aigw:{quota}:window:<policy>:<minute>
  requests = 当前窗口请求数
  tokens   = 当前窗口预留/实际 Token

ZSET  aigw:{quota}:active:<policy>
  member = request id
  score  = reservation expiresAt
```

Lua 第一遍只检查全部策略，全部通过后第二遍才修改。这样应用策略拒绝时，Tenant 计数也不会被错误增加。

## 6. 错误语义

| 超限类型 | HTTP | Code |
|---|---:|---|
| RPM | 429 | `quota_requests_exceeded` |
| TPM | 429 | `quota_tokens_exceeded` |
| 并发 | 429 | `quota_concurrency_exceeded` |

三者都标记 `retryable=true`，但客户端应退避，而不是立即无限重试。

## 7. 代码导读

| 文件 | 新人应该看什么 |
|---|---|
| `src/quota/types.ts` | Policy、Reservation、Store 的语言模型 |
| `src/quota/estimator.ts` | 如何估算输入和预留 Token |
| `src/quota/service.ts` | 身份如何匹配多层策略 |
| `src/quota/in-memory-store.ts` | 最容易读懂的完整算法 |
| `src/quota/redis-store.ts` | 同一算法如何变成 Redis Lua 原子操作 |
| `src/quota/factory.ts` | 根据 `REDIS_URL` 选择 backend |
| `src/server/routes/chat-completions.ts` | 预留如何包住非流式和流式 Provider 调用 |

建议新人先读 InMemory Store，再读 Redis Lua；不要反过来。

## 8. 测试矩阵

| 场景 | 证据 |
|---|---|
| RPM 用尽后拒绝 | Store + HTTP 测试 |
| Token 预留过大时 Provider 前拒绝 | HTTP 429 测试 |
| 实际 Usage 小于预留时退款 | Store 测试 |
| 最大并发释放、重复结算 | Store + Redis 集成测试 |
| 多层策略全有或全无 | Store 测试 |
| 进程崩溃留下的并发自动过期 | TTL 测试 |
| Redis Lua 实际执行 | Docker Redis 2 项集成测试 |
| 完整网关 Redis backend | 第一次 200、第二次 429 冒烟 |

## 9. 实际验证证据

```text
Typecheck: passed
Build: passed
Default tests: 40 passed, 2 Redis tests skipped
Redis integration: 2/2 passed
End-to-end Redis quota: first HTTP 200, second HTTP 429
Second error code: quota_requests_exceeded
```

## 10. 已知限制与业务影响

- 通用字符估算可能与真实 tokenizer 有偏差：额度会偏保守或偶尔超出。
- 固定窗口在分钟边界允许短时突发：高风险业务后续需令牌桶/滑动窗口。
- Provider 失败当前退款 Token，但供应商可能已产生少量费用：财务级准确需要账单对账。
- 所有 Redis Key 使用单一 Hash Slot：中等规模足够，大规模需要重新设计分片与全局额度。
- 没有向客户端返回 remaining quota 或 reset time：开发者体验仍不完整。
- Redis 后续中断不会立即改变 readiness：需要健康探针和告警。

## 11. 领导 Review 问题

- 配额层级是否与公司 Tenant/项目/应用组织一致？
- RPM、TPM、并发的初始默认值由谁批准？
- 超限应该硬拒绝，还是允许高优业务借用额度？
- 是否需要下一步先做金额预算，还是先做路由与高可用？
- Redis 单点和跨区域策略是否满足计划中的部署规模？

## 12. 工程师 Review 清单

- [ ] Provider 调用是否一定发生在预留之后？
- [ ] 多条策略是否全有或全无？
- [ ] 非流式与流式是否都结算？
- [ ] 取消、超时和异常是否释放并发？
- [ ] 重复 settle 是否幂等？
- [ ] 预留过期是否会永久占用并发？
- [ ] 生产启用策略时是否强制 Redis？
