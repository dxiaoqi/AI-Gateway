import type { AuthContext } from "../auth/types.js";
import type { TraceContext } from "../observability/trace.js";
import type { AdminIdentity } from "../admin-auth/types.js";

declare module "fastify" {
  interface FastifyRequest {
    authContext: AuthContext | undefined;
    traceContext: TraceContext | undefined;
    adminIdentity: AdminIdentity | undefined;
  }
}

export {};
