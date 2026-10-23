import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Redis } from "@upstash/redis";

// ---------------------------------------------------------------------------
// Where the app password hash lives.
// - Upstash Redis (Vercel → Storage → Upstash) when its env vars are present.
//   Required on Vercel, whose filesystem is not persistent.
// - A JSON file in DATA_DIR otherwise (Docker volume, local dev).
// ---------------------------------------------------------------------------

export type StoredAuth = {
  salt: string;
  hash: string;
  version: number;
  secret: string;
  isDefault: boolean;
  updatedAt: string;
};

export interface AuthStore {
  readonly kind: "redis" | "file";
  read(): Promise<StoredAuth | null>;
  write(value: StoredAuth): Promise<boolean>;
  /** Count a failed login for `key`; returns failures inside the window. */
  addFailure(key: string, windowMs: number): Promise<number>;
  failures(key: string, windowMs: number): Promise<number>;
  clearFailures(key: string): Promise<void>;
}

const AUTH_KEY = "solscreen:app-auth";
const failKey = (key: string) => `solscreen:login-fail:${key}`;

function redisEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  return url && token ? { url, token } : null;
}

class RedisAuthStore implements AuthStore {
  readonly kind = "redis" as const;
  constructor(private redis: Redis) {}
  async read() {
    return (await this.redis.get<StoredAuth>(AUTH_KEY)) ?? null;
  }
  async write(value: StoredAuth) {
    await this.redis.set(AUTH_KEY, value);
    return true;
  }
  async addFailure(key: string, windowMs: number) {
    const k = failKey(key);
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.pexpire(k, windowMs);
    return count;
  }
  async failures(key: string) {
    return Number((await this.redis.get<number>(failKey(key))) ?? 0);
  }
  async clearFailures(key: string) {
    await this.redis.del(failKey(key));
  }
}

class FileAuthStore implements AuthStore {
  readonly kind = "file" as const;
  private warned = false;
  private fails = new Map<string, number[]>();
  private dir() { return process.env.DATA_DIR || path.resolve(process.cwd(), "data"); }
  private file() { return path.join(this.dir(), "app-auth.json"); }

  async read() {
    try {
      return JSON.parse(readFileSync(this.file(), "utf8")) as StoredAuth;
    } catch {
      return null;
    }
  }
  async write(value: StoredAuth) {
    try {
      mkdirSync(this.dir(), { recursive: true });
      const tmp = `${this.file()}.tmp`;
      writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file());
      return true;
    } catch (error) {
      if (!this.warned) {
        console.warn(`[AppAuth] Tidak bisa menyimpan ${this.file()} — password hanya tersimpan di memori sampai server restart.`, error);
        this.warned = true;
      }
      return false;
    }
  }
  private recent(key: string, windowMs: number, now = Date.now()) {
    const list = (this.fails.get(key) ?? []).filter(t => now - t < windowMs);
    this.fails.set(key, list);
    return list;
  }
  async addFailure(key: string, windowMs: number) {
    const list = this.recent(key, windowMs);
    list.push(Date.now());
    return list.length;
  }
  async failures(key: string, windowMs: number) {
    return this.recent(key, windowMs).length;
  }
  async clearFailures(key: string) {
    this.fails.delete(key);
  }
}

let store: AuthStore | null = null;

export function getAuthStore(): AuthStore {
  if (store) return store;
  const env = redisEnv();
  store = env ? new RedisAuthStore(new Redis({ url: env.url, token: env.token })) : new FileAuthStore();
  if (!env && process.env.VERCEL) {
    console.warn("[AppAuth] Upstash Redis belum dihubungkan. Password yang diganti akan hilang saat fungsi Vercel restart.");
  }
  return store;
}

/** Tests: swap in a custom store (or null to re-detect from env). */
export function setAuthStoreForTests(next: AuthStore | null) {
  store = next;
}
