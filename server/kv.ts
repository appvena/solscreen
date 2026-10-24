import { Redis } from "@upstash/redis";
import { redisEnv } from "./authStore";

// Small key-value cache: Upstash Redis when connected (shared, survives cold
// starts), otherwise process memory (per serverless instance).

export interface Kv {
  readonly persistent: boolean;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  incrByFloat(key: string, by: number): Promise<number>;
}

class MemoryKv implements Kv {
  readonly persistent = false;
  private data = new Map<string, { value: unknown; expires: number | null }>();
  async get<T>(key: string) {
    const hit = this.data.get(key);
    if (!hit) return null;
    if (hit.expires && hit.expires < Date.now()) { this.data.delete(key); return null; }
    return hit.value as T;
  }
  async set<T>(key: string, value: T, ttlSeconds?: number) {
    this.data.set(key, { value, expires: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
  }
  async incrByFloat(key: string, by: number) {
    const next = Number((await this.get<number>(key)) ?? 0) + by;
    await this.set(key, next);
    return next;
  }
}

class RedisKv implements Kv {
  readonly persistent = true;
  constructor(private redis: Redis) {}
  async get<T>(key: string) {
    return (await this.redis.get<T>(key)) ?? null;
  }
  async set<T>(key: string, value: T, ttlSeconds?: number) {
    if (ttlSeconds) await this.redis.set(key, value, { ex: ttlSeconds });
    else await this.redis.set(key, value);
  }
  async incrByFloat(key: string, by: number) {
    return Number(await this.redis.incrbyfloat(key, by));
  }
}

let kv: Kv | null = null;

export function getKv(): Kv {
  if (kv) return kv;
  const env = redisEnv();
  kv = env ? new RedisKv(new Redis({ url: env.url, token: env.token })) : new MemoryKv();
  return kv;
}

export function setKvForTests(next: Kv | null) {
  kv = next;
}

export function createMemoryKv(): Kv {
  return new MemoryKv();
}
