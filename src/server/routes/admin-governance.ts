import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AdminAuthorizationService } from "../../admin-auth/service.js";
import { GatewayError } from "../../core/errors.js";
import type { GovernanceKind } from "../../governance/types.js";
import type { GovernanceService } from "../../governance/service.js";

const paths: Record<string, GovernanceKind> = {
  "model-deployments": "model-deployment", "quota-policies": "quota-policy",
  "pricing-rules": "pricing-rule", budgets: "budget", "guardrail-policies": "guardrail-policy",
};
const Body = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  tenantId: Type.String({ minLength: 1, maxLength: 200 }),
  enabled: Type.Optional(Type.Boolean()),
  spec: Type.Record(Type.String(), Type.Any()),
}, { additionalProperties: false });
const PatchBody = Type.Object({ enabled: Type.Optional(Type.Boolean()), spec: Type.Optional(Type.Record(Type.String(), Type.Any())) }, { additionalProperties: false, minProperties: 1 });
const Params = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) });
const UsageQuery = Type.Object({ tenantId: Type.String({ minLength: 1 }), currency: Type.Union([Type.Literal("CNY"), Type.Literal("USD")]) });

const version = (request: FastifyRequest) => {
  const value = request.headers["if-match"];
  const raw = (Array.isArray(value) ? value[0] : value)?.replace(/^W\//, "").replaceAll('"', "");
  const parsed = raw && /^\d+$/u.test(raw) ? Number(raw) : 0;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new GatewayError({ message: "A positive resource version is required in If-Match", statusCode: 428, code: "precondition_required" });
  return parsed;
};

export const registerAdminGovernanceRoutes = async (app: FastifyInstance, options: { service: GovernanceService; authorization: AdminAuthorizationService }) => {
  const authenticate = (permission: "governance:read" | "governance:write") => async (request: FastifyRequest) => {
    const identity = await options.authorization.authenticate(request.headers.authorization);
    request.adminIdentity = identity; options.authorization.assertPermission(identity, permission);
  };
  const actor = (request: FastifyRequest) => ({ actorId: request.adminIdentity!.actorId, requestId: request.id, ...(request.traceContext ? { traceId: request.traceContext.traceId } : {}) });

  for (const [path, kind] of Object.entries(paths)) {
    app.get(`/admin/v1/${path}`, { preHandler: authenticate("governance:read") }, async (request) => ({ data: await options.service.list(kind, request.adminIdentity!.tenantScopes) }));
    app.post(`/admin/v1/${path}`, { preHandler: authenticate("governance:write"), schema: { body: Body } }, async (request, reply) => {
      const body = request.body as typeof Body.static; options.authorization.assertTenantAccess(request.adminIdentity!, body.tenantId);
      const result = await options.service.create(kind, body, actor(request)); return reply.status(201).header("etag", `\"${result.version}\"`).send(result);
    });
    app.patch(`/admin/v1/${path}/:id`, { preHandler: authenticate("governance:write"), schema: { params: Params, body: PatchBody } }, async (request, reply) => {
      const params = request.params as typeof Params.static; const body = request.body as typeof PatchBody.static;
      const current = await options.service.find(kind, params.id);
      if (!current) throw new GatewayError({ message: `Resource '${params.id}' was not found`, statusCode: 404, code: "resource_not_found" });
      options.authorization.assertTenantAccess(request.adminIdentity!, current.tenantId);
      const result = await options.service.update(kind, params.id, version(request), body, actor(request)); return reply.header("etag", `\"${result.version}\"`).send(result);
    });
  }
  app.get("/admin/v1/governance-usage", { preHandler: authenticate("governance:read"), schema: { querystring: UsageQuery } }, async (request) => {
    const query = request.query as typeof UsageQuery.static; options.authorization.assertTenantAccess(request.adminIdentity!, query.tenantId);
    return options.service.usage(query.tenantId, query.currency);
  });
};
