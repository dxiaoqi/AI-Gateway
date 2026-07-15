import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

export const SESSION_COOKIE = "aigw_admin_session";
export const OIDC_TRANSACTION_COOKIE = "aigw_oidc_transaction";

export type AdminSession = {
  accessToken: string;
  csrfToken: string;
  expiresAt: number;
};

export type OidcTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
};

type StoredValue = AdminSession | OidcTransaction;
type MemoryStore = Map<string, { value: StoredValue; expiresAt: number }>;

const globalStore = globalThis as typeof globalThis & {
  __aigwAdminMemoryStore?: MemoryStore;
  __aigwAdminRedis?: RedisClientType;
  __aigwAdminRedisPromise?: Promise<RedisClientType>;
};

const memoryStore = globalStore.__aigwAdminMemoryStore ??= new Map();

function sessionSecret() {
  const value = process.env.ADMIN_CONSOLE_SESSION_SECRET;
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error("ADMIN_CONSOLE_SESSION_SECRET is required in production");
  }
  if (value && value.length < 32) throw new Error("ADMIN_CONSOLE_SESSION_SECRET must contain at least 32 characters");
  return value ?? "local-development-only-change-before-production";
}

function key(prefix: "session" | "transaction", id: string) {
  return `aigw:admin:${prefix}:${createHash("sha256").update(id).digest("hex")}`;
}

async function redisClient(): Promise<RedisClientType | null> {
  const url = process.env.ADMIN_CONSOLE_REDIS_URL;
  if (!url && process.env.NODE_ENV === "production") {
    throw new Error("ADMIN_CONSOLE_REDIS_URL is required in production");
  }
  if (!url) return null;
  if (globalStore.__aigwAdminRedis?.isOpen) return globalStore.__aigwAdminRedis;
  if (!globalStore.__aigwAdminRedisPromise) {
    const client = createClient({ url });
    globalStore.__aigwAdminRedisPromise = client.connect().then(() => {
      globalStore.__aigwAdminRedis = client;
      return client;
    }).catch((error) => {
      globalStore.__aigwAdminRedisPromise = undefined;
      throw error;
    });
  }
  return globalStore.__aigwAdminRedisPromise;
}

async function put(storeKey: string, value: StoredValue, ttlSeconds: number) {
  const redis = await redisClient();
  if (redis) {
    await redis.set(storeKey, JSON.stringify(value), { EX: ttlSeconds });
    return;
  }
  memoryStore.set(storeKey, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

async function get<T extends StoredValue>(storeKey: string): Promise<T | null> {
  const redis = await redisClient();
  if (redis) {
    const value = await redis.get(storeKey);
    return value ? JSON.parse(value) as T : null;
  }
  const stored = memoryStore.get(storeKey);
  if (!stored || stored.expiresAt <= Date.now()) {
    memoryStore.delete(storeKey);
    return null;
  }
  return stored.value as T;
}

async function remove(storeKey: string) {
  const redis = await redisClient();
  if (redis) await redis.del(storeKey);
  else memoryStore.delete(storeKey);
}

function signature(id: string) {
  return createHmac("sha256", sessionSecret()).update(id).digest("base64url");
}

export function issueSignedId() {
  const id = randomBytes(32).toString("base64url");
  return `${id}.${signature(id)}`;
}

export function verifySignedId(value: string | undefined): string | null {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  const id = value.slice(0, separator);
  const received = Buffer.from(value.slice(separator + 1));
  const expected = Buffer.from(signature(id));
  return received.length === expected.length && timingSafeEqual(received, expected) ? id : null;
}

export function randomUrlSafe(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function configuredSessionTtlSeconds() {
  const parsed = Number(process.env.ADMIN_CONSOLE_SESSION_TTL_SECONDS ?? 900);
  return Number.isInteger(parsed) && parsed >= 60 && parsed <= 43_200 ? parsed : 900;
}

export async function createSession(accessToken: string, upstreamTtlSeconds?: number) {
  const configuredTtl = configuredSessionTtlSeconds();
  const ttl = upstreamTtlSeconds && Number.isFinite(upstreamTtlSeconds)
    ? Math.max(1, Math.min(configuredTtl, Math.floor(upstreamTtlSeconds)))
    : configuredTtl;
  const signedId = issueSignedId();
  const id = verifySignedId(signedId)!;
  const session: AdminSession = {
    accessToken,
    csrfToken: randomUrlSafe(),
    expiresAt: Date.now() + ttl * 1000,
  };
  await put(key("session", id), session, ttl);
  return { signedId, session, ttl };
}

export async function readSession(signedId: string | undefined) {
  const id = verifySignedId(signedId);
  if (!id) return null;
  const session = await get<AdminSession>(key("session", id));
  if (!session || session.expiresAt <= Date.now()) {
    await remove(key("session", id));
    return null;
  }
  return session;
}

export async function deleteSession(signedId: string | undefined) {
  const id = verifySignedId(signedId);
  if (id) await remove(key("session", id));
}

export async function createOidcTransaction(transaction: Omit<OidcTransaction, "expiresAt">) {
  const ttl = 300;
  const signedId = issueSignedId();
  const id = verifySignedId(signedId)!;
  await put(key("transaction", id), { ...transaction, expiresAt: Date.now() + ttl * 1000 }, ttl);
  return { signedId, ttl };
}

export async function consumeOidcTransaction(signedId: string | undefined) {
  const id = verifySignedId(signedId);
  if (!id) return null;
  const storeKey = key("transaction", id);
  const redis = await redisClient();
  const serialized = redis ? await redis.getDel(storeKey) : null;
  const transaction = serialized ? JSON.parse(serialized) as OidcTransaction : await get<OidcTransaction>(storeKey);
  if (!redis) await remove(storeKey);
  return transaction?.expiresAt && transaction.expiresAt > Date.now() ? transaction : null;
}

export const sessionCookieOptions = (maxAge?: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  ...(maxAge === undefined ? {} : { maxAge }),
});
