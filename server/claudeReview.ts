import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { TokenCandidate } from "./screening/analyze";
import { recordUsage, type CallUsage } from "./usage";

// ---------------------------------------------------------------------------
// Claude-powered token review.
// The API key never leaves the server: it is read from ANTHROPIC_API_KEY at
// call time and is never serialized into any response or public config.
// - "auto": runs for every screened candidate (cheap model + light web research)
// - "deep": operator-triggered re-review (stronger model + more web research)
// ---------------------------------------------------------------------------

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
export const DEFAULT_AUTO_MODEL = "claude-haiku-5-5";

export const claudeEnv = {
  get apiKey() { return process.env.ANTHROPIC_API_KEY ?? ""; },
  get model() { return process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL; },
  get autoModel() { return process.env.CLAUDE_AUTO_MODEL || DEFAULT_AUTO_MODEL; },
  get webSearch() { return process.env.CLAUDE_WEB_SEARCH !== "off"; },
  get dailyLimit() { return Number(process.env.CLAUDE_DAILY_REVIEW_LIMIT) || 60; },
};

export type ReviewMode = "auto" | "deep";

/** Structured JSON Claude must return. */
export const tokenReviewOutput = z.object({
  verdict: z.enum(["layak_dipantau", "perlu_review_manual", "hindari"]),
  riskScore: z.number().int().min(0).max(100),
  confidence: z.number().int().min(0).max(100),
  summary: z.string(),
  redFlags: z.array(z.string()),
  positiveSignals: z.array(z.string()),
  missingData: z.array(z.string()),
  nextChecks: z.array(z.string()),
  socialFindings: z.array(z.string()),
  projectPlans: z.array(z.string()),
});
export type TokenReview = z.infer<typeof tokenReviewOutput>;

export type ClaudeStatus = { configured: boolean; model: string; autoModel: string; webSearch: boolean };

export function getClaudeStatus(): ClaudeStatus {
  return { configured: claudeEnv.apiKey.length > 0, model: claudeEnv.model, autoModel: claudeEnv.autoModel, webSearch: claudeEnv.webSearch };
}

const SYSTEM_PROMPT = `Kamu adalah analis risiko on-chain untuk token baru di jaringan Solana.
Tugasmu menilai data screening satu token dan mengembalikan penilaian risiko yang skeptis dan berbasis bukti.

Aturan:
- Tulis semua teks dalam Bahasa Indonesia yang ringkas dan jelas.
- Jangan pernah menyarankan membeli, menjual, atau waktu masuk/keluar. Ini alat pemantauan risiko, bukan saran investasi.
- Data on-chain (authority, holder, insider, dev wallet, likuiditas) berasal dari RugCheck dan DexScreener dan sudah dicek oleh aturan otomatis. Gunakan sebagai fakta utama.
- Jika alat pencarian web tersedia, gunakan untuk memeriksa akun media sosial (X/Twitter, Telegram, website) dan rencana proyek/roadmap/rilis yang diumumkan token ini. Waspadai akun yang baru dibuat, tanpa pengikut nyata, nama yang meniru proyek terkenal, atau klaim berlebihan.
- "socialFindings": temuan konkret tentang media sosial/website (atau kosong jika tidak ditemukan).
- "projectPlans": rencana/rilis proyek yang diumumkan dan sumbernya; tulis "Tidak ditemukan rencana proyek yang dapat diverifikasi" bila tidak ada.
- Jika data kosong, tidak tuntas, atau belum terverifikasi, masukkan ke "missingData" dan turunkan "confidence".
- "riskScore": 0 = risiko sangat rendah, 100 = risiko sangat tinggi. Token berumur < 24 jam hampir selalu berisiko tinggi; jangan beri skor di bawah 30 kecuali buktinya sangat kuat.
- "verdict": "hindari" untuk risiko tinggi yang jelas, "perlu_review_manual" bila sinyal campuran atau data kurang, "layak_dipantau" hanya bila sinyal mayoritas sehat.
- "nextChecks": langkah verifikasi konkret yang bisa dilakukan operator.`;

export class ClaudeNotConfiguredError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY belum diatur di server.");
    this.name = "ClaudeNotConfiguredError";
  }
}

let cachedClient: { key: string; client: Anthropic } | null = null;
function getClient(): Anthropic {
  const key = claudeEnv.apiKey;
  if (!key) throw new ClaudeNotConfiguredError();
  if (!cachedClient || cachedClient.key !== key) {
    cachedClient = { key, client: new Anthropic({ apiKey: key, maxRetries: 2, timeout: 120_000 }) };
  }
  return cachedClient.client;
}

/** Compact, model-friendly view of a screened candidate. */
export function candidateForPrompt(c: TokenCandidate) {
  return {
    nama: c.name,
    simbol: c.symbol,
    mint: c.mint,
    umurMenit: c.ageMinutes,
    hargaUsd: c.priceUsd,
    hargaIdr: Number(c.priceIdr.toPrecision(4)),
    perubahanHargaPersen: c.change,
    likuiditasUsd: c.liquidityUsd,
    volume24jUsd: c.volume24hUsd,
    marketCapUsd: c.marketCapUsd,
    dex: c.dexId,
    statusAturan: c.status,
    rugcheckScore0sd100: c.rugScore,
    cek: Object.fromEntries(Object.entries(c.checks).map(([k, v]) => [k, `${v.tone}: ${v.label}`])),
    alasan: c.reasons.map(r => `${r.tone}: ${r.text}`),
    deskripsiProfil: c.description,
    website: c.websites.map(w => w.url),
    mediaSosial: c.socials.map(s => `${s.label}: ${s.url}`),
  };
}

type MessagesApi = Pick<Anthropic, "messages">;

export async function reviewCandidate(
  candidate: TokenCandidate,
  mode: ReviewMode,
  client: MessagesApi = getClient(),
): Promise<TokenReview & { model: string; webSearches: number; costUsd: number }> {
  const model = mode === "auto" ? claudeEnv.autoModel : claudeEnv.model;
  const useSearch = claudeEnv.webSearch;
  const tools = useSearch ? [{ type: "web_search_20250305" as const, name: "web_search" as const, max_uses: mode === "auto" ? 3 : 6 }] : undefined;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Tinjau token Solana berikut. ${useSearch ? "Cari media sosial dan rencana proyeknya di web, lalu " : ""}kembalikan penilaian terstruktur.\n\n<token_data>\n${JSON.stringify(candidateForPrompt(candidate), null, 2)}\n</token_data>`,
    },
  ];

  const usage: CallUsage = { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 };
  const call = (withTools: boolean) =>
    client.messages.parse({
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages,
      ...(withTools && tools ? { tools } : {}),
      output_config: { format: zodOutputFormat(tokenReviewOutput) },
    });

  let toolsOn = Boolean(tools);
  let message;
  try {
    message = await call(toolsOn);
  } catch (error) {
    // Some model/tool/format combinations may be rejected; fall back to a data-only review.
    if (toolsOn && error instanceof Anthropic.APIError && error.status === 400) {
      console.warn("[Claude] web search ditolak, lanjut tanpa pencarian:", error.message);
      toolsOn = false;
      message = await call(false);
    } else {
      throw error;
    }
  }

  const addUsage = (m: { usage?: unknown; model?: string }) => {
    const u = (m.usage ?? {}) as Record<string, unknown> & { server_tool_use?: { web_search_requests?: number } };
    usage.inputTokens += Number(u.input_tokens ?? 0);
    usage.outputTokens += Number(u.output_tokens ?? 0);
    usage.cacheReadTokens += Number(u.cache_read_input_tokens ?? 0);
    usage.cacheWriteTokens += Number(u.cache_creation_input_tokens ?? 0);
    usage.webSearches += Number(u.server_tool_use?.web_search_requests ?? 0);
  };
  addUsage(message);

  // Long server-tool turns can pause; continue them a few times.
  for (let i = 0; i < 3 && message.stop_reason === "pause_turn"; i++) {
    messages.push({ role: "assistant", content: message.content as Anthropic.ContentBlockParam[] });
    message = await call(toolsOn);
    addUsage(message);
  }

  const costUsd = await recordUsage({ ...usage, model: message.model ?? model });
  const parsed = message.parsed_output;
  if (!parsed) throw new Error("Claude tidak mengembalikan JSON yang valid.");
  return { ...tokenReviewOutput.parse(parsed), model: message.model ?? model, webSearches: usage.webSearches, costUsd };
}

// ---------------------------------------------------------------------------
// Simple in-memory rate limit so a public endpoint cannot drain the API key.
// ---------------------------------------------------------------------------
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, number[]>();

export function checkRateLimit(key: string, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every(t => now - t >= WINDOW_MS)) hits.delete(k);
  }
  return true;
}

export function resetRateLimit() {
  hits.clear();
}
