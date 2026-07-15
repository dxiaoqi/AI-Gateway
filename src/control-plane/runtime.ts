import { Pool } from "pg";
import { AuthService } from "../auth/service.js";
import type { GatewayConfig } from "../config.js";
import { latestSchemaVersion, runMigrations } from "./migrations.js";
import { PostgresVirtualKeyRepository, seedVirtualKeys } from "./postgres-repository.js";
import { VirtualKeyControlPlaneService } from "./service.js";

export interface ControlPlaneRuntime {
  authService: AuthService;
  service: VirtualKeyControlPlaneService;
  readiness: () => Promise<void>;
  close: () => Promise<void>;
}

export const createControlPlaneRuntime = async (
  config: GatewayConfig,
  onPoolError: (error: Error) => void,
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
  return {
    authService: new AuthService(repository, config.keyPepper),
    service: new VirtualKeyControlPlaneService(
      repository,
      config.keyPepper,
      undefined,
      config.rotationApprovalTtlMs,
    ),
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
