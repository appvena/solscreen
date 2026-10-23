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
import type { TrpcContext } from "./_core/context";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "solscreen-auth-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("APP_DEFAULT_PASSWORD", "");
  vi.stubEnv("SESSION_SECRET", "");
  resetAppAuthForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetAppAuthForTests();
  rmSync(dir, { recursive: true, force: true });
});

function fakeCtx(cookieHeader = "", ip = "9.9.9.9") {
  const cookies: Record<string, string> = {};
  const ctx = {
    user: null,
    appAuthed: cookieHeader ? isRequestAuthenticated({ headers: { cookie: cookieHeader } }) : false,
    req: { ip, headers: { cookie: cookieHeader }, secure: false } as unknown as TrpcContext["req"],
    res: {
      cookie: (name: string, value: string) => { cookies[name] = value; },
      clearCookie: (name: string) => { cookies[name] = ""; },
    } as unknown as TrpcContext["res"],
  } satisfies TrpcContext;
  return { ctx, cookies };
}

describe("app password", () => {
  it("starts with 123456 and stores only a hash", () => {
    expect(verifyPassword("123456")).toBe(true);
    expect(verifyPassword("wrong")).toBe(false);
    expect(isUsingDefaultPassword()).toBe(true);
    const stored = readFileSync(path.join(dir, "app-auth.json"), "utf8");
    expect(stored).not.toContain("123456");
  });

  it("honours APP_DEFAULT_PASSWORD on first start", () => {
    vi.stubEnv("APP_DEFAULT_PASSWORD", "rahasia-awal");
    resetAppAuthForTests();
    expect(verifyPassword("rahasia-awal")).toBe(true);
    expect(verifyPassword("123456")).toBe(false);
  });

  it("changes the password, persists it, and invalidates old sessions", () => {
    const oldToken = createSessionToken();
    expect(changePassword("salah", "passwordbaru1")).toEqual({ ok: false, reason: "wrong_current" });
    expect(changePassword("123456", "pendek")).toEqual({ ok: false, reason: "too_short" });
    expect(changePassword("123456", "passwordbaru1")).toEqual({ ok: true, persisted: true });
    expect(verifySessionToken(oldToken)).toBe(false);
    expect(isUsingDefaultPassword()).toBe(false);
    resetAppAuthForTests(); // simulate server restart
    expect(verifyPassword("passwordbaru1")).toBe(true);
    expect(verifyPassword("123456")).toBe(false);
  });

  it("rejects tampered or expired session tokens", () => {
    const token = createSessionToken();
    expect(verifySessionToken(token)).toBe(true);
    expect(verifySessionToken(token.slice(0, -2) + "xx")).toBe(false);
    expect(verifySessionToken(token, Date.now() + 31 * 24 * 60 * 60 * 1000)).toBe(false);
    expect(verifySessionToken(undefined)).toBe(false);
  });

  it("logs in through the router and sets a working session cookie", async () => {
    const anon = fakeCtx();
    expect(await appRouter.createCaller(anon.ctx).appAuth.session()).toMatchObject({ authenticated: false, usingDefaultPassword: false });
    await expect(appRouter.createCaller(anon.ctx).appAuth.login({ password: "nope" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await appRouter.createCaller(anon.ctx).appAuth.login({ password: "123456" });
    const cookie = `${AUTH_COOKIE}=${anon.cookies[AUTH_COOKIE]}`;
    const authed = fakeCtx(cookie);
    expect(await appRouter.createCaller(authed.ctx).appAuth.session()).toMatchObject({ authenticated: true, usingDefaultPassword: true });
  });

  it("blocks brute force after 10 failed attempts", async () => {
    const { ctx } = fakeCtx("", "5.5.5.5");
    const caller = appRouter.createCaller(ctx);
    for (let i = 0; i < 10; i++) await expect(caller.appAuth.login({ password: `x${i}` })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.appAuth.login({ password: "123456" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("requires a session to change the password", async () => {
    const { ctx } = fakeCtx();
    await expect(appRouter.createCaller(ctx).appAuth.changePassword({ current: "123456", next: "passwordbaru1" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
