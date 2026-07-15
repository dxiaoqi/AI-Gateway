import type { Pool, PoolClient } from "pg";

interface Migration {
  version: number;
  name: string;
  statements: string[];
}

const migrations: Migration[] = [{
  version: 1,
  name: "virtual_keys_and_audit",
  statements: [
    `CREATE TABLE IF NOT EXISTS gateway_schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS virtual_keys (
      key_id text PRIMARY KEY,
      key_hash char(64) UNIQUE NOT NULL,
      tenant_id text NOT NULL,
      project_id text NOT NULL,
      application_id text NOT NULL,
      allowed_models text[] NOT NULL CHECK (cardinality(allowed_models) > 0),
      enabled boolean NOT NULL DEFAULT true,
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_rotated_at timestamptz
    )`,
    "CREATE INDEX IF NOT EXISTS virtual_keys_enabled_hash_idx ON virtual_keys (key_hash) WHERE enabled",
    `CREATE TABLE IF NOT EXISTS audit_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      actor_id text NOT NULL,
      action text NOT NULL,
      resource_type text NOT NULL,
      resource_id text NOT NULL,
      before_state jsonb,
      after_state jsonb,
      request_id text,
      trace_id text
    )`,
    "CREATE INDEX IF NOT EXISTS audit_events_resource_idx ON audit_events (resource_type, resource_id, occurred_at DESC)",
  ],
}, {
  version: 2,
  name: "audit_actor_identity",
  statements: [
    "ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS actor_subject text",
    "ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS actor_issuer text",
    "ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS actor_roles text[]",
    "ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS auth_method text",
  ],
}, {
  version: 3,
  name: "tenant_scopes_and_rotation_approvals",
  statements: [
    "ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS tenant_id text",
    "ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS actor_tenant_scopes text[]",
    "UPDATE audit_events SET tenant_id = COALESCE(after_state ->> 'tenantId', before_state ->> 'tenantId') WHERE tenant_id IS NULL",
    "CREATE INDEX IF NOT EXISTS audit_events_tenant_idx ON audit_events (tenant_id, occurred_at DESC)",
    `CREATE TABLE IF NOT EXISTS virtual_key_rotation_requests (
      request_id uuid PRIMARY KEY,
      key_id text NOT NULL REFERENCES virtual_keys(key_id),
      tenant_id text NOT NULL,
      expected_key_version integer NOT NULL CHECK (expected_key_version > 0),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'expired')),
      requested_by_actor_id text NOT NULL,
      requested_by_subject text NOT NULL,
      requested_by_issuer text NOT NULL,
      requested_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      approved_by_actor_id text,
      approved_by_subject text,
      approved_at timestamptz,
      CHECK (expires_at > requested_at)
    )`,
    "CREATE UNIQUE INDEX IF NOT EXISTS rotation_requests_one_pending_per_key_idx ON virtual_key_rotation_requests (key_id) WHERE status = 'pending'",
    "CREATE INDEX IF NOT EXISTS rotation_requests_tenant_status_idx ON virtual_key_rotation_requests (tenant_id, status, requested_at DESC)",
  ],
}, {
  version: 4,
  name: "rotation_decisions_and_admin_notifications",
  statements: [
    "ALTER TABLE virtual_key_rotation_requests DROP CONSTRAINT IF EXISTS virtual_key_rotation_requests_status_check",
    "ALTER TABLE virtual_key_rotation_requests ADD CONSTRAINT virtual_key_rotation_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired'))",
    "ALTER TABLE virtual_key_rotation_requests ADD COLUMN IF NOT EXISTS decided_by_actor_id text",
    "ALTER TABLE virtual_key_rotation_requests ADD COLUMN IF NOT EXISTS decided_by_subject text",
    "ALTER TABLE virtual_key_rotation_requests ADD COLUMN IF NOT EXISTS decision_reason text",
    "ALTER TABLE virtual_key_rotation_requests ADD COLUMN IF NOT EXISTS decided_at timestamptz",
    `UPDATE virtual_key_rotation_requests SET
       decided_by_actor_id = approved_by_actor_id,
       decided_by_subject = approved_by_subject,
       decided_at = approved_at,
       decision_reason = COALESCE(decision_reason, 'Approved before decision reasons became mandatory')
     WHERE status = 'approved' AND decided_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS admin_notifications (
      notification_id uuid PRIMARY KEY,
      tenant_id text NOT NULL,
      type text NOT NULL CHECK (type IN ('rotation_requested', 'rotation_approved', 'rotation_rejected', 'rotation_cancelled')),
      resource_id text NOT NULL,
      title text NOT NULL,
      message text NOT NULL,
      created_by_actor_id text NOT NULL,
      target_actor_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    "CREATE INDEX IF NOT EXISTS admin_notifications_tenant_created_idx ON admin_notifications (tenant_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS admin_notifications_target_created_idx ON admin_notifications (target_actor_id, created_at DESC) WHERE target_actor_id IS NOT NULL",
    `CREATE TABLE IF NOT EXISTS admin_notification_reads (
      notification_id uuid NOT NULL REFERENCES admin_notifications(notification_id) ON DELETE CASCADE,
      actor_id text NOT NULL,
      read_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (notification_id, actor_id)
    )`,
  ],
}];

export const latestSchemaVersion = migrations.at(-1)!.version;

const applyMigration = async (client: PoolClient, migration: Migration) => {
  await client.query("BEGIN");
  try {
    for (const statement of migration.statements) await client.query(statement);
    await client.query(
      "INSERT INTO gateway_schema_migrations(version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
      [migration.version, migration.name],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
};

export const runMigrations = async (pool: Pool): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [8_140_801]);
    await client.query(`CREATE TABLE IF NOT EXISTS gateway_schema_migrations (
      version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const result = await client.query<{ version: number }>("SELECT version FROM gateway_schema_migrations");
    const applied = new Set(result.rows.map((row) => row.version));
    for (const migration of migrations) {
      if (!applied.has(migration.version)) await applyMigration(client, migration);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [8_140_801]).catch(() => undefined);
    client.release();
  }
};
