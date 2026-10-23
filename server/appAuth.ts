import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseCookie } from "cookie";
import type { CookieOptions, Request, Response } from "express";

// ---------------------------------------------------------------------------
// Single shared app password.
// - First start: password = APP_DEFAULT_PASSWORD or "123456".
// - Changed from inside the app; stored as a scrypt hash in DATA_DIR/app-auth.json.
// - Sessions are HMAC-signed cookies; changing the password logs out every
//   other session (the session carries the password "version").
// ---------------------------------------------------------------------------

export const AUTH_COOKIE = "solscreen_auth";
export const DEFAULT_PASSWORD_FALLBACK = "123456";
export const MIN_PASSWORD_LENGTH = 8;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type StoredAuth = {
  salt: string;
  hash: string;
  version: number;
  secret: string;
  isDefault: boolean;
  updatedAt: string;
};

let state: StoredAuth | null = null;
let persistWarned = false;

const dataDir = () => process.env.DATA_DIR || path.resolve(process.cwd(), "data");
const authFile = () => path.join(dataDir(), "app-auth.json");

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function persist(next: StoredAuth): boolean {
  try {
    mkdirSync(dataDir(), { recursive: true });
    const tmp = `${authFile()}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, authFile());
    return true;
  } catch (error) {
    if (!persistWarned) {
      console.warn(`[AppAuth] Tidak bisa menyimpan ${authFile()} — password hanya tersimpan di memori sampai server restart.`, error);
      persistWarned = true;
    }
    return false;
  }
}

function freshState(password: string, isDefault: boolean, previous?: StoredAuth): StoredAuth {
  const salt = randomBytes(16).toString("hex");
  return {
    salt,
    hash: hashPassword(password, salt),
    version: (previous?.version ?? 0) + 1,
    secret: process.env.SESSION_SECRET || previous?.secret || randomBytes(32).toString("hex"),
    isDefault,
    updatedAt: new Date().toISOString(),
  };
}

function load(): StoredAuth {
  if (state) return state;
  try {
    const parsed = JSON.parse(readFileSync(authFile(), "utf8")) as StoredAuth;
    if (parsed.salt && parsed.hash && parsed.secret && Number.isInteger(parsed.version)) {
      state = { ...parsed, secret: process.env.SESSION_SECRET || parsed.secret };
      return state;
    }
  } catch {
    // Missing or unreadable: initialise below.
  }
  state = freshState(process.env.APP_DEFAULT_PASSWORD || DEFAULT_PASSWORD_FALLBACK, true);
  persist(state);
  return state;
}

/** Test helper: forget cached state so the next call re-reads DATA_DIR. */
export function resetAppAuthForTests() {
  state = null;
  persistWarned = false;
}

export function verifyPassword(password: string): boolean {
  const current = load();
  const candidate = Buffer.from(hashPassword(password, current.salt), "hex");
  const expected = Buffer.from(current.hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function isUsingDefaultPassword(): boolean {
  return load().isDefault;
}

export type ChangeResult = { ok: true; persisted: boolean } | { ok: false; reason: "wrong_current" | "too_short" | "same_as_current" };

export function changePassword(current: string, next: string): ChangeResult {
  if (!verifyPassword(current)) return { ok: false, reason: "wrong_current" };
  if (next.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "too_short" };
  if (next === current) return { ok: false, reason: "same_as_current" };
  state = freshState(next, false, load());
  return { ok: true, persisted: persist(state) };
}

// --- Session tokens --------------------------------------------------------
function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionToken(now = Date.now()): string {
  const { version, secret } = load();
  const payload = Buffer.from(JSON.stringify({ v: version, exp: now + SESSION_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const { version, secret } = load();
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

export function isRequestAuthenticated(req: Pick<Request, "headers">): boolean {
  const header = req.headers?.cookie;
  if (!header) return false;
  return verifySessionToken(parseCookie(header)[AUTH_COOKIE]);
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

export function setSessionCookie(req: Request, res: Response) {
  res.cookie(AUTH_COOKIE, createSessionToken(), cookieOptions(req));
}

export function clearSessionCookie(req: Request, res: Response) {
  const { maxAge: _ignored, ...options } = cookieOptions(req);
  res.clearCookie(AUTH_COOKIE, options);
}

// --- Brute-force protection for login -------------------------------------
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const failures = new Map<string, number[]>();

export function loginBlocked(key: string, now = Date.now()): boolean {
  const recent = (failures.get(key) ?? []).filter(t => now - t < FAIL_WINDOW_MS);
  failures.set(key, recent);
  return recent.length >= MAX_FAILS;
}

export function recordLoginFailure(key: string, now = Date.now()) {
  const recent = (failures.get(key) ?? []).filter(t => now - t < FAIL_WINDOW_MS);
  recent.push(now);
  failures.set(key, recent);
}

export function clearLoginFailures(key: string) {
  failures.delete(key);
}
