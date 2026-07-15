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
    private dynamicPolicies?: (context: AuthContext) => Promise<QuotaPolicy[]>,
  ) {}

  setDynamicPolicySource(source: (context: AuthContext) => Promise<QuotaPolicy[]>): void {
    this.dynamicPolicies = source;
  }

  matchingPolicies(context: AuthContext, additional: readonly QuotaPolicy[] = []): QuotaPolicy[] {
    const dynamicIds = new Set(additional.map((policy) => policy.id));
    return [...this.policies.filter((policy) => !dynamicIds.has(policy.id)), ...additional].filter(
      (policy) => getScopeId(context, policy.scope) === policy.scopeId,
    );
  }

  async reserve(
    context: AuthContext,
    reservationId: string,
    reservedTokens: number,
  ): Promise<QuotaReservation | undefined> {
    const policies = this.matchingPolicies(context, await this.dynamicPolicies?.(context) ?? []);
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
