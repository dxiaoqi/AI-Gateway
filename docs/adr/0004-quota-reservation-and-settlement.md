# ADR 0004：调用前配额预留与调用后结算

- 状态：Accepted
- 日期：2026-07-15

## 背景

模型费用按 Token 产生，但输出 Token 只有模型完成后才确定。如果等回答完成后才检查额度，多个并发请求会在同一时间看到“还有余额”，随后一起产生费用，造成预算穿透。请求还可能持续很久或因进程崩溃不释放并发。

## 决策

每个请求采用两阶段资源治理：

```text
调用前：估算输入 Token + 最大输出 Token → 原子预留
调用后：Provider 实际 Usage → 结算并退回未使用 Token
```

所有与身份匹配的策略都必须通过，例如 Tenant、Project、Application 和 Key。预留是全有或全无：任一层级超限时，任何层级都不能增加计数。

限制类型：

- RPM：每分钟请求数，预留时 +1，结束后不退款。
- TPM：每分钟 Token 数，先按估算预留，结束后调整为实际值。
- Max Concurrent：活动请求数，预留时占位，结算/取消时释放。

开发和测试使用进程内 Store。配置 Redis 后使用 Lua 在服务端一次完成多策略检查和变更。所有 Redis Key 使用同一 Cluster Hash Tag `{quota}`，保证多 Key Lua 位于同一 Slot。

活动并发使用 Sorted Set：member 是 request id，score 是过期时间。新预留前清理过期 member，因此进程崩溃不会永久占用并发。

## 故障语义

- 预留失败或 Redis 不可用：调用前失败，阻止产生无法治理的费用。
- Provider 成功、结算失败：仍把结果返回用户；预留保持保守值并记录错误。
- Provider 调用失败：保留 RPM，释放并发并退回预留 Token。
- 流式缺少最终 Usage：按完整预留值结算，不退款。
- 重复结算：通过活动 member 的 `ZREM` 结果保证幂等。

## 结果

正面影响：

- 并发请求无法轻易穿透 Token 和并发额度。
- 多层策略不会发生只扣一部分的状态。
- 实际使用通常小于最大输出，结算能释放额度。
- Redis 允许多个网关实例共享统一计数。

代价与限制：

- 当前 Token 估算不是 Provider 精确 tokenizer。
- 固定分钟窗口在边界可能允许短时间双倍突发。
- 所有配额 Key 位于一个 Redis Cluster Slot，原子性强但水平扩展有限。
- Provider 失败是否已经产生费用无法总是确定，当前选择退款，未来需账单对账修正。
- 长请求超过 reservation TTL 后并发会被提前释放，后续需要 heartbeat。
