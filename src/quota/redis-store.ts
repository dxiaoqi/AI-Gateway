import { quotaExceededError, type QuotaLimitKind } from "./errors.js";
import type {
  QuotaReservation,
  QuotaReserveInput,
  QuotaStore,
} from "./types.js";

export interface RedisEvalClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

const RESERVE_SCRIPT = `
local policy_count = #KEYS / 2
local reservation_id = ARGV[1]
local now_ms = tonumber(ARGV[2])
local expires_at = tonumber(ARGV[3])
local reserved_tokens = tonumber(ARGV[4])
local window_ttl = tonumber(ARGV[5])
local active_ttl = tonumber(ARGV[6])

for i = 1, policy_count do
  local window_key = KEYS[(i - 1) * 2 + 1]
  local active_key = KEYS[(i - 1) * 2 + 2]
  local base = 6 + (i - 1) * 3
  local rpm = tonumber(ARGV[base + 1])
  local tpm = tonumber(ARGV[base + 2])
  local concurrent_limit = tonumber(ARGV[base + 3])

  redis.call('ZREMRANGEBYSCORE', active_key, '-inf', now_ms)
  local requests = tonumber(redis.call('HGET', window_key, 'requests') or '0')
  local tokens = tonumber(redis.call('HGET', window_key, 'tokens') or '0')
  local concurrent = tonumber(redis.call('ZCARD', active_key))

  if rpm > 0 and requests + 1 > rpm then
    return {0, i, 1}
  end
  if tpm > 0 and tokens + reserved_tokens > tpm then
    return {0, i, 2}
  end
  if concurrent_limit > 0 and concurrent + 1 > concurrent_limit then
    return {0, i, 3}
  end
end

for i = 1, policy_count do
  local window_key = KEYS[(i - 1) * 2 + 1]
  local active_key = KEYS[(i - 1) * 2 + 2]
  redis.call('HINCRBY', window_key, 'requests', 1)
  redis.call('HINCRBY', window_key, 'tokens', reserved_tokens)
  redis.call('EXPIRE', window_key, window_ttl)
  redis.call('ZADD', active_key, expires_at, reservation_id)
  redis.call('EXPIRE', active_key, active_ttl)
end

return {1}
`;

const SETTLE_SCRIPT = `
local reservation_id = ARGV[1]
local reserved_tokens = tonumber(ARGV[2])
local actual_tokens = tonumber(ARGV[3])
local delta = actual_tokens - reserved_tokens
local policy_count = #KEYS / 2

for i = 1, policy_count do
  local window_key = KEYS[(i - 1) * 2 + 1]
  local active_key = KEYS[(i - 1) * 2 + 2]
  local removed = redis.call('ZREM', active_key, reservation_id)
  if removed == 1 and delta ~= 0 then
    local tokens = tonumber(redis.call('HINCRBY', window_key, 'tokens', delta))
    if tokens < 0 then
      redis.call('HSET', window_key, 'tokens', 0)
    end
  end
end

return {1}
`;

const encodeKeyPart = (value: string): string => encodeURIComponent(value);

const asNumber = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10);
  return Number.NaN;
};

export class RedisQuotaStore implements QuotaStore {
  constructor(
    private readonly client: RedisEvalClient,
    // The hash tag keeps all keys in one Redis Cluster slot so the multi-key
    // Lua reservation remains atomic. Iteration 4 trades horizontal shard
    // distribution for strict cross-policy atomicity.
    private readonly keyPrefix = "aigw:{quota}",
  ) {}

  async reserve(input: QuotaReserveInput): Promise<QuotaReservation> {
    const minuteBucket = Math.floor(input.nowMs / 60_000);
    const entries = input.policies.map((policy) => {
      const policyKey = encodeKeyPart(policy.id);
      return {
        policyId: policy.id,
        windowKey: `${this.keyPrefix}:window:${policyKey}:${minuteBucket}`,
        activeKey: `${this.keyPrefix}:active:${policyKey}`,
      };
    });
    const keys = entries.flatMap((entry) => [entry.windowKey, entry.activeKey]);
    const arguments_ = [
      input.reservationId,
      String(input.nowMs),
      String(input.nowMs + input.ttlMs),
      String(input.reservedTokens),
      "120",
      String(Math.ceil(input.ttlMs / 1_000) + 60),
      ...input.policies.flatMap((policy) => [
        String(policy.limits.requestsPerMinute ?? 0),
        String(policy.limits.tokensPerMinute ?? 0),
        String(policy.limits.maxConcurrent ?? 0),
      ]),
    ];

    const result = await this.client.eval(RESERVE_SCRIPT, {
      keys,
      arguments: arguments_,
    });
    if (!Array.isArray(result) || asNumber(result[0]) !== 1) {
      const policyIndex = asNumber(Array.isArray(result) ? result[1] : undefined) - 1;
      const reason = asNumber(Array.isArray(result) ? result[2] : undefined);
      const policy = input.policies[policyIndex];
      if (!policy || ![1, 2, 3].includes(reason)) {
        throw new Error("Redis returned an invalid quota reservation result");
      }
      const kind: QuotaLimitKind =
        reason === 1 ? "requests" : reason === 2 ? "tokens" : "concurrency";
      throw quotaExceededError(policy.id, kind);
    }

    return {
      id: input.reservationId,
      reservedTokens: input.reservedTokens,
      entries,
    };
  }

  async settle(
    reservation: QuotaReservation,
    actualTokens: number,
  ): Promise<void> {
    await this.client.eval(SETTLE_SCRIPT, {
      keys: reservation.entries.flatMap((entry) => [
        entry.windowKey,
        entry.activeKey,
      ]),
      arguments: [
        reservation.id,
        String(reservation.reservedTokens),
        String(actualTokens),
      ],
    });
  }
}
