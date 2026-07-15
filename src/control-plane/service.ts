import { randomBytes, randomUUID } from "node:crypto";
import { hashVirtualKey } from "../auth/service.js";
import type { AuditActor, UpdateVirtualKeyRecord, VirtualKeyControlPlaneRepository } from "./types.js";

export interface CreateVirtualKeyInput {
  keyId?: string;
  tenantId: string;
  projectId: string;
  applicationId: string;
  allowedModels: readonly string[];
}

export class VirtualKeyControlPlaneService {
  constructor(
    private readonly repository: VirtualKeyControlPlaneRepository,
    private readonly pepper: string,
    private readonly createSecret: () => string = () => `aigw_${randomBytes(32).toString("base64url")}`,
    private readonly rotationApprovalTtlMs = 900_000,
    private readonly now: () => number = Date.now,
  ) {}

  async create(input: CreateVirtualKeyInput, actor: AuditActor) {
    const rawKey = this.createSecret();
    const virtualKey = await this.repository.create({
      ...input,
      keyId: input.keyId ?? `key_${randomUUID()}`,
      keyHash: hashVirtualKey(rawKey, this.pepper),
    }, actor);
    return { virtualKey, key: rawKey };
  }

  findById(keyId: string) {
    return this.repository.findById(keyId);
  }

  list(limit: number, tenantScopes?: readonly string[]) {
    return this.repository.list(limit, tenantScopes);
  }

  update(keyId: string, expectedVersion: number, input: UpdateVirtualKeyRecord, actor: AuditActor) {
    return this.repository.update(keyId, expectedVersion, input, actor);
  }

  async rotate(keyId: string, expectedVersion: number, actor: AuditActor) {
    const rawKey = this.createSecret();
    const virtualKey = await this.repository.rotate(
      keyId,
      expectedVersion,
      hashVirtualKey(rawKey, this.pepper),
      actor,
    );
    return { virtualKey, key: rawKey };
  }

  listAuditEvents(limit: number, tenantScopes?: readonly string[]) {
    return this.repository.listAuditEvents(limit, tenantScopes);
  }

  requestRotation(keyId: string, expectedKeyVersion: number, actor: AuditActor) {
    return this.repository.createRotationRequest(
      randomUUID(),
      keyId,
      expectedKeyVersion,
      new Date(this.now() + this.rotationApprovalTtlMs),
      actor,
    );
  }

  findRotationRequestById(requestId: string) {
    return this.repository.findRotationRequestById(requestId);
  }

  listRotationRequests(limit: number, tenantScopes?: readonly string[]) {
    return this.repository.listRotationRequests(limit, tenantScopes);
  }

  async approveRotation(requestId: string, actor: AuditActor) {
    const rawKey = this.createSecret();
    const result = await this.repository.approveRotationRequest(
      requestId,
      hashVirtualKey(rawKey, this.pepper),
      actor,
    );
    return { ...result, key: rawKey };
  }
}
