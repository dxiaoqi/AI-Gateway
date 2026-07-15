import { describe, expect, it } from "vitest";
import type { AuthContext } from "../src/auth/types.js";
import { GatewayError } from "../src/core/errors.js";
import { InMemoryQuotaStore } from "../src/quota/in-memory-store.js";
import { QuotaService } from "../src/quota/service.js";
import type { QuotaPolicy } from "../src/quota/types.js";

const context: AuthContext = {
  keyId: "key-a",
  tenantId: "tenant-a",
  projectId: "project-a",
  applicationId: "app-a",
  allowedModels: ["general"],
};

const policy = (
  id: string,
  limits: QuotaPolicy["limits"],
  scope: QuotaPolicy["scope"] = "key",
  scopeId = "key-a",
): QuotaPolicy => ({ id, scope, scopeId, limits });

describe("InMemoryQuotaStore", () => {
  it("keeps request count after settlement", async () => {
    const store = new InMemoryQuotaStore();
    const service = new QuotaService(
      [policy("rpm", { requestsPerMinute: 1 })],
      store,
      60_000,
      () => 1_000,
    );
    const reservation = await service.reserve(context, "r1", 10);
    await service.settle(reservation, 4);
    await expect(service.reserve(context, "r2", 10)).rejects.toMatchObject({
      statusCode: 429,
      code: "quota_requests_exceeded",
    } satisfies Partial<GatewayError>);
  });

  it("refunds unused reserved tokens after actual usage is known", async () => {
    const store = new InMemoryQuotaStore();
    const service = new QuotaService(
      [policy("tpm", { tokensPerMinute: 100 })],
      store,
      60_000,
      () => 1_000,
    );
    const first = await service.reserve(context, "r1", 80);
    await expect(service.reserve(context, "blocked", 30)).rejects.toMatchObject({
      code: "quota_tokens_exceeded",
    });
    await service.settle(first, 20);
    await expect(service.reserve(context, "r2", 30)).resolves.toBeDefined();
    expect(store.snapshot("tpm", 1_000).tokens).toBe(50);
  });

  it("releases concurrency and settlement is idempotent", async () => {
    const store = new InMemoryQuotaStore();
    const service = new QuotaService(
      [policy("concurrency", { maxConcurrent: 1, tokensPerMinute: 100 })],
      store,
      60_000,
      () => 1_000,
    );
    const first = await service.reserve(context, "r1", 40);
    await expect(service.reserve(context, "blocked", 10)).rejects.toMatchObject({
      code: "quota_concurrency_exceeded",
    });
    await service.settle(first, 10);
    await service.settle(first, 10);
    expect(store.snapshot("concurrency", 1_000)).toEqual({
      requests: 1,
      tokens: 10,
      concurrent: 0,
    });
    await expect(service.reserve(context, "r2", 10)).resolves.toBeDefined();
  });

  it("refunds reserved tokens when a provider call is cancelled", async () => {
    const store = new InMemoryQuotaStore();
    const service = new QuotaService(
      [policy("cancel", { tokensPerMinute: 100, maxConcurrent: 1 })],
      store,
      60_000,
      () => 1_000,
    );
    const reservation = await service.reserve(context, "failed", 40);
    await service.cancel(reservation);
    expect(store.snapshot("cancel", 1_000)).toEqual({
      requests: 1,
      tokens: 0,
      concurrent: 0,
    });
  });

  it("checks every matching level before changing any counter", async () => {
    const store = new InMemoryQuotaStore();
    const service = new QuotaService(
      [
        policy("tenant", { tokensPerMinute: 100 }, "tenant", "tenant-a"),
        policy("app", { tokensPerMinute: 50 }, "application", "app-a"),
      ],
      store,
      60_000,
      () => 1_000,
    );
    await expect(service.reserve(context, "r1", 60)).rejects.toMatchObject({
      code: "quota_tokens_exceeded",
    });
    expect(store.snapshot("tenant", 1_000)).toEqual({
      requests: 0,
      tokens: 0,
      concurrent: 0,
    });
    expect(store.snapshot("app", 1_000)).toEqual({
      requests: 0,
      tokens: 0,
      concurrent: 0,
    });
  });

  it("prunes expired reservations so a crashed request does not hold concurrency forever", async () => {
    let now = 1_000;
    const store = new InMemoryQuotaStore();
    const service = new QuotaService(
      [policy("ttl", { maxConcurrent: 1 })],
      store,
      500,
      () => now,
    );
    await service.reserve(context, "abandoned", 10);
    await expect(service.reserve(context, "blocked", 10)).rejects.toMatchObject({
      code: "quota_concurrency_exceeded",
    });
    now = 1_501;
    await expect(service.reserve(context, "replacement", 10)).resolves.toBeDefined();
  });
});
