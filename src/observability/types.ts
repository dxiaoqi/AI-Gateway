export interface ProviderAttemptMetadata {
  logicalModel: string;
  deploymentId: string;
  providerId: string;
  stream: boolean;
}

export type ProviderAttemptOutcome = "success" | "error";
export type RoutingEvent = "cooldown" | "circuit_open" | "half_open" | "recovered";

export interface RoutingObserver {
  providerStarted(metadata: ProviderAttemptMetadata): void;
  providerFinished(
    metadata: ProviderAttemptMetadata,
    durationMs: number,
    outcome: ProviderAttemptOutcome,
    errorCode?: string,
  ): void;
  routingEvent(metadata: ProviderAttemptMetadata, event: RoutingEvent): void;
  tokens(
    metadata: ProviderAttemptMetadata,
    inputTokens: number,
    outputTokens: number,
    estimated: boolean,
  ): void;
}

export const noopRoutingObserver: RoutingObserver = {
  providerStarted: () => undefined,
  providerFinished: () => undefined,
  routingEvent: () => undefined,
  tokens: () => undefined,
};
