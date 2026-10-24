import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { z } from "zod";
import { appProcedure, publicProcedure, router } from "./_core/trpc";
import {
  changePassword,
  clearLoginFailures,
  clearSessionCookie,
  isUsingDefaultPassword,
  loginBlocked,
  MIN_PASSWORD_LENGTH,
  recordLoginFailure,
  setSessionCookie,
  verifyPassword,
  authStorageKind,
  passwordMode,
} from "./appAuth";
import {
  checkRateLimit,
  claudeEnv,
  ClaudeNotConfiguredError,
  getClaudeStatus,
  reviewCandidate,
} from "./claudeReview";
import { getKv } from "./kv";
import { getScreening } from "./screening";
import { getUsageSummary, setBalance, takeDailyReviewSlot } from "./usage";

export const appRouter = router({
  // All API routes live under /api/ so the gateway can route them correctly.
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  /** Shared app password (login screen + change password in settings). */
  appAuth: router({
    session: publicProcedure.query(async ({ ctx }) => ({
      authenticated: ctx.appAuthed,
      usingDefaultPassword: ctx.appAuthed ? await isUsingDefaultPassword() : false,
      // "env": set via APP_PASSWORD in the hosting dashboard; "app": changeable in the app.
      passwordManagedBy: passwordMode(),
      passwordPersistent: passwordMode() === "env" || authStorageKind() === "redis" || !process.env.VERCEL,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    })),

    login: publicProcedure
      .input(z.object({ password: z.string().min(1).max(200) }))
      .mutation(async ({ ctx, input }) => {
        const key = ctx.req.ip ?? "anon";
        if (await loginBlocked(key)) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit." });
        }
        const valid = await verifyPassword(input.password).catch(error => {
          console.error("[AppAuth] login gagal diproses", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Penyimpanan password tidak dapat diakses. Coba lagi sebentar." });
        });
        if (!valid) {
          await recordLoginFailure(key);
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Password salah." });
        }
        await clearLoginFailures(key);
        await setSessionCookie(ctx.req, ctx.res);
        return { ok: true, usingDefaultPassword: await isUsingDefaultPassword() } as const;
      }),

    logout: publicProcedure.mutation(({ ctx }) => {
      clearSessionCookie(ctx.req, ctx.res);
      return { ok: true } as const;
    }),

    changePassword: appProcedure
      .input(z.object({ current: z.string().min(1).max(200), next: z.string().max(200) }))
      .mutation(async ({ ctx, input }) => {
        const result = await changePassword(input.current, input.next);
        if (!result.ok) {
          const message =
            result.reason === "wrong_current" ? "Password saat ini salah." :
            result.reason === "env_managed" ? "Password diatur lewat variabel APP_PASSWORD di hosting, bukan dari aplikasi." :
            result.reason === "too_short" ? `Password baru minimal ${MIN_PASSWORD_LENGTH} karakter.` :
            "Password baru harus berbeda dari yang sekarang.";
          throw new TRPCError({ code: "BAD_REQUEST", message });
        }
        // Old sessions are now invalid; issue a fresh one for this browser.
        await setSessionCookie(ctx.req, ctx.res);
        return { ok: true, persisted: result.persisted } as const;
      }),
  }),

  /** Live screening of new Solana tokens (cached 15 min). */
  screening: router({
    today: appProcedure
      .input(z.object({ force: z.boolean().optional() }).optional())
      .query(async ({ input }) => {
        try {
          return await getScreening(input?.force === true);
        } catch (error) {
          console.error("[Screening] gagal", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Gagal mengambil data token. Coba muat ulang sebentar lagi." });
        }
      }),
  }),

  ai: router({
    /** Whether the Claude API key is configured (never returns the key itself). */
    status: appProcedure.query(() => getClaudeStatus()),

    /** Claude credit meter (Anthropic has no balance API; we meter our own calls). */
    usage: appProcedure.query(() => getUsageSummary()),

    setBalance: appProcedure
      .input(z.object({ amountUsd: z.number().min(0).max(100000) }))
      .mutation(async ({ input }) => {
        await setBalance(input.amountUsd);
        return getUsageSummary();
      }),

    /** Cached Claude review for a screened token; `mode: "deep"` re-runs with the stronger model. */
    review: appProcedure
      .input(z.object({ mint: z.string().min(20).max(60), mode: z.enum(["auto", "deep"]).default("auto"), cachedOnly: z.boolean().optional() }))
      .mutation(async ({ ctx, input }) => {
        const kv = getKv();
        const cacheKey = `solscreen:review:${input.mode}:${input.mint}`;
        const cached = await kv.get<StoredReview>(cacheKey).catch(() => null);
        if (cached) return { ...cached, cached: true };
        if (input.cachedOnly) return null;

        if (!getClaudeStatus().configured) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Claude API belum dikonfigurasi. Isi ANTHROPIC_API_KEY di server." });
        }
        const clientKey = ctx.req.ip ?? "anon";
        if (!checkRateLimit(clientKey)) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Terlalu banyak permintaan review. Coba lagi dalam satu menit." });
        }
        // Only review tokens that are actually in today's screening (server-side data, not client input).
        const screening = await getScreening();
        const candidate = screening.candidates.find(c => c.mint === input.mint);
        if (!candidate) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Token ini sudah tidak ada di hasil screening terbaru. Muat ulang daftar." });
        }
        if (!(await takeDailyReviewSlot(claudeEnv.dailyLimit))) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Batas harian ${claudeEnv.dailyLimit} review baru tercapai (pengaman kredit). Atur CLAUDE_DAILY_REVIEW_LIMIT bila perlu.` });
        }
        try {
          const result = await reviewCandidate(candidate, input.mode);
          const stored: StoredReview = { ...result, mode: input.mode, reviewedAt: new Date().toISOString() };
          await kv.set(cacheKey, stored, 24 * 3600).catch(() => undefined);
          return { ...stored, cached: false };
        } catch (error) {
          if (error instanceof ClaudeNotConfiguredError) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
          }
          if (error instanceof Anthropic.APIError) {
            console.error("[Claude] API error", error.status, error.message);
            const message =
              error.status === 401 ? "API key Claude ditolak. Periksa ANTHROPIC_API_KEY." :
              error.status === 402 || /credit|balance/i.test(error.message) ? "Kredit Claude habis. Isi ulang di platform.claude.com → Billing." :
              error.status === 429 ? "Batas pemakaian Claude API tercapai. Coba lagi nanti." :
              error.status === 404 ? "Model Claude tidak ditemukan. Periksa CLAUDE_MODEL / CLAUDE_AUTO_MODEL." :
              "Claude API sedang bermasalah. Coba lagi nanti.";
            throw new TRPCError({ code: "BAD_GATEWAY", message });
          }
          console.error("[Claude] review failed", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Review AI gagal diproses." });
        }
      }),
  }),
});

type StoredReview = Awaited<ReturnType<typeof reviewCandidate>> & { mode: "auto" | "deep"; reviewedAt: string };

export type AppRouter = typeof appRouter;
