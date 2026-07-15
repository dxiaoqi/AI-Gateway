import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/core/errors.js";
import {
  RedisQuotaStore,
  type RedisEvalClient,
} from "../src/quota/redis-store.js";

const input = {
  reservationId: "r1",
  policies: [
    {
      id: "tenant-a",
      scope: "tenant" as const,
      scopeId: "tenant-a",
      limits: {
        requestsPerMinute: 10,
        tokensPerMinute: 100,
        maxConcurrent: 2,
      },
    },
  ],
  reservedTokens: 40,
  nowMs: 60_000,
  ttlMs: 10_000,
};

describe("RedisQuotaStore", () => {
  it("builds one atomic reservation for all policy keys", async () => {
    const calls: Array<{ keys: string[]; arguments: string[] }> = [];
    const store = new RedisQuotaStore({
      eval: async (_script, options) => {
        calls.push(options);
        return [1];
      },
    });
    const reservation = await store.reserve(input);
    expect(reservation).toMatchObject({ id: "r1", reservedTokens: 40 });
    expect(calls).toHaveLength(1);
    const options = calls[0];
    expect(options?.keys).toHaveLength(2);
    expect(options?.arguments).toContain("40");
  });

  it("maps a Lua token rejection to the public quota error", async () => {
    const client: RedisEvalClient = { eval: async () => [0, 1, 2] };
    const store = new RedisQuotaStore(client);
    await expect(store.reserve(input)).rejects.toMatchObject({
      statusCode: 429,
      code: "quota_tokens_exceeded",
    } satisfies Partial<GatewayError>);
  });

  it("settles through a single idempotent Lua call", async () => {
    const calls: Array<{ keys: string[]; arguments: string[] }> = [];
    const store = new RedisQuotaStore({
      eval: async (_script, options) => {
        calls.push(options);
        return [1];
      },
    });
    const reservation = await store.reserve(input);
    await store.settle(reservation, 12);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.arguments).toEqual(["r1", "40", "12"]);
  });
});
