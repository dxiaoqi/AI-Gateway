import type { FastifyInstance } from "fastify";

export const registerHealthRoutes = async (
  app: FastifyInstance,
  options: { readiness?: () => Promise<void> } = {},
): Promise<void> => {
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await options.readiness?.();
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "not_ready", dependency: "postgres" });
    }
  });
};
