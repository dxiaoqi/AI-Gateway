import { createClient } from "redis";
import type { GatewayConfig } from "../config.js";
import { InMemoryQuotaStore } from "./in-memory-store.js";
import { RedisQuotaStore, type RedisEvalClient } from "./redis-store.js";
import { QuotaService } from "./service.js";

export interface QuotaRuntime {
  service: QuotaService;
  backend: "memory" | "redis";
  close: () => Promise<void>;
}

export const createQuotaRuntime = async (
  config: GatewayConfig,
  onRedisError: (error: unknown) => void,
): Promise<QuotaRuntime> => {
  if (!config.redisUrl) {
    return {
      service: new QuotaService(
        config.quotaPolicies,
        new InMemoryQuotaStore(),
        config.quotaReservationTtlMs,
      ),
      backend: "memory",
      close: async () => {},
    };
  }

  const client = createClient({ url: config.redisUrl });
  client.on("error", onRedisError);
  await client.connect();
  const evalClient: RedisEvalClient = {
    eval: async (script, options) => client.eval(script, options),
  };
  return {
    service: new QuotaService(
      config.quotaPolicies,
      new RedisQuotaStore(evalClient),
      config.quotaReservationTtlMs,
    ),
    backend: "redis",
    close: async () => {
      if (client.isOpen) await client.quit();
    },
  };
};
