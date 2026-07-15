import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisQuotaStore } from "../src/quota/redis-store.js";

const configuredRedisUrl = process.env.REDIS_TEST_URL;
const redisUrl = configuredRedisUrl ?? "redis://127.0.0.1:6380";
const describeRedis = configuredRedisUrl ? describe : describe.skip;

describeRedis("RedisQuotaStore integration", () => {
  const client = createClient({ url: redisUrl });
  const prefix = `aigw:{quota}:integration:${Date.now()}`;
  const store = new RedisQuotaStore(
    {
      eval: async (script, options) => client.eval(script, options),
    },
    prefix,
  );

  beforeAll(async () => {
    client.on("error", () => {});
    await client.connect();
  });

  afterAll(async () => {
    if (client.isOpen) await client.quit();
  });

  it("atomically rejects, settles and refunds token reservations", async () => {
    const base = {
      policies: [
        {
          id: "tenant-token-budget",
          scope: "tenant" as const,
          scopeId: "tenant-a",
          limits: { tokensPerMinute: 100 },
        },
      ],
      nowMs: 60_000,
      ttlMs: 60_000,
    };
    const first = await store.reserve({
      ...base,
      reservationId: "redis-r1",
      reservedTokens: 80,
    });
    await expect(
      store.reserve({
        ...base,
        reservationId: "redis-blocked",
        reservedTokens: 30,
      }),
    ).rejects.toMatchObject({ code: "quota_tokens_exceeded" });

    await store.settle(first, 20);
    await expect(
      store.reserve({
        ...base,
        reservationId: "redis-r2",
        reservedTokens: 30,
      }),
    ).resolves.toBeDefined();
  });

  it("releases concurrency idempotently", async () => {
    const base = {
      policies: [
        {
          id: "application-concurrency",
          scope: "application" as const,
          scopeId: "app-a",
          limits: { maxConcurrent: 1 },
        },
      ],
      nowMs: 120_000,
      ttlMs: 60_000,
      reservedTokens: 10,
    };
    const first = await store.reserve({
      ...base,
      reservationId: "redis-concurrent-r1",
    });
    await expect(
      store.reserve({ ...base, reservationId: "redis-concurrent-blocked" }),
    ).rejects.toMatchObject({ code: "quota_concurrency_exceeded" });

    await store.settle(first, 4);
    await store.settle(first, 4);
    await expect(
      store.reserve({ ...base, reservationId: "redis-concurrent-r2" }),
    ).resolves.toBeDefined();
  });
});
