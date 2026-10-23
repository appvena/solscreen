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
} from "./appAuth";
import {
  checkRateLimit,
  ClaudeNotConfiguredError,
  getClaudeStatus,
  reviewTokenWithClaude,
  tokenReviewInput,
} from "./claudeReview";

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
      // On Vercel the filesystem is wiped, so a changed password only survives with Redis.
      passwordPersistent: authStorageKind() === "redis" || !process.env.VERCEL,
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
            result.reason === "too_short" ? `Password baru minimal ${MIN_PASSWORD_LENGTH} karakter.` :
            "Password baru harus berbeda dari yang sekarang.";
          throw new TRPCError({ code: "BAD_REQUEST", message });
        }
        // Old sessions are now invalid; issue a fresh one for this browser.
        await setSessionCookie(ctx.req, ctx.res);
        return { ok: true, persisted: result.persisted } as const;
      }),
  }),

  ai: router({
    /** Whether the Claude API key is configured (never returns the key itself). */
    status: appProcedure.query(() => getClaudeStatus()),

    /** Ask Claude for a structured risk review of one screened token. */
    reviewToken: appProcedure.input(tokenReviewInput).mutation(async ({ ctx, input }) => {
      if (!getClaudeStatus().configured) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Claude API belum dikonfigurasi. Isi ANTHROPIC_API_KEY di server." });
      }
      const clientKey = ctx.user?.openId ?? ctx.req.ip ?? "anon";
      if (!checkRateLimit(clientKey)) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Terlalu banyak permintaan review. Coba lagi dalam satu menit." });
      }
      try {
        return { ...(await reviewTokenWithClaude(input)), reviewedAt: new Date().toISOString() };
      } catch (error) {
        if (error instanceof ClaudeNotConfiguredError) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
        }
        if (error instanceof Anthropic.APIError) {
          console.error("[Claude] API error", error.status, error.message);
          const message =
            error.status === 401 ? "API key Claude ditolak. Periksa ANTHROPIC_API_KEY." :
            error.status === 429 ? "Batas pemakaian Claude API tercapai. Coba lagi nanti." :
            error.status === 404 ? "Model Claude tidak ditemukan. Periksa CLAUDE_MODEL." :
            "Claude API sedang bermasalah. Coba lagi nanti.";
          throw new TRPCError({ code: "BAD_GATEWAY", message });
        }
        console.error("[Claude] review failed", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Review AI gagal diproses." });
      }
    }),
  }),
});

export type AppRouter = typeof appRouter;
