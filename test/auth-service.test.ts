import { describe, expect, it } from "vitest";
import { AuthService, hashVirtualKey } from "../src/auth/service.js";
import { GatewayError } from "../src/core/errors.js";

const seeds = [
  {
    keyId: "key-1",
    rawKey: "aigw_test_secret",
    tenantId: "tenant-1",
    projectId: "project-1",
    applicationId: "application-1",
    allowedModels: ["general"],
  },
];

describe("AuthService", () => {
  it("hashes key material with a pepper", () => {
    expect(hashVirtualKey("same-key", "pepper-a")).not.toBe(
      hashVirtualKey("same-key", "pepper-b"),
    );
    expect(hashVirtualKey("same-key", "pepper-a")).not.toContain("same-key");
  });

  it("returns tenant context without exposing raw key material", async () => {
    const service = AuthService.fromSeeds(seeds, "test-pepper");
    const context = await service.authenticate("Bearer aigw_test_secret");
    expect(context).toEqual({
      keyId: "key-1",
      tenantId: "tenant-1",
      projectId: "project-1",
      applicationId: "application-1",
      allowedModels: ["general"],
    });
    expect(JSON.stringify(context)).not.toContain("aigw_test_secret");
  });

  it("rejects an invalid virtual key", async () => {
    const service = AuthService.fromSeeds(seeds, "test-pepper");
    await expect(service.authenticate("Bearer wrong-key")).rejects.toMatchObject({
      statusCode: 401,
      code: "authentication_error",
    } satisfies Partial<GatewayError>);
  });

  it("enforces model access", async () => {
    const service = AuthService.fromSeeds(seeds, "test-pepper");
    const context = await service.authenticate("Bearer aigw_test_secret");
    expect(service.canAccessModel(context, "general")).toBe(true);
    expect(service.canAccessModel(context, "external")).toBe(false);
    expect(() => service.assertModelAccess(context, "external")).toThrow(
      "Access to model 'external' is not allowed",
    );
  });
});
