export type GatewayErrorCode =
  | "authentication_error"
  | "authorization_error"
  | "invalid_request_error"
  | "model_not_found"
  | "provider_authentication_error"
  | "provider_invalid_response"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_unavailable"
  | "quota_requests_exceeded"
  | "quota_tokens_exceeded"
  | "quota_concurrency_exceeded"
  | "budget_exceeded"
  | "content_policy_violation"
  | "resource_not_found"
  | "resource_conflict"
  | "version_conflict"
  | "precondition_required"
  | "approval_required"
  | "approval_conflict"
  | "internal_error";

export class GatewayError extends Error {
  readonly statusCode: number;
  readonly code: GatewayErrorCode;
  readonly retryable: boolean;

  constructor(options: {
    message: string;
    statusCode: number;
    code: GatewayErrorCode;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "GatewayError";
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

export const toGatewayError = (error: unknown): GatewayError => {
  if (error instanceof GatewayError) {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new GatewayError({
      message: "The upstream model provider timed out",
      statusCode: 504,
      code: "provider_timeout",
      retryable: true,
      cause: error,
    });
  }

  return new GatewayError({
    message: "The gateway encountered an unexpected error",
    statusCode: 500,
    code: "internal_error",
    cause: error,
  });
};
