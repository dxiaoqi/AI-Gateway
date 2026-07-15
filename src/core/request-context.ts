export interface RequestContext {
  requestId: string;
  startedAt: number;
  signal: AbortSignal;
  traceId?: string;
  traceparent?: string;
}
