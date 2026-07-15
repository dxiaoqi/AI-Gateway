import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { LocalAdminAccountService } from "../../admin-auth/local.js";

const BootstrapBody = Type.Object({
  organizationName: Type.String({ minLength: 2, maxLength: 100 }),
  username: Type.String({ minLength: 3, maxLength: 100 }),
  password: Type.String({ minLength: 12, maxLength: 128 }),
}, { additionalProperties: false });
const LoginBody = Type.Object({ username: Type.String({ minLength: 3, maxLength: 100 }), password: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false });

export const registerAdminLocalAuthRoutes = async (app: FastifyInstance, service: LocalAdminAccountService) => {
  app.get("/admin/auth/local/status", async () => service.status());
  app.post("/admin/auth/local/bootstrap", { schema: { body: BootstrapBody } }, async (request, reply) => {
    const body = request.body as typeof BootstrapBody.static;
    const authorization = request.headers.authorization;
    const bootstrapToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const result = await service.bootstrap(body, bootstrapToken);
    return reply.status(201).send(result);
  });
  app.post("/admin/auth/local/login", { schema: { body: LoginBody } }, async (request) => {
    const body = request.body as typeof LoginBody.static;
    return service.login(body, `${request.ip}:${body.username.trim().toLowerCase()}`);
  });
};
