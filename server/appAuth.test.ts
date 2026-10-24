import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_COOKIE,
  changePassword,
  createSessionToken,
  isRequestAuthenticated,
  isUsingDefaultPassword,
  resetAppAuthForTests,
  verifyPassword,
  verifySessionToken,
} from "./appAuth";
import { appRouter } from "./routers";
import { getAuthStore, redisEnv, setAuthStoreForTests, type AuthStore, type StoredAuth } from "./authStore";
import type { TrpcContext } from "./_core/context";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "solscreen-auth-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("APP_DEFAULT_PASSWORD", "");
  vi.stubEnv("SESSION_SECRET", "");
  vi.stubEnv("KV_REST_API_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  setAuthStoreForTests(null);
  resetAppAuthForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetAppAuthForTests();
  rmSync(dir, { recursive: true, force: true });
});

async function fakeCtx(cookieHeader = "", ip = "9.9.9.9") {
  const cookies: Record<string, string> = {};
  const ctx = {
    user: null,
    appAuthed: cookieHeader ? await isRequestAuthenticated({ headers: { cookie: cookieHeader } }) : false,
    req: { ip, headers: { cookie: cookieHeader }, secure: false } as unknown as TrpcContext["req"],
    res: {
      cookie: (name: string, value: string) => { cookies[name] = value; },
      clearCookie: (name: string) => { cookies[name] = ""; },
    } as unknown as TrpcContext["res"],
  } satisfies TrpcContext;
  return { ctx, cookies };
}

describe("app password", () => {
  it("starts with 123456 and stores only a hash", async () => {
    expect(getAuthStore().kind).toBe("file");
    expect(await verifyPassword("123456")).toBe(true);
    expect(await verifyPassword("wrong")).toBe(false);
    expect(await isUsingDefaultPassword()).toBe(true);
    const stored = readFileSync(path.join(dir, "app-auth.json"), "utf8");
    expect(stored).not.toContain("123456");
  });

  it("honours APP_DEFAULT_PASSWORD on first start", async () => {
    vi.stubEnv("APP_DEFAULT_PASSWORD", "rahasia-awal");
    resetAppAuthForTests();
    expect(await verifyPassword("rahasia-awal")).toBe(true);
    expect(await verifyPassword("123456")).toBe(false);
  });

  it("changes the password, persists it, and invalidates old sessions", async () => {
    const oldToken = await createSessionToken();
    expect(await changePassword("salah", "passwordbaru1")).toEqual({ ok: false, reason: "wrong_current" });
    expect(await changePassword("123456", "pendek")).toEqual({ ok: false, reason: "too_short" });
    expect(await changePassword("123456", "passwordbaru1")).toEqual({ ok: true, persisted: true });
    expect(await verifySessionToken(oldToken)).toBe(false);
    expect(await isUsingDefaultPassword()).toBe(false);
    resetAppAuthForTests(); // simulate server restart
    expect(await verifyPassword("passwordbaru1")).toBe(true);
    expect(await verifyPassword("123456")).toBe(false);
  });

  it("rejects tampered or expired session tokens", async () => {
    const token = await createSessionToken();
    expect(await verifySessionToken(token)).toBe(true);
    expect(await verifySessionToken(token.slice(0, -2) + "xx")).toBe(false);
    expect(await verifySessionToken(token, Date.now() + 31 * 24 * 60 * 60 * 1000)).toBe(false);
    expect(await verifySessionToken(undefined)).toBe(false);
  });

  it("logs in through the router and sets a working session cookie", async () => {
    const anon = await fakeCtx();
    expect(await appRouter.createCaller(anon.ctx).appAuth.session()).toMatchObject({ authenticated: false, usingDefaultPassword: false });
    await expect(appRouter.createCaller(anon.ctx).appAuth.login({ password: "nope" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await appRouter.createCaller(anon.ctx).appAuth.login({ password: "123456" });
    const cookie = `${AUTH_COOKIE}=${anon.cookies[AUTH_COOKIE]}`;
    const authed = await fakeCtx(cookie);
    expect(await appRouter.createCaller(authed.ctx).appAuth.session()).toMatchObject({ authenticated: true, usingDefaultPassword: true });
  });

  it("blocks brute force after 10 failed attempts", async () => {
    const { ctx } = await fakeCtx("", "5.5.5.5");
    const caller = appRouter.createCaller(ctx);
    for (let i = 0; i < 10; i++) await expect(caller.appAuth.login({ password: `x${i}` })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.appAuth.login({ password: "123456" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("requires a session to change the password", async () => {
    const { ctx } = await fakeCtx();
    await expect(appRouter.createCaller(ctx).appAuth.changePassword({ current: "123456", next: "passwordbaru1" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("shares the password across instances through an external store (Redis on Vercel)", async () => {
    let saved: StoredAuth | null = null;
    const shared: AuthStore = {
      kind: "redis",
      read: async () => saved,
      write: async v => { saved = v; return true; },
      addFailure: async () => 1, failures: async () => 0, clearFailures: async () => undefined,
    };
    setAuthStoreForTests(shared);
    resetAppAuthForTests();
    expect(await changePassword("123456", "dariInstanceA")).toEqual({ ok: true, persisted: true });
    resetAppAuthForTests(); // a different serverless instance
    expect(await verifyPassword("dariInstanceA")).toBe(true);
    const session = await appRouter.createCaller((await fakeCtx()).ctx).appAuth.session();
    expect(session.passwordPersistent).toBe(true);
  });

  it("uses Upstash Redis when Vercel's KV env vars are set", () => {
    vi.stubEnv("KV_REST_API_URL", "https://example.upstash.io");
    vi.stubEnv("KV_REST_API_TOKEN", "token");
    setAuthStoreForTests(null);
    expect(getAuthStore().kind).toBe("redis");
  });

  it("warns in the session payload when running on Vercel without Redis", async () => {
    vi.stubEnv("VERCEL", "1");
    const session = await appRouter.createCaller((await fakeCtx()).ctx).appAuth.session();
    expect(session.passwordPersistent).toBe(false);
  });

  it("never resets to the default password when the store is temporarily unreadable", async () => {
    let saved: StoredAuth | null = null;
    let failReads = false;
    const flaky: AuthStore = {
      kind: "redis",
      read: async () => { if (failReads) throw new Error("network down"); return saved; },
      write: async v => { saved = v; return true; },
      addFailure: async () => 1, failures: async () => 0, clearFailures: async () => undefined,
    };
    setAuthStoreForTests(flaky);
    resetAppAuthForTests();
    await changePassword("123456", "passwordbaru1");
    const before = saved;
    resetAppAuthForTests(); // new cold instance, store down
    failReads = true;
    await expect(verifyPassword("123456")).rejects.toThrow();
    expect(saved).toBe(before); // nothing overwritten
    failReads = false;
    expect(await verifyPassword("passwordbaru1")).toBe(true);
  });

  it("finds Upstash credentials under a custom Vercel prefix", () => {
    expect(redisEnv({ STORAGE_KV_REST_API_URL: "https://a.upstash.io", STORAGE_KV_REST_API_TOKEN: "t" })).toEqual({ url: "https://a.upstash.io", token: "t" });
    expect(redisEnv({ UPSTASH_REDIS_REST_URL: "https://b.upstash.io", UPSTASH_REDIS_REST_TOKEN: "u" })).toEqual({ url: "https://b.upstash.io", token: "u" });
    expect(redisEnv({ KV_REST_API_URL: "https://c.upstash.io" })).toBeNull();
  });
});
