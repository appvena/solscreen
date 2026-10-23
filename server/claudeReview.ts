import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Claude-powered token review.
// The API key never leaves the server: it is read from ANTHROPIC_API_KEY at
// call time and is never serialized into any response or public config.
// ---------------------------------------------------------------------------

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";

export const claudeEnv = {
  get apiKey() { return process.env.ANTHROPIC_API_KEY ?? ""; },
  get model() { return process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL; },
};

/** Candidate data sent from the dashboard. Every field is bounded. */
export const tokenReviewInput = z.object({
  name: z.string().min(1).max(80),
  symbol: z.string().min(1).max(20),
  mint: z.string().max(80),
  isSimulated: z.boolean(),
  status: z.string().max(30),
  risk: z.string().max(30),
  priceIdr: z.string().max(40),
  priceUsd: z.string().max(40),
  change24hPct: z.number().min(-100).max(100000),
  liquidityUsd: z.string().max(30),
  volume24hUsd: z.string().max(30),
  detected: z.string().max(40),
  holders: z.string().max(60),
  devWallet: z.string().max(60),
  bubbleMap: z.string().max(60),
  socials: z.string().max(60),
  roadmap: z.string().max(60),
  ruleSignals: z.array(z.string().max(200)).max(12),
});
export type TokenReviewInput = z.infer<typeof tokenReviewInput>;

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
});
export type TokenReview = z.infer<typeof tokenReviewOutput>;

export type ClaudeStatus = { configured: boolean; model: string };

export function getClaudeStatus(): ClaudeStatus {
  return { configured: claudeEnv.apiKey.length > 0, model: claudeEnv.model };
}

const SYSTEM_PROMPT = `Kamu adalah analis risiko on-chain untuk token baru di jaringan Solana.
Tugasmu menilai data screening satu token dan mengembalikan penilaian risiko yang skeptis dan berbasis bukti.

Aturan:
- Tulis semua teks dalam Bahasa Indonesia yang ringkas dan jelas.
- Jangan pernah menyarankan membeli, menjual, atau waktu masuk/keluar. Ini alat pemantauan risiko, bukan saran investasi.
- Nilai hanya dari data yang diberikan. Jika data kosong, tidak tuntas, atau belum terverifikasi, masukkan ke "missingData" dan turunkan "confidence".
- Utamakan risiko: konsentrasi holder tinggi, riwayat creator buruk, likuiditas rendah, cluster wallet, dan proyek tanpa bukti adalah red flag.
- "riskScore": 0 = risiko sangat rendah, 100 = risiko sangat tinggi.
- "confidence": seberapa yakin kamu dengan penilaian, berdasarkan kelengkapan dan konsistensi data.
- "verdict": "hindari" untuk risiko tinggi yang jelas, "perlu_review_manual" bila sinyal campuran atau data kurang, "layak_dipantau" hanya bila sinyal mayoritas sehat.
- Jika "isSimulated" bernilai true, sebutkan di "summary" bahwa penilaian dibuat dari data simulasi.
- "nextChecks": langkah verifikasi konkret yang bisa dilakukan operator (mis. cek authority di explorer, cek distribusi holder di sumber kedua).`;

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
    cachedClient = { key, client: new Anthropic({ apiKey: key, maxRetries: 2, timeout: 60_000 }) };
  }
  return cachedClient.client;
}

export async function reviewTokenWithClaude(input: TokenReviewInput, client: Pick<Anthropic, "messages"> = getClient()): Promise<TokenReview & { model: string }> {
  const model = claudeEnv.model;
  const message = await client.messages.parse({
    model,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Tinjau token berikut dan kembalikan penilaian terstruktur.\n\n<token_data>\n${JSON.stringify(input, null, 2)}\n</token_data>`,
      },
    ],
    output_config: { format: zodOutputFormat(tokenReviewOutput) },
  });

  const parsed = message.parsed_output;
  if (!parsed) throw new Error("Claude tidak mengembalikan JSON yang valid.");
  return { ...tokenReviewOutput.parse(parsed), model: message.model ?? model };
}

// ---------------------------------------------------------------------------
// Simple in-memory rate limit so a public endpoint cannot drain the API key.
// ---------------------------------------------------------------------------
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 6;
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
