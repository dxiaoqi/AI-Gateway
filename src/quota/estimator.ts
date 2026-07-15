import type { CanonicalChatRequest } from "../core/canonical-schema.js";

// Iteration 4 uses a conservative provider-independent estimate. A provider
// tokenizer can replace this interface later without changing the quota flow.
export const estimateInputTokens = (request: CanonicalChatRequest): number => {
  const characters = request.messages.reduce(
    (total, message) => total + message.role.length + message.content.length,
    0,
  );
  const messageOverhead = request.messages.length * 4;
  return Math.max(1, Math.ceil(characters / 4) + messageOverhead);
};

export const estimateReservationTokens = (
  request: CanonicalChatRequest,
): number => estimateInputTokens(request) + (request.maxOutputTokens ?? 0);
