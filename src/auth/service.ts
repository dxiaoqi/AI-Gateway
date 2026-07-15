import { createHmac } from "node:crypto";
import { GatewayError } from "../core/errors.js";
import {
  InMemoryVirtualKeyRepository,
  type VirtualKeyRepository,
} from "./repository.js";
import type {
  AuthContext,
  VirtualKeyRecord,
  VirtualKeySeed,
} from "./types.js";

export const hashVirtualKey = (rawKey: string, pepper: string): string =>
  createHmac("sha256", pepper).update(rawKey, "utf8").digest("hex");

const parseBearerToken = (authorization: string | undefined): string => {
  if (!authorization?.startsWith("Bearer ")) {
    throw new GatewayError({
      message: "Invalid or missing gateway API key",
      statusCode: 401,
      code: "authentication_error",
    });
  }
  const token = authorization.slice("Bearer ".length);
  if (token.length === 0 || token.includes(" ")) {
    throw new GatewayError({
      message: "Invalid or missing gateway API key",
      statusCode: 401,
      code: "authentication_error",
    });
  }
  return token;
};

export class AuthService {
  constructor(
    private readonly repository: VirtualKeyRepository,
    private readonly pepper: string,
  ) {}

  static fromSeeds(seeds: VirtualKeySeed[], pepper: string): AuthService {
    const keyIds = new Set<string>();
    const keyHashes = new Set<string>();
    const records: VirtualKeyRecord[] = seeds.map((seed) => {
      const keyHash = hashVirtualKey(seed.rawKey, pepper);
      if (keyIds.has(seed.keyId)) {
        throw new Error(`Duplicate virtual key id '${seed.keyId}'`);
      }
      if (keyHashes.has(keyHash)) {
        throw new Error("Duplicate virtual key material is not allowed");
      }
      keyIds.add(seed.keyId);
      keyHashes.add(keyHash);
      return {
        keyId: seed.keyId,
        keyHash,
        tenantId: seed.tenantId,
        projectId: seed.projectId,
        applicationId: seed.applicationId,
        allowedModels: Object.freeze([...seed.allowedModels]),
        enabled: true,
      };
    });
    return new AuthService(new InMemoryVirtualKeyRepository(records), pepper);
  }

  async authenticate(authorization: string | undefined): Promise<AuthContext> {
    const rawKey = parseBearerToken(authorization);
    const record = await this.repository.findByHash(
      hashVirtualKey(rawKey, this.pepper),
    );
    if (!record?.enabled) {
      throw new GatewayError({
        message: "Invalid or missing gateway API key",
        statusCode: 401,
        code: "authentication_error",
      });
    }
    return {
      keyId: record.keyId,
      tenantId: record.tenantId,
      projectId: record.projectId,
      applicationId: record.applicationId,
      allowedModels: record.allowedModels,
    };
  }

  canAccessModel(context: AuthContext, logicalModel: string): boolean {
    return (
      context.allowedModels.includes("*") ||
      context.allowedModels.includes(logicalModel)
    );
  }

  assertModelAccess(context: AuthContext, logicalModel: string): void {
    if (!this.canAccessModel(context, logicalModel)) {
      throw new GatewayError({
        message: `Access to model '${logicalModel}' is not allowed`,
        statusCode: 403,
        code: "authorization_error",
      });
    }
  }
}
