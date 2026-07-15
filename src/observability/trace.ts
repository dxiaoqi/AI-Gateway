import { randomBytes } from "node:crypto";

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: string;
  traceparent: string;
}

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/iu;
const allZeros = /^0+$/u;

export const createTraceContext = (incoming?: string): TraceContext => {
  const match = incoming?.match(traceparentPattern);
  const incomingTraceId = match?.[1]?.toLowerCase();
  const traceId = incomingTraceId && !allZeros.test(incomingTraceId)
    ? incomingTraceId
    : randomBytes(16).toString("hex");
  const incomingFlags = match?.[3]?.toLowerCase();
  const traceFlags = incomingFlags ?? "01";
  const spanId = randomBytes(8).toString("hex");
  return {
    traceId,
    spanId,
    traceFlags,
    traceparent: `00-${traceId}-${spanId}-${traceFlags}`,
  };
};
