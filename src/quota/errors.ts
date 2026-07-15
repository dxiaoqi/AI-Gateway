import { GatewayError } from "../core/errors.js";

export type QuotaLimitKind = "requests" | "tokens" | "concurrency";

export const quotaExceededError = (
  policyId: string,
  kind: QuotaLimitKind,
): GatewayError => {
  const code =
    kind === "requests"
      ? "quota_requests_exceeded"
      : kind === "tokens"
        ? "quota_tokens_exceeded"
        : "quota_concurrency_exceeded";
  return new GatewayError({
    message: `Quota policy '${policyId}' exceeded its ${kind} limit`,
    statusCode: 429,
    code,
    retryable: true,
  });
};
