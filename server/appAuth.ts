import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { parse as parseCookie } from "cookie";
import type { CookieOptions, Request, Response } from "express";
import { getAuthStore, redisEnv, type StoredAuth } from "./authStore";

// ---------------------------------------------------------------------------
// Single shared app password. Two modes:
// - "env": the password comes from APP_PASSWORD (default "123456"). Used when
//   APP_PASSWORD is set, or on Vercel without Redis. Stateless: every serverless
//   instance derives the same state, so nobody gets logged out at random.
//   To change it, edit APP_PASSWORD in the hosting dashboard and redeploy.
// - "app": first start uses APP_DEFAULT_PASSWORD or "123456"; changed from
//   inside the app and stored as a scrypt hash (Redis or file, see authStore).
// - Sessions are HMAC-signed cookies; changing the password logs out every
//   other session (the session carries the password "version").
// ---------------------------------------------------------------------------

export const AUTH_COOKIE = "solscreen_auth";
export const DEFAULT_PASSWORD_FALLBACK = "123456";
export const MIN_PASSWORD_LENGTH = 8;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a server instance trusts its cached copy before re-reading the store. */
const CACHE_MS = 5_000;

let cached: { value: StoredAuth; at: number; persisted: boolean } | null = null;
let initPromise: Promise<StoredAuth> | null = null;

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function freshState(password: string, isDefault: boolean, previous?: StoredAuth): StoredAuth {
  const salt = randomBytes(16).toString("hex");
  return {
    salt,
    hash: hashPassword(password, salt),
    version: (previous?.version ?? 0) + 1,
    secret: previous?.secret || randomBytes(32).toString("hex"),
    isDefault,
    updatedAt: new Date().toISOString(),
  };
}

const withEnvSecret = (value: StoredAuth): StoredAuth => ({ ...value, secret: process.env.SESSION_SECRET || value.secret });

export type PasswordMode = "env" | "app";

export function passwordMode(env: NodeJS.ProcessEnv = process.env): PasswordMode {
  // With Redis the password lives there and can be changed in the app;
  // APP_PASSWORD then only seeds the first password.
  if (redisEnv(env)) return "app";
  if (env.APP_PASSWORD) return "env";
  if (env.VERCEL) return "env"; // no persistent storage on Vercel without Redis
  return "app";
}

/** Deterministic state for "env" mode — identical on every instance, no storage needed. */
function envState(): StoredAuth {
  const password = process.env.APP_PASSWORD || DEFAULT_PASSWORD_FALLBACK;
  const salt = createHash("sha256").update("solscreen-env-salt").digest("hex").slice(0, 32);
  // The password is part of the signing secret, so sessions can't be forged without it,
  // and changing APP_PASSWORD logs everyone out.
  const key = process.env.SESSION_SECRET || process.env.ANTHROPIC_API_KEY || "solscreen";
  return {
    salt,
    hash: hashPassword(password, salt),
    version: 1,
    secret: createHmac("sha256", key).update(`session:${password}`).digest("hex"),
    isDefault: !process.env.APP_PASSWORD,
    updatedAt: "env",
  };
}

async function load(): Promise<StoredAuth> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (passwordMode() === "env") {
      cached = { value: envState(), at: Date.now(), persisted: true };
      return cached.value;
    }
    const store = getAuthStore();
    let value: StoredAuth | null;
    try {
      value = await store.read();
    } catch (error) {
      // Never fall back to the default password on a read error: that could
      // overwrite a changed password. Reuse the last known state, or fail closed.
      console.error("[AppAuth] Gagal membaca penyimpanan password", error);
      if (cached) return cached.value;
      throw new Error("Penyimpanan password tidak dapat diakses.");
    }
    let persisted = true;
    if (!value || !value.salt || !value.hash || !value.secret) {
      const seed = process.env.APP_PASSWORD || process.env.APP_DEFAULT_PASSWORD;
      value = freshState(seed || DEFAULT_PASSWORD_FALLBACK, !seed);
      persisted = await store.write(value).catch(() => false);
    }
    cached = { value: withEnvSecret(value), at: Date.now(), persisted };
    return cached.value;
  })();
  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

/** Test helper: forget cached state so the next call re-reads the store. */
export function resetAppAuthForTests() {
  cached = null;
  initPromise = null;
}

export async function verifyPassword(password: string): Promise<boolean> {
  const current = await load();
  const candidate = Buffer.from(hashPassword(password, current.salt), "hex");
  const expected = Buffer.from(current.hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export async function isUsingDefaultPassword(): Promise<boolean> {
  return (await load()).isDefault;
}

export type ChangeResult = { ok: true; persisted: boolean } | { ok: false; reason: "wrong_current" | "too_short" | "same_as_current" | "env_managed" };

export async function changePassword(current: string, next: string): Promise<ChangeResult> {
  if (passwordMode() === "env") return { ok: false, reason: "env_managed" };
  if (!(await verifyPassword(current))) return { ok: false, reason: "wrong_current" };
  if (next.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "too_short" };
  if (next === current) return { ok: false, reason: "same_as_current" };
  const previous = await load();
  const value = freshState(next, false, previous);
  const persisted = await getAuthStore().write(value).catch(error => {
    console.error("[AppAuth] Gagal menyimpan password baru", error);
    return false;
  });
  cached = { value: withEnvSecret(value), at: Date.now(), persisted };
  return { ok: true, persisted };
}

// --- Session tokens --------------------------------------------------------
function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export async function createSessionToken(now = Date.now()): Promise<string> {
  const { version, secret } = await load();
  const payload = Buffer.from(JSON.stringify({ v: version, exp: now + SESSION_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export async function verifySessionToken(token: string | undefined, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const { version, secret } = await load();
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { v: number; exp: number };
    return data.v === version && typeof data.exp === "number" && data.exp > now;
  } catch {
    return false;
  }
}

export async function isRequestAuthenticated(req: Pick<Request, "headers">): Promise<boolean> {
  const header = req.headers?.cookie;
  if (!header) return false;
  try {
    return await verifySessionToken(parseCookie(header)[AUTH_COOKIE]);
  } catch (error) {
    console.error("[AppAuth] Gagal memeriksa sesi", error);
    return false;
  }
}

function cookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: req.secure || process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
  };
}

export async function setSessionCookie(req: Request, res: Response) {
  res.cookie(AUTH_COOKIE, await createSessionToken(), cookieOptions(req));
}

export function clearSessionCookie(req: Request, res: Response) {
  const { maxAge: _ignored, ...options } = cookieOptions(req);
  res.clearCookie(AUTH_COOKIE, options);
}

// --- Brute-force protection for login -------------------------------------
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;

export async function loginBlocked(key: string): Promise<boolean> {
  return (await getAuthStore().failures(key, FAIL_WINDOW_MS).catch(() => 0)) >= MAX_FAILS;
}

export async function recordLoginFailure(key: string): Promise<void> {
  await getAuthStore().addFailure(key, FAIL_WINDOW_MS).catch(() => 0);
}

export async function clearLoginFailures(key: string): Promise<void> {
  await getAuthStore().clearFailures(key).catch(() => undefined);
}

/** For the health panel: where the password is kept. */
export function authStorageKind() {
  return getAuthStore().kind;
}
