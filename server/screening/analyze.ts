import type { CurveState } from "./pumpfun";
import type { Market, Profile, RugReport } from "./sources";

export type Tone = "good" | "warn" | "bad";
export type Check = { tone: Tone; label: string };
export type Status = "Lolos" | "Pantau" | "Ditolak";

/** Screening thresholds. Conservative on purpose: most fresh tokens should fail. */
export const RULES = {
  maxAgeHours: 24,
  maxPriceIdr: 1,
  minLiquidityUsd: 10_000,
  top10HealthyPct: 30,
  top10MaxPct: 45,
  singleHolderWarnPct: 8,
  singleHolderMaxPct: 15,
  creatorHealthyPct: 3,
  creatorMaxPct: 10,
  rugScoreWarn: 40,
  rugScoreMax: 70,
  /** A token may miss at most this many (non-critical) requirements and still be listed. */
  maxUnmet: 2,
  /** pump.fun: minimum bonding-curve progress to count as "about to graduate". */
  minCurveProgressPct: 60,
} as const;

export type TokenCandidate = {
  mint: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  priceUsd: number;
  priceIdr: number;
  change: Market["change"];
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  ageMinutes: number;
  dexId: string | null;
  description: string | null;
  websites: { label: string; url: string }[];
  socials: { label: string; url: string }[];
  links: { dexscreener: string; rugcheck: string; solscan: string; pumpfun?: string };
  /** Set for pump.fun tokens still on the bonding curve (not yet graduated to a DEX). */
  curve: { progressPct: number; solInCurve: number; address: string } | null;
  checks: {
    authorities: Check;
    devWallet: Check;
    holders: Check & { top10Pct: number | null; maxHolderPct: number | null; totalHolders: number | null };
    bubble: Check;
    socials: Check;
    liquidity: Check & { lpLockedPct: number | null };
  };
  rugScore: number | null;
  status: Status;
  /** Requirements this token does not (fully) meet, in plain language. */
  unmet: string[];
  /** Why it is rejected outright (authority active / rugged), if so. */
  critical: string | null;
  risk: "Low" | "Medium" | "High";
  reasons: { text: string; tone: Tone }[];
  spark: number[];
};

const fmtPct = (v: number) => `${v.toFixed(v < 10 ? 1 : 0).replace(".", ",")}%`;
const short = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`);

export type PrefilterResult = { ok: true } | { ok: false; reason: "umur" | "harga" | "likuiditas" | "data" };

/** Cheap filter on market data before calling RugCheck. */
export function prefilter(m: Market, usdIdr: number, now = Date.now()): PrefilterResult {
  if (m.priceUsd === null || m.pairCreatedAt === null) return { ok: false, reason: "data" };
  if (now - m.pairCreatedAt > RULES.maxAgeHours * 3600_000) return { ok: false, reason: "umur" };
  if (m.priceUsd * usdIdr >= RULES.maxPriceIdr) return { ok: false, reason: "harga" };
  if ((m.liquidityUsd ?? 0) < RULES.minLiquidityUsd) return { ok: false, reason: "likuiditas" };
  return { ok: true };
}

/** Synthetic path from DexScreener price-change windows: −24h, −6h, −1h, −5m, now. */
export function sparkFromChanges(price: number, c: Market["change"]): number[] {
  const back = (pct: number | null) => (pct === null || pct <= -100 ? null : price / (1 + pct / 100));
  const pts = [back(c.h24), back(c.h6), back(c.h1), back(c.m5), price].filter((v): v is number => v !== null && Number.isFinite(v));
  return pts.length >= 2 ? pts : [price, price];
}

export function holderStats(report: RugReport) {
  const real = report.topHolders.filter(h => !report.ammAccounts.has(h.address) && !(h.owner && report.ammAccounts.has(h.owner)));
  const top10 = real.slice(0, 10).reduce((sum, h) => sum + h.pct, 0);
  return {
    top10Pct: real.length ? top10 : null,
    maxHolderPct: real.length ? Math.max(...real.map(h => h.pct)) : null,
    insiderHolders: real.filter(h => h.insider).length,
  };
}

/** Bonding-curve tokens: same rules, except liquidity/LP (the curve holds the liquidity). */
export function prefilterBonding(m: Market, usdIdr: number, now = Date.now()): PrefilterResult {
  if (m.priceUsd === null || m.pairCreatedAt === null) return { ok: false, reason: "data" };
  if (now - m.pairCreatedAt > RULES.maxAgeHours * 3600_000) return { ok: false, reason: "umur" };
  if (m.priceUsd * usdIdr >= RULES.maxPriceIdr) return { ok: false, reason: "harga" };
  return { ok: true };
}

export function analyzeToken(market: Market, report: RugReport, profile: Profile | undefined, usdIdr: number, now = Date.now(), curve?: CurveState): TokenCandidate {
  // The bonding-curve account holds the unsold supply — it is not a "holder".
  if (curve) report.ammAccounts.add(curve.address);
  const reasons: { text: string; tone: Tone }[] = [];
  const add = (tone: Tone, text: string) => reasons.push({ tone, text });

  // Authorities
  const authOk = !report.mintAuthority && !report.freezeAuthority;
  const authorities: Check = authOk
    ? { tone: "good", label: "Mint & freeze off" }
    : { tone: "bad", label: report.mintAuthority ? "Mint authority aktif" : "Freeze authority aktif" };
  add(authorities.tone, authOk ? "Authority mint dan freeze sudah dinonaktifkan" : `${authorities.label} — creator masih bisa mencetak/membekukan token`);

  // Dev wallet
  const creatorRugRisk = report.risks.some(r => /creator|deployer/i.test(r.name) && /rug|history|scam/i.test(`${r.name} ${r.description ?? ""}`));
  let devWallet: Check;
  if (creatorRugRisk) devWallet = { tone: "bad", label: "Riwayat creator buruk" };
  else if (report.creatorPct === null) devWallet = { tone: "warn", label: "Saldo dev tidak diketahui" };
  else if (report.creatorPct <= RULES.creatorHealthyPct) devWallet = { tone: "good", label: `Dev pegang ${fmtPct(report.creatorPct)}` };
  else if (report.creatorPct <= RULES.creatorMaxPct) devWallet = { tone: "warn", label: `Dev pegang ${fmtPct(report.creatorPct)}` };
  else devWallet = { tone: "bad", label: `Dev pegang ${fmtPct(report.creatorPct)}` };
  add(devWallet.tone, creatorRugRisk ? "Wallet creator punya riwayat token bermasalah" : `Wallet dev: ${devWallet.label.toLowerCase()}`);

  // Holder distribution
  const hs = holderStats(report);
  let holdersTone: Tone = "warn";
  if (hs.top10Pct !== null && hs.maxHolderPct !== null) {
    if (hs.top10Pct <= RULES.top10HealthyPct && hs.maxHolderPct <= RULES.singleHolderWarnPct) holdersTone = "good";
    else if (hs.top10Pct > RULES.top10MaxPct || hs.maxHolderPct > RULES.singleHolderMaxPct) holdersTone = "bad";
  }
  const holders = {
    tone: holdersTone,
    label: hs.top10Pct === null ? "Data holder kosong" : `Top 10 · ${fmtPct(hs.top10Pct)}`,
    top10Pct: hs.top10Pct,
    maxHolderPct: hs.maxHolderPct,
    totalHolders: report.totalHolders,
  };
  add(holdersTone, hs.top10Pct === null ? "Distribusi holder belum bisa dibaca" :
    `Top 10 holder (tanpa pool) memegang ${fmtPct(hs.top10Pct)}, holder terbesar ${fmtPct(hs.maxHolderPct ?? 0)}${report.totalHolders ? ` dari ${report.totalHolders.toLocaleString("id-ID")} holder` : ""}`);

  // Bubble map proxy: insider clusters from RugCheck's wallet graph.
  const clusters = Math.max(report.insiderNetworks, report.insidersDetected > 0 ? 1 : 0);
  const bubble: Check = clusters === 0 && hs.insiderHolders === 0
    ? { tone: "good", label: "Tidak ada cluster insider" }
    : { tone: "bad", label: `${Math.max(clusters, 1)} cluster insider` };
  add(bubble.tone, bubble.tone === "good" ? "Tidak terdeteksi jaringan wallet insider (bubble map bersih)" :
    `Terdeteksi jaringan wallet insider${report.insidersDetected ? ` (${report.insidersDetected} wallet)` : ""} — pola bubble map mencurigakan`);

  // Socials & project
  const websites = market.websites;
  const socials = [...market.socials];
  for (const l of profile?.links ?? []) {
    const isWeb = /website|web|site/i.test(l.label);
    const list = isWeb ? websites : socials;
    if (!list.some(x => x.url === l.url)) list.push(l);
  }
  const hasX = socials.some(s => /twitter|x\.com|twitter\.com/i.test(`${s.label} ${s.url}`));
  const socialCount = websites.length + socials.length;
  const socialsCheck: Check = hasX && websites.length > 0 ? { tone: "good", label: "X + website" } : socialCount > 0 ? { tone: "warn", label: `${socialCount} tautan` } : { tone: "bad", label: "Tanpa media sosial" };
  add(socialsCheck.tone, socialCount === 0 ? "Tidak ada website atau media sosial yang terdaftar" : `Tautan proyek: ${[...websites, ...socials].map(l => l.label).join(", ")}`);

  // Liquidity & LP (bonding curve: liquidity sits in the curve, managed by pump.fun)
  const lpLocked = curve ? null : report.lpLockedPct;
  const liqTone: Tone = curve ? "good" : lpLocked !== null && lpLocked >= 90 ? "good" : lpLocked !== null && lpLocked < 50 ? "bad" : "warn";
  const liquidity = curve
    ? { tone: liqTone, label: `Bonding curve ${fmtPct(curve.progressPct)} · ${curve.solInCurve.toFixed(1).replace(".", ",")} SOL`, lpLockedPct: null }
    : { tone: liqTone, label: `${short(market.liquidityUsd ?? 0)}${lpLocked !== null ? ` · LP ${fmtPct(lpLocked)} terkunci` : ""}`, lpLockedPct: lpLocked };
  add(liqTone, curve
    ? `Masih di bonding curve pump.fun: ${fmtPct(curve.progressPct)} terisi (${curve.solInCurve.toFixed(1).replace(".", ",")} SOL). Likuiditas pindah ke DEX saat lulus.`
    : lpLocked === null ? "Status penguncian LP tidak diketahui" : `${fmtPct(lpLocked)} LP terkunci/terbakar`);

  // RugCheck danger flags not already covered
  const dangers = report.risks.filter(r => r.level === "danger");
  for (const d of dangers.slice(0, 3)) add("bad", `RugCheck: ${d.name}`);
  if (report.rugged) add("bad", "RugCheck menandai token ini sudah di-rug");
  const score = report.scoreNormalised;
  const scoreTone: Tone = score === null ? "warn" : score >= RULES.rugScoreMax ? "bad" : score >= RULES.rugScoreWarn ? "warn" : "good";

  // Decision: authority/rugged are critical (always rejected). Other requirements
  // may be missed 1–2 times — the token is then listed as "Pantau" with the unmet ones named.
  const critical = report.rugged ? "Ditandai sudah di-rug oleh RugCheck"
    : report.mintAuthority ? "Mint authority masih aktif (creator bisa mencetak token)"
    : report.freezeAuthority ? "Freeze authority masih aktif (creator bisa membekukan wallet)"
    : null;
  const unmet: string[] = [];
  if (devWallet.tone !== "good") unmet.push(`Wallet dev (${devWallet.label.toLowerCase()})`);
  if (holdersTone !== "good") unmet.push(`Distribusi holder (${holders.label})`);
  if (bubble.tone !== "good") unmet.push(`Bubble map (${bubble.label.toLowerCase()})`);
  if (liqTone !== "good") unmet.push(lpLocked === null ? "LP terkunci (tidak diketahui)" : `LP terkunci (${fmtPct(lpLocked)})`);
  if (socialsCheck.tone !== "good") unmet.push(`Media sosial (${socialsCheck.label.toLowerCase()})`);
  if (scoreTone !== "good" || dangers.length > 0) unmet.push(dangers.length ? `Peringatan RugCheck (${dangers[0].name})` : `Skor RugCheck (${score ?? "?"}/100)`);
  const status: Status = critical || unmet.length > RULES.maxUnmet ? "Ditolak" : unmet.length > 0 ? "Pantau" : "Lolos";

  const price = market.priceUsd ?? 0;
  return {
    mint: market.mint,
    name: market.name,
    symbol: market.symbol,
    imageUrl: market.imageUrl ?? profile?.icon ?? null,
    priceUsd: price,
    priceIdr: price * usdIdr,
    change: market.change,
    liquidityUsd: market.liquidityUsd,
    volume24hUsd: market.volume24hUsd,
    marketCapUsd: market.marketCapUsd,
    ageMinutes: market.pairCreatedAt ? Math.max(0, Math.round((now - market.pairCreatedAt) / 60_000)) : 0,
    dexId: market.dexId,
    description: profile?.description ?? null,
    websites,
    socials,
    links: {
      dexscreener: market.url ?? `https://dexscreener.com/solana/${market.mint}`,
      rugcheck: `https://rugcheck.xyz/tokens/${market.mint}`,
      solscan: `https://solscan.io/token/${market.mint}`,
      ...(curve ? { pumpfun: `https://pump.fun/coin/${market.mint}` } : {}),
    },
    curve: curve ? { progressPct: curve.progressPct, solInCurve: curve.solInCurve, address: curve.address } : null,
    checks: { authorities, devWallet, holders, bubble, socials: socialsCheck, liquidity },
    rugScore: score,
    status,
    unmet,
    critical,
    risk: status === "Ditolak" || unmet.some(u => /^(Wallet dev|Bubble map|Peringatan)/.test(u)) ? "High" : status === "Pantau" ? "Medium" : "Low",
    reasons,
    spark: sparkFromChanges(price, market.change),
  };
}
