import { config as loadDotEnv } from "dotenv";
import { loadConfig } from "./config.js";
import { buildApp } from "./server/app.js";

loadDotEnv({ quiet: true });
const config = loadConfig();
const app = await buildApp({ config });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, "failed to start gateway");
  process.exit(1);
}
