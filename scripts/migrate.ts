import { Pool } from "pg";
import { runMigrations } from "../src/control-plane/migrations.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
try {
  await runMigrations(pool);
  console.log("PostgreSQL control-plane migrations are up to date");
} finally {
  await pool.end();
}
