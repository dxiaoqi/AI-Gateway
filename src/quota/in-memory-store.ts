import { quotaExceededError } from "./errors.js";
import type {
  QuotaPolicy,
  QuotaReservation,
  QuotaReservationEntry,
  QuotaReserveInput,
  QuotaStore,
} from "./types.js";

interface WindowState {
  requests: number;
  tokens: number;
}

export class InMemoryQuotaStore implements QuotaStore {
  private readonly windows = new Map<string, WindowState>();
  private readonly activeByPolicy = new Map<string, Map<string, number>>();

  async reserve(input: QuotaReserveInput): Promise<QuotaReservation> {
    const minuteBucket = Math.floor(input.nowMs / 60_000);
    const entries = input.policies.map((policy) => ({
      policy,
      entry: {
        policyId: policy.id,
        windowKey: `memory:window:${policy.id}:${minuteBucket}`,
        activeKey: `memory:active:${policy.id}`,
      },
    }));

    for (const { policy, entry } of entries) {
      const window = this.windows.get(entry.windowKey) ?? {
        requests: 0,
        tokens: 0,
      };
      const active = this.getActive(policy.id);
      this.pruneExpired(active, input.nowMs);
      this.assertWithinLimits(policy, window, active.size, input.reservedTokens);
    }

    const expiresAt = input.nowMs + input.ttlMs;
    for (const { policy, entry } of entries) {
      const window = this.windows.get(entry.windowKey) ?? {
        requests: 0,
        tokens: 0,
      };
      window.requests += 1;
      window.tokens += input.reservedTokens;
      this.windows.set(entry.windowKey, window);
      this.getActive(policy.id).set(input.reservationId, expiresAt);
    }

    return {
      id: input.reservationId,
      reservedTokens: input.reservedTokens,
      entries: entries.map(({ entry }) => entry),
    };
  }

  async settle(
    reservation: QuotaReservation,
    actualTokens: number,
  ): Promise<void> {
    for (const entry of reservation.entries) {
      const removed = this.getActive(entry.policyId).delete(reservation.id);
      if (!removed) continue;
      const window = this.windows.get(entry.windowKey);
      if (window) {
        window.tokens = Math.max(
          0,
          window.tokens + actualTokens - reservation.reservedTokens,
        );
      }
    }
  }

  snapshot(policyId: string, nowMs: number): {
    requests: number;
    tokens: number;
    concurrent: number;
  } {
    const bucket = Math.floor(nowMs / 60_000);
    const window = this.windows.get(`memory:window:${policyId}:${bucket}`) ?? {
      requests: 0,
      tokens: 0,
    };
    const active = this.getActive(policyId);
    this.pruneExpired(active, nowMs);
    return { ...window, concurrent: active.size };
  }

  private getActive(policyId: string): Map<string, number> {
    const current = this.activeByPolicy.get(policyId);
    if (current) return current;
    const active = new Map<string, number>();
    this.activeByPolicy.set(policyId, active);
    return active;
  }

  private pruneExpired(active: Map<string, number>, nowMs: number): void {
    for (const [reservationId, expiresAt] of active) {
      if (expiresAt <= nowMs) active.delete(reservationId);
    }
  }

  private assertWithinLimits(
    policy: QuotaPolicy,
    window: WindowState,
    concurrent: number,
    reservedTokens: number,
  ): void {
    if (
      policy.limits.requestsPerMinute !== undefined &&
      window.requests + 1 > policy.limits.requestsPerMinute
    ) {
      throw quotaExceededError(policy.id, "requests");
    }
    if (
      policy.limits.tokensPerMinute !== undefined &&
      window.tokens + reservedTokens > policy.limits.tokensPerMinute
    ) {
      throw quotaExceededError(policy.id, "tokens");
    }
    if (
      policy.limits.maxConcurrent !== undefined &&
      concurrent + 1 > policy.limits.maxConcurrent
    ) {
      throw quotaExceededError(policy.id, "concurrency");
    }
  }
}
