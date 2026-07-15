import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { jwtVerify, SignJWT } from "jose";
import type { AdminLocalConfig } from "../config.js";
import { GatewayError } from "../core/errors.js";
import type { AdminAuthenticator, AdminIdentity } from "./types.js";

const scrypt = promisify(scryptCallback);
interface LocalOwnerRecord {
  schemaVersion: 1;
  accountId: string;
  organizationId: string;
  organizationName: string;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
}

const authError = () => new GatewayError({ message: "用户名或密码错误", statusCode: 401, code: "authentication_error" });
const safeTextEqual = (left: string | undefined, right: string | undefined) => {
  if (!left || !right) return false; const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const validateUsername = (username: string) => /^[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$/u.test(username);
const validatePassword = (password: string) => password.length >= 12 && password.length <= 128 && /[A-Za-z]/u.test(password) && /\d/u.test(password);

export class LocalAdminAccountService {
  private failures = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly config: AdminLocalConfig, private readonly now: () => number = Date.now) {}

  async status() { return { enabled: true, bootstrapAvailable: !(await this.readOwner()), mode: "local" as const }; }

  async bootstrap(input: { organizationName: string; username: string; password: string }, bootstrapToken?: string) {
    const organizationName = input.organizationName.trim(); const username = input.username.trim().toLowerCase();
    if (organizationName.length < 2 || organizationName.length > 100) throw new GatewayError({ message: "组织名称需要 2–100 个字符", statusCode: 400, code: "invalid_request_error" });
    if (!validateUsername(username)) throw new GatewayError({ message: "用户名需要 3–100 个字符，只能包含字母、数字和 ._@-", statusCode: 400, code: "invalid_request_error" });
    if (!validatePassword(input.password)) throw new GatewayError({ message: "密码需要 12–128 个字符，并同时包含字母和数字", statusCode: 400, code: "invalid_request_error" });
    if (this.config.production && !safeTextEqual(bootstrapToken, this.config.bootstrapToken)) throw authError();
    const salt = randomBytes(16); const hash = await scrypt(input.password, salt, 64) as Buffer;
    const owner: LocalOwnerRecord = { schemaVersion: 1, accountId: randomUUID(), organizationId: `org_${randomUUID()}`, organizationName, username, passwordSalt: salt.toString("base64url"), passwordHash: hash.toString("base64url"), createdAt: new Date(this.now()).toISOString() };
    await mkdir(dirname(this.config.accountFile), { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(this.config.accountFile, "wx", 0o600);
      await handle.writeFile(JSON.stringify(owner, null, 2), { encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new GatewayError({ message: "主组织账号已经存在，请直接登录", statusCode: 409, code: "resource_conflict" });
      throw error;
    } finally { await handle?.close(); }
    return { owner: this.publicOwner(owner), accessToken: await this.issue(owner) };
  }

  async login(input: { username: string; password: string }, rateKey: string) {
    const state = this.failures.get(rateKey); const now = this.now();
    if (state && state.resetAt > now && state.count >= 5) throw new GatewayError({ message: "登录尝试过多，请 15 分钟后重试", statusCode: 429, code: "quota_requests_exceeded" });
    const owner = await this.readOwner();
    const supplied = owner ? await scrypt(input.password, Buffer.from(owner.passwordSalt, "base64url"), 64) as Buffer : randomBytes(64);
    const expected = owner ? Buffer.from(owner.passwordHash, "base64url") : randomBytes(64);
    const valid = Boolean(owner && owner.username === input.username.trim().toLowerCase() && supplied.length === expected.length && timingSafeEqual(supplied, expected));
    if (!valid) { this.failures.set(rateKey, { count: (state?.resetAt && state.resetAt > now ? state.count : 0) + 1, resetAt: now + 900_000 }); throw authError(); }
    this.failures.delete(rateKey); return { owner: this.publicOwner(owner!), accessToken: await this.issue(owner!) };
  }

  private async readOwner(): Promise<LocalOwnerRecord | undefined> {
    try { return JSON.parse(await readFile(this.config.accountFile, "utf8")) as LocalOwnerRecord; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  private publicOwner(owner: LocalOwnerRecord) { return { accountId: owner.accountId, organizationId: owner.organizationId, organizationName: owner.organizationName, username: owner.username, role: "owner" }; }
  private issue(owner: LocalOwnerRecord) {
    return new SignJWT({ roles: ["admin"], tenantScopes: ["*"], organizationId: owner.organizationId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer(this.config.issuer).setAudience(this.config.audience)
      .setSubject(owner.accountId).setIssuedAt().setExpirationTime(Math.floor(this.now() / 1000) + this.config.accessTokenTtlSeconds)
      .sign(new TextEncoder().encode(this.config.tokenSecret));
  }
}

export class LocalAdminAuthenticator implements AdminAuthenticator {
  constructor(private readonly config: AdminLocalConfig) {}
  async authenticate(authorization: string | undefined): Promise<AdminIdentity> {
    if (!authorization?.startsWith("Bearer ")) throw authError();
    try {
      const result = await jwtVerify(authorization.slice(7), new TextEncoder().encode(this.config.tokenSecret), { algorithms: ["HS256"], issuer: this.config.issuer, audience: this.config.audience, typ: "JWT", requiredClaims: ["sub", "exp"] });
      const subject = result.payload.sub!;
      return { actorId: `local:${subject}`, subject, issuer: this.config.issuer, roles: ["admin"], tenantScopes: ["*"], authMethod: "local" };
    } catch { throw authError(); }
  }
}
