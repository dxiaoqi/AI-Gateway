export interface VirtualKeySeed {
  keyId: string;
  rawKey: string;
  tenantId: string;
  projectId: string;
  applicationId: string;
  allowedModels: string[];
}

export interface AuthContext {
  keyId: string;
  tenantId: string;
  projectId: string;
  applicationId: string;
  allowedModels: readonly string[];
}

export interface VirtualKeyRecord extends AuthContext {
  keyHash: string;
  enabled: boolean;
}
