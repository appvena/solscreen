import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import { checkRateLimit, resetRateLimit, reviewCandidate } from "./claudeReview";
import { createMemoryKv, getKv, setKvForTests } from "./kv";
import { setAutomation } from "./automation";
import { getScreening } from "./screening";
import { estimateCostUsd, getUsageSummary, setBalance } from "./usage";
import type { TokenCandidate } from "./screening/analyze";
import type { TrpcContext } from "./_core/context";

const candidate: TokenCandidate = {
  mint: "AAAAaaaa1111111111111111111111111111111pump",
  name: "NOVA SIGNAL", symbol: "NOVA", imageUrl: null, priceUsd: 0.0000123, priceIdr: 0.2,
  change: { m5: 1, h1: 5, h6: 20, h24: 40 }, liquidityUsd: 25000, volume24hUsd: 90000, marketCapUsd: 12300,
  ageMinutes: 180, dexId: "pumpswap", description: "Proyek NOVA", websites: [{ label: "Website", url: "https://nova.example" }],
  socials: [{ label: "twitter", url: "https://x.com/nova" }],
  links: { dexscreener: "", rugcheck: "", solscan: "" },
  checks: {
    authorities: { tone: "good", label: "Mint & freeze off" }, devWallet: { tone: "good", label: "Dev pegang 1%" },
    holders: { tone: "good", label: "Top 10 · 20%", top10Pct: 20, maxHolderPct: 2, totalHolders: 800 },
    bubble: { tone: "good", label: "Tidak ada cluster insider" }, socials: { tone: "good", label: "X + website" },
    liquidity: { tone: "good", label: "$25K", lpLockedPct: 100 },
  },
  rugScore: 12, status: "Lolos", unmet: [], critical: null, curve: null, risk: "Low", reasons: [{ tone: "good", text: "Authority off" }], spark: [1, 2],
};

const review = {
  verdict: "perlu_review_manual", riskScore: 58, confidence: 40, summary: "Ringkasan.",
  redFlags: ["Umur < 24 jam"], positiveSignals: ["Authority off"], missingData: [], nextChecks: ["Cek X"],
  socialFindings: ["Akun X dibuat minggu ini"], projectPlans: ["Tidak ditemukan rencana proyek yang dapat diverifikasi"],
} as const;

const ctx = (appAuthed = true): TrpcContext => ({ user: null, appAuthed, req: { ip: "1.2.3.4", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] });

beforeEach(() => setKvForTests(createMemoryKv()));
afterEach(() => { vi.unstubAllEnvs(); resetRateLimit(); setKvForTests(null); });

describe("Claude review", () => {
  it("reports status without exposing the key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret-test");
    vi.stubEnv("CLAUDE_MODEL", "");
    vi.stubEnv("CLAUDE_AUTO_MODEL", "");
    const status = await appRouter.createCaller(ctx()).ai.status();
    expect(status).toMatchObject({ configured: true, model: "claude-sonnet-5-5", autoModel: "claude-haiku-5-5" });
    expect(JSON.stringify(status)).not.toContain("sk-ant");
  });

  it("requires the app password session", async () => {
    await expect(appRouter.createCaller(ctx(false)).ai.status()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(appRouter.createCaller(ctx(false)).ai.review({ mint: candidate.mint, mode: "auto" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(appRouter.createCaller(ctx(false)).screening.today()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses to review when no API key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(appRouter.createCaller(ctx()).ai.review({ mint: candidate.mint, mode: "auto" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("returns a cached review without calling Claude again", async () => {
    const kv = createMemoryKv();
    setKvForTests(kv);
    await kv.set(`solscreen:review:auto:${candidate.mint}`, { ...review, model: "m", webSearches: 0, costUsd: 0, mode: "auto", reviewedAt: "x" });
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const res = await appRouter.createCaller(ctx()).ai.review({ mint: candidate.mint, mode: "auto" });
    expect(res).toMatchObject({ cached: true, verdict: "perlu_review_manual" });
    expect(await appRouter.createCaller(ctx()).ai.review({ mint: "Z".repeat(40), mode: "auto", cachedOnly: true })).toBeNull();
  });

  it("auto mode: cheap model + web search, records usage and cost", async () => {
    vi.stubEnv("CLAUDE_AUTO_MODEL", "");
    vi.stubEnv("CLAUDE_WEB_SEARCH", "");
    const parse = vi.fn().mockResolvedValue({
      model: "claude-haiku-5-5", stop_reason: "end_turn", content: [], parsed_output: review,
      usage: { input_tokens: 20_000, output_tokens: 1_000, server_tool_use: { web_search_requests: 2 } },
    });
    const result = await reviewCandidate(candidate, "auto", { messages: { parse } } as never);
    expect(result).toMatchObject({ verdict: "perlu_review_manual", model: "claude-haiku-5-5", webSearches: 2 });
    const params = parse.mock.calls[0][0];
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.tools[0]).toMatchObject({ name: "web_search", max_uses: 3 });
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.messages[0].content).toContain("NOVA SIGNAL");
    expect(params.system).toMatch(/Jangan pernah menyarankan membeli/);
    // 20k×$0.10/M + 1k×$0.50/M + 2×$0.01 = 0.0025 + 0.02
    expect(result.costUsd).toBeCloseTo(0.0225, 6);
    const usage = await getUsageSummary();
    expect(usage).toMatchObject({ calls: 1, webSearches: 2, inputTokens: 20_000, outputTokens: 1_000 });
  });

  it("deep mode uses the stronger model and continues paused turns", async () => {
    vi.stubEnv("CLAUDE_MODEL", "");
    const parse = vi.fn()
      .mockResolvedValueOnce({ model: "claude-sonnet-5-5", stop_reason: "pause_turn", content: [{ type: "text", text: "..." }], parsed_output: null, usage: { input_tokens: 10, output_tokens: 10 } })
      .mockResolvedValueOnce({ model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [], parsed_output: review, usage: { input_tokens: 10, output_tokens: 10 } });
    const result = await reviewCandidate(candidate, "deep", { messages: { parse } } as never);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(parse.mock.calls[0][0].model).toBe("claude-sonnet-5-5");
    expect(parse.mock.calls[1][0].messages.at(-1).role).toBe("assistant");
    expect(result.verdict).toBe("perlu_review_manual");
  });

  it("falls back to a data-only review if web search is rejected", async () => {
    const err = new Anthropic.BadRequestError(400, { error: { message: "tools not supported" } }, "tools not supported", new Headers());
    const parse = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ model: "m", stop_reason: "end_turn", content: [], parsed_output: review, usage: {} });
    await reviewCandidate(candidate, "auto", { messages: { parse } } as never);
    expect(parse.mock.calls[1][0].tools).toBeUndefined();
  });

  it("fails clearly when Claude returns no parsed output", async () => {
    const parse = vi.fn().mockResolvedValue({ model: "m", stop_reason: "end_turn", content: [], parsed_output: null, usage: {} });
    await expect(reviewCandidate(candidate, "auto", { messages: { parse } } as never)).rejects.toThrow("JSON");
  });

  it("estimates remaining credit from a user-entered balance", async () => {
    await setBalance(5);
    expect(estimateCostUsd({ model: "claude-sonnet-5-5", inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 })).toBeCloseTo(3);
    const parse = vi.fn().mockResolvedValue({ model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [], parsed_output: review, usage: { input_tokens: 100_000, output_tokens: 10_000 } });
    await reviewCandidate(candidate, "deep", { messages: { parse } } as never);
    const usage = await getUsageSummary();
    expect(usage.spentSinceBalanceUsd).toBeCloseTo(0.3);
    expect(usage.remainingUsd).toBeCloseTo(4.7);
  });

  it("rate-limits repeated requests per client", () => {
    const now = 1_000_000;
    for (let i = 0; i < 20; i++) expect(checkRateLimit("a", now + i)).toBe(true);
    expect(checkRateLimit("a", now + 30)).toBe(false);
    expect(checkRateLimit("b", now + 30)).toBe(true);
  });

  it("manual deep review and manual re-scan require the app password", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    vi.stubEnv("APP_PASSWORD", "rahasia123");
    vi.stubEnv("VERCEL", "1");
    const caller = appRouter.createCaller(ctx());
    await expect(caller.ai.review({ mint: candidate.mint, mode: "deep" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.ai.review({ mint: candidate.mint, mode: "deep", password: "salah" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.screening.rescan({ password: "salah" })).rejects.toMatchObject({ code: "FORBIDDEN", message: "Password salah." });
  });

  it("automation off: no scan on open and no automatic Claude review", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-x");
    await setAutomation({ autoScanMinutes: 0, autoReview: false });
    expect(await getScreening(false)).toBeNull(); // nothing stored yet, and no scan is started
    await getKv().set("solscreen:screening:last:v3", { generatedAt: new Date(Date.now() - 6 * 3600_000).toISOString(), candidates: [candidate], sources: [] });
    const last = await getScreening(false);
    expect(last).toMatchObject({ cached: true, nextScanAt: null, autoScanMinutes: 0 });
    const caller = appRouter.createCaller(ctx());
    await expect(caller.ai.review({ mint: candidate.mint, mode: "auto" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "Review Claude otomatis sedang dimatikan." });
    expect(await caller.settings.automation()).toEqual({ autoScanMinutes: 0, autoReview: false });
  });
});
