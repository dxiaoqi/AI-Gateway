import type { AuthContext } from "../auth/types.js";
import type {
  QuotaPolicy,
  QuotaReservation,
  QuotaStore,
} from "./types.js";
import { getScopeId } from "./types.js";

export class QuotaService {
  constructor(
    private readonly policies: readonly QuotaPolicy[],
    private readonly store: QuotaStore,
    private readonly reservationTtlMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  matchingPolicies(context: AuthContext): QuotaPolicy[] {
    return this.policies.filter(
      (policy) => getScopeId(context, policy.scope) === policy.scopeId,
    );
  }

  async reserve(
    context: AuthContext,
    reservationId: string,
    reservedTokens: number,
  ): Promise<QuotaReservation | undefined> {
    const policies = this.matchingPolicies(context);
    if (policies.length === 0) return undefined;
    return this.store.reserve({
      reservationId,
      policies,
      reservedTokens,
      nowMs: this.clock(),
      ttlMs: this.reservationTtlMs,
    });
  }

  async settle(
    reservation: QuotaReservation | undefined,
    actualTokens: number,
  ): Promise<void> {
    if (!reservation) return;
    await this.store.settle(reservation, actualTokens);
  }

  async cancel(reservation: QuotaReservation | undefined): Promise<void> {
    await this.settle(reservation, 0);
  }
}
