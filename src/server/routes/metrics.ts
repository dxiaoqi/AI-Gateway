import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { GatewayError } from "../../core/errors.js";
import type { MetricsRegistry } from "../../observability/metrics.js";

const matchesToken = (authorization: string | undefined, expected: string): boolean => {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  const actual = Buffer.from(authorization.slice(prefix.length));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
};

export const registerMetricsRoutes = async (
  app: FastifyInstance,
  dependencies: { registry: MetricsRegistry; bearerToken: string },
): Promise<void> => {
  app.get("/metrics", async (request, reply) => {
    if (!matchesToken(request.headers.authorization, dependencies.bearerToken)) {
      throw new GatewayError({
        message: "A valid metrics bearer token is required",
        statusCode: 401,
        code: "authentication_error",
      });
    }
    return reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(dependencies.registry.render());
  });
};
