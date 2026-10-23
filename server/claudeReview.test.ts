import { afterEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import { checkRateLimit, resetRateLimit, reviewTokenWithClaude, type TokenReviewInput } from "./claudeReview";
import type { TrpcContext } from "./_core/context";

const sample: TokenReviewInput = {
  name: "NOVA SIGNAL", symbol: "NOVA", mint: "7wN...r4qP", isSimulated: true, status: "Review", risk: "Medium",
  priceIdr: "Rp0,084", priceUsd: "$0.00000468", change24hPct: 18.4, liquidityUsd: "$24.8K", volume24hUsd: "$61.2K",
  detected: "32 mnt lalu", holders: "Top 10 · 42%", devWallet: "Authority off", bubbleMap: "Tidak tuntas",
  socials: "X + situs", roadmap: "Belum terverifikasi", ruleSignals: ["Authority mint dan freeze nonaktif"],
};
const review = {
  verdict: "perlu_review_manual", riskScore: 58, confidence: 40, summary: "Dinilai dari data simulasi.",
  redFlags: ["Top 10 holder 42%"], positiveSignals: ["Authority off"], missingData: ["Bubble map"], nextChecks: ["Cek holder di Solscan"],
} as const;

const ctx = (appAuthed = true): TrpcContext => ({ user: null, appAuthed, req: { ip: "1.2.3.4", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] });

afterEach(() => { vi.unstubAllEnvs(); resetRateLimit(); });

describe("Claude review", () => {
  it("reports status without exposing the key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret-test");
    vi.stubEnv("CLAUDE_MODEL", "");
    const status = await appRouter.createCaller(ctx()).ai.status();
    expect(status).toEqual({ configured: true, model: "claude-sonnet-5-5" });
    expect(JSON.stringify(status)).not.toContain("sk-ant");
  });

  it("requires the app password session", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    await expect(appRouter.createCaller(ctx(false)).ai.status()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(appRouter.createCaller(ctx(false)).ai.reviewToken(sample)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses to review when no API key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(appRouter.createCaller(ctx()).ai.reviewToken(sample)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("rejects oversized input", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    await expect(appRouter.createCaller(ctx()).ai.reviewToken({ ...sample, name: "x".repeat(500) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("sends token data to Claude and returns the parsed structured review", async () => {
    vi.stubEnv("CLAUDE_MODEL", "claude-opus-5-5");
    const parse = vi.fn().mockResolvedValue({ model: "claude-opus-5-5", parsed_output: review });
    const result = await reviewTokenWithClaude(sample, { messages: { parse } } as never);
    expect(result).toEqual({ ...review, model: "claude-opus-5-5" });
    const params = parse.mock.calls[0][0];
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.messages[0].content).toContain("NOVA SIGNAL");
    expect(params.system).toMatch(/Jangan pernah menyarankan membeli/);
  });

  it("fails clearly when Claude returns no parsed output", async () => {
    const parse = vi.fn().mockResolvedValue({ model: "m", parsed_output: null });
    await expect(reviewTokenWithClaude(sample, { messages: { parse } } as never)).rejects.toThrow("JSON");
  });

  it("rate-limits repeated requests per client", () => {
    const now = 1_000_000;
    for (let i = 0; i < 6; i++) expect(checkRateLimit("a", now + i)).toBe(true);
    expect(checkRateLimit("a", now + 10)).toBe(false);
    expect(checkRateLimit("b", now + 10)).toBe(true);
    expect(checkRateLimit("a", now + 61_000)).toBe(true);
  });
});
