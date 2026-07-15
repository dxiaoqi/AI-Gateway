import { GatewayError } from "../core/errors.js";

export const notFound = (keyId: string): GatewayError =>
  new GatewayError({
    message: `Virtual key '${keyId}' was not found`,
    statusCode: 404,
    code: "resource_not_found",
  });

export const versionConflict = (): GatewayError =>
  new GatewayError({
    message: "The virtual key changed after you last read it; reload and retry",
    statusCode: 409,
    code: "version_conflict",
  });

export const resourceConflict = (): GatewayError =>
  new GatewayError({
    message: "A virtual key with the same id or secret already exists",
    statusCode: 409,
    code: "resource_conflict",
  });

export const approvalConflict = (message: string): GatewayError =>
  new GatewayError({
    message,
    statusCode: 409,
    code: "approval_conflict",
  });
