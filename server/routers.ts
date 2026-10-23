import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
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

  ai: router({
    /** Whether the Claude API key is configured (never returns the key itself). */
    status: publicProcedure.query(() => getClaudeStatus()),

    /** Ask Claude for a structured risk review of one screened token. */
    reviewToken: publicProcedure.input(tokenReviewInput).mutation(async ({ ctx, input }) => {
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
