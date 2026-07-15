import { Pool } from "pg";
import { AuthService } from "../auth/service.js";
import type { GatewayConfig } from "../config.js";
import { latestSchemaVersion, runMigrations } from "./migrations.js";
import { PostgresVirtualKeyRepository, seedVirtualKeys } from "./postgres-repository.js";
import { VirtualKeyControlPlaneService } from "./service.js";
import { GovernanceService } from "../governance/service.js";
import { PostgresGovernanceRepository } from "../governance/repository.js";
import type { ProviderRegistry } from "../providers/registry.js";

export interface ControlPlaneRuntime {
  authService: AuthService;
  service: VirtualKeyControlPlaneService;
  governanceService: GovernanceService;
  readiness: () => Promise<void>;
  close: () => Promise<void>;
}

export const createControlPlaneRuntime = async (
  config: GatewayConfig,
  onPoolError: (error: Error) => void,
  registry?: ProviderRegistry,
): Promise<ControlPlaneRuntime | undefined> => {
  if (!config.databaseUrl) return undefined;
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", onPoolError);
  try {
    if (config.databaseAutoMigrate) await runMigrations(pool);
    if (config.controlPlaneSeedFromEnv) {
      await seedVirtualKeys(pool, config.virtualKeys, config.keyPepper);
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
  const repository = new PostgresVirtualKeyRepository(pool);
  const governanceRepository = new PostgresGovernanceRepository(pool);
  const governanceService = new GovernanceService(governanceRepository, undefined, registry);
  await governanceService.initialize();
  return {
    authService: new AuthService(repository, config.keyPepper),
    service: new VirtualKeyControlPlaneService(
      repository,
      config.keyPepper,
      undefined,
      config.rotationApprovalTtlMs,
    ),
    governanceService,
    readiness: async () => {
      const result = await pool.query<{ version: number }>(
        "SELECT version FROM gateway_schema_migrations WHERE version = $1",
        [latestSchemaVersion],
      );
      if (result.rowCount !== 1) throw new Error("PostgreSQL control-plane schema is not current");
    },
    close: async () => pool.end(),
  };
};
