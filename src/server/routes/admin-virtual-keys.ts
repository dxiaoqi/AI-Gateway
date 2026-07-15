import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AdminAuthorizationService } from "../../admin-auth/service.js";
import type { AdminPermission } from "../../admin-auth/types.js";
import type { VirtualKeyControlPlaneService } from "../../control-plane/service.js";
import { GatewayError } from "../../core/errors.js";

const IdentityBody = Type.Object({
  keyId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  tenantId: Type.String({ minLength: 1, maxLength: 200 }),
  projectId: Type.String({ minLength: 1, maxLength: 200 }),
  applicationId: Type.String({ minLength: 1, maxLength: 200 }),
  allowedModels: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false });

const UpdateBody = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  allowedModels: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 100 })),
}, { additionalProperties: false, minProperties: 1 });

const KeyParams = Type.Object({ keyId: Type.String({ minLength: 1 }) });
const RotationParams = Type.Object({ requestId: Type.String({ format: "uuid" }) });
const NotificationParams = Type.Object({ notificationId: Type.String({ format: "uuid" }) });
const ListQuery = Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) });
const RotationListQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  status: Type.Optional(Type.Union([
    Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected"),
    Type.Literal("cancelled"), Type.Literal("expired"),
  ])),
});
const NotificationListQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  unreadOnly: Type.Optional(Type.Boolean()),
});
const DecisionBody = Type.Object({
  reason: Type.String({ minLength: 3, maxLength: 500 }),
}, { additionalProperties: false });

const expectedVersion = (request: FastifyRequest): number => {
  const value = request.headers["if-match"];
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = raw?.replace(/^W\//, "").replaceAll('"', "");
  const version = normalized && /^[1-9]\d*$/u.test(normalized)
    ? Number.parseInt(normalized, 10)
    : Number.NaN;
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new GatewayError({
      message: "A positive virtual-key version is required in the If-Match header",
      statusCode: 428,
      code: "precondition_required",
    });
  }
  return version;
};

export const registerAdminVirtualKeyRoutes = async (
  app: FastifyInstance,
  options: {
    service: VirtualKeyControlPlaneService;
    authorization: AdminAuthorizationService;
    rotationApprovalRequired: boolean;
  },
): Promise<void> => {
  const actor = (request: FastifyRequest) => ({
    actorId: request.adminIdentity!.actorId,
    subject: request.adminIdentity!.subject,
    issuer: request.adminIdentity!.issuer,
    roles: request.adminIdentity!.roles,
    tenantScopes: request.adminIdentity!.tenantScopes,
    authMethod: request.adminIdentity!.authMethod,
    requestId: request.id,
    ...(request.traceContext ? { traceId: request.traceContext.traceId } : {}),
  });
  const requirePermission = (permission: AdminPermission) => async (request: FastifyRequest) => {
    const identity = await options.authorization.authenticate(request.headers.authorization);
    request.adminIdentity = identity;
    options.authorization.assertPermission(identity, permission);
  };
  const assertKeyAccess = async (request: FastifyRequest, keyId: string) => {
    const key = await options.service.findById(keyId);
    if (!key) {
      throw new GatewayError({
        message: `Virtual key '${keyId}' was not found`,
        statusCode: 404,
        code: "resource_not_found",
      });
    }
    options.authorization.assertTenantAccess(request.adminIdentity!, key.tenantId);
    return key;
  };

  app.get("/admin/v1/me", {
    preHandler: requirePermission("virtual_keys:read"),
  }, async (request) => ({
    actorId: request.adminIdentity!.actorId,
    roles: request.adminIdentity!.roles,
    tenantScopes: request.adminIdentity!.tenantScopes,
    authMethod: request.adminIdentity!.authMethod,
  }));

  app.post("/admin/v1/virtual-keys", {
    preHandler: requirePermission("virtual_keys:create"),
    schema: { body: IdentityBody },
  }, async (request, reply) => {
    const body = request.body as typeof IdentityBody.static;
    options.authorization.assertTenantAccess(request.adminIdentity!, body.tenantId);
    const result = await options.service.create(body, actor(request));
    return reply.status(201).header("etag", `\"${result.virtualKey.version}\"`).send(result);
  });

  app.get("/admin/v1/virtual-keys", {
    preHandler: requirePermission("virtual_keys:read"),
    schema: { querystring: ListQuery },
  }, async (request) => {
    const query = request.query as typeof ListQuery.static;
    return { data: await options.service.list(query.limit ?? 100, request.adminIdentity!.tenantScopes) };
  });

  app.patch("/admin/v1/virtual-keys/:keyId", {
    preHandler: requirePermission("virtual_keys:update"),
    schema: { params: KeyParams, body: UpdateBody },
  }, async (request, reply) => {
    const params = request.params as typeof KeyParams.static;
    const body = request.body as typeof UpdateBody.static;
    await assertKeyAccess(request, params.keyId);
    const result = await options.service.update(params.keyId, expectedVersion(request), body, actor(request));
    return reply.header("etag", `\"${result.version}\"`).send(result);
  });

  app.post("/admin/v1/virtual-keys/:keyId/rotate", {
    preHandler: requirePermission("virtual_keys:rotate"),
    schema: { params: KeyParams },
  }, async (request, reply) => {
    const params = request.params as typeof KeyParams.static;
    await assertKeyAccess(request, params.keyId);
    if (options.rotationApprovalRequired) {
      throw new GatewayError({
        message: "Direct rotation is disabled; create a rotation request for a second administrator to approve",
        statusCode: 409,
        code: "approval_required",
      });
    }
    const result = await options.service.rotate(params.keyId, expectedVersion(request), actor(request));
    return reply.header("etag", `\"${result.virtualKey.version}\"`).send(result);
  });

  app.get("/admin/v1/audit-events", {
    preHandler: requirePermission("audit:read"),
    schema: { querystring: ListQuery },
  }, async (request) => {
    const query = request.query as typeof ListQuery.static;
    return { data: await options.service.listAuditEvents(query.limit ?? 100, request.adminIdentity!.tenantScopes) };
  });

  app.post("/admin/v1/virtual-keys/:keyId/rotation-requests", {
    preHandler: requirePermission("virtual_keys:rotate"),
    schema: { params: KeyParams },
  }, async (request, reply) => {
    const params = request.params as typeof KeyParams.static;
    await assertKeyAccess(request, params.keyId);
    const rotationRequest = await options.service.requestRotation(
      params.keyId,
      expectedVersion(request),
      actor(request),
    );
    return reply.status(201).send({ rotationRequest });
  });

  app.get("/admin/v1/rotation-requests", {
    preHandler: requirePermission("audit:read"),
    schema: { querystring: RotationListQuery },
  }, async (request) => {
    const query = request.query as typeof RotationListQuery.static;
    return {
      data: await options.service.listRotationRequests(
        query.limit ?? 100,
        request.adminIdentity!.tenantScopes,
        query.status,
      ),
    };
  });

  app.post("/admin/v1/rotation-requests/:requestId/approve", {
    preHandler: requirePermission("virtual_keys:rotate"),
    schema: { params: RotationParams, body: DecisionBody },
  }, async (request, reply) => {
    const params = request.params as typeof RotationParams.static;
    const body = request.body as typeof DecisionBody.static;
    const rotation = await options.service.findRotationRequestById(params.requestId);
    if (!rotation) {
      throw new GatewayError({
        message: `Rotation request '${params.requestId}' was not found`,
        statusCode: 404,
        code: "resource_not_found",
      });
    }
    options.authorization.assertTenantAccess(request.adminIdentity!, rotation.tenantId);
    const result = await options.service.approveRotation(params.requestId, body.reason, actor(request));
    return reply.header("etag", `\"${result.virtualKey.version}\"`).send(result);
  });

  const decide = (decision: "reject" | "cancel") => async (request: FastifyRequest) => {
    const params = request.params as typeof RotationParams.static;
    const body = request.body as typeof DecisionBody.static;
    const rotation = await options.service.findRotationRequestById(params.requestId);
    if (!rotation) {
      throw new GatewayError({
        message: `Rotation request '${params.requestId}' was not found`,
        statusCode: 404,
        code: "resource_not_found",
      });
    }
    options.authorization.assertTenantAccess(request.adminIdentity!, rotation.tenantId);
    return decision === "reject"
      ? options.service.rejectRotation(params.requestId, body.reason, actor(request))
      : options.service.cancelRotation(params.requestId, body.reason, actor(request));
  };

  app.post("/admin/v1/rotation-requests/:requestId/reject", {
    preHandler: requirePermission("virtual_keys:rotate"),
    schema: { params: RotationParams, body: DecisionBody },
  }, decide("reject"));

  app.post("/admin/v1/rotation-requests/:requestId/cancel", {
    preHandler: requirePermission("virtual_keys:rotate"),
    schema: { params: RotationParams, body: DecisionBody },
  }, decide("cancel"));

  app.get("/admin/v1/notifications", {
    preHandler: requirePermission("audit:read"),
    schema: { querystring: NotificationListQuery },
  }, async (request) => {
    const query = request.query as typeof NotificationListQuery.static;
    return { data: await options.service.listNotifications(query.limit ?? 100, actor(request), query.unreadOnly ?? false) };
  });

  app.post("/admin/v1/notifications/:notificationId/read", {
    preHandler: requirePermission("audit:read"),
    schema: { params: NotificationParams },
  }, async (request) => {
    const params = request.params as typeof NotificationParams.static;
    return options.service.markNotificationRead(params.notificationId, actor(request));
  });
};
