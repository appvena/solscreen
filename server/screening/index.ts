import { getAutomation } from "../automation";
import { getKv } from "../kv";
import { analyzeToken, prefilter, prefilterBonding, RULES, type TokenCandidate } from "./analyze";
import { fetchCurves, type CurveState } from "./pumpfun";
import {
  fetchDexMarkets,
  fetchDexProfiles,
  fetchGeckoNewPools,
  fetchGeckoPumpPools,
  fetchRugReport,
  isBondingDex,
  fetchUsdIdr,
  mapLimit,
  tracked,
  type Market,
  type Profile,
  type SourceStatus,
} from "./sources";

export type ScreeningResult = {
  generatedAt: string;
  usdIdr: number;
  usdIdrLive: boolean;
  scanned: number;
  prefilterRejected: { umur: number; harga: number; likuiditas: number; data: number };
  checked: number;
  candidates: TokenCandidate[]; // Lolos + Pantau, best first
  /** pump.fun tokens still on the bonding curve, close to graduating (same rules, Lolos + Pantau). */
  nearGraduation: TokenCandidate[];
  bondingScanned: number;
  rejected: { symbol: string; mint: string; reason: string }[];
  rejectedCount: number;
  sources: SourceStatus[];
  rules: typeof RULES;
};

const CACHE_KEY = "solscreen:screening:last:v3";
const LOG_KEY = "solscreen:screening:log";
export const SCAN_CACHE_MINUTES = 15;

export type ScanLogEntry = { at: string; scanned: number; lolos: number; pantau: number; ditolak: number; sourcesOk: number; sourcesTotal: number; trigger: "buka" | "manual" | "jadwal" };

export async function getScanLog(): Promise<ScanLogEntry[]> {
  return (await getKv().get<ScanLogEntry[]>(LOG_KEY).catch(() => null)) ?? [];
}
const MAX_RUGCHECK = 18;
const MAX_BONDING_CHECK = 8;

export type ScreeningDeps = {
  geckoPools: typeof fetchGeckoNewPools;
  geckoPumpPools: typeof fetchGeckoPumpPools;
  curves: typeof fetchCurves;
  dexProfiles: typeof fetchDexProfiles;
  dexMarkets: typeof fetchDexMarkets;
  rugReport: typeof fetchRugReport;
  usdIdr: typeof fetchUsdIdr;
  now: () => number;
};

const defaultDeps: ScreeningDeps = {
  geckoPools: fetchGeckoNewPools,
  geckoPumpPools: fetchGeckoPumpPools,
  curves: fetchCurves,
  dexProfiles: fetchDexProfiles,
  dexMarkets: fetchDexMarkets,
  rugReport: fetchRugReport,
  usdIdr: fetchUsdIdr,
  now: Date.now,
};

export async function runScreening(deps: ScreeningDeps = defaultDeps): Promise<ScreeningResult> {
  const sources: SourceStatus[] = [];
  const now = deps.now();

  const [pools, profiles, fx, pumpPools] = await Promise.all([
    tracked("GeckoTerminal · pool baru", sources, () => deps.geckoPools(3)),
    tracked("DexScreener · profil token", sources, () => deps.dexProfiles()),
    deps.usdIdr(),
    tracked("GeckoTerminal · pump.fun aktif", sources, () => deps.geckoPumpPools(2)),
  ]);

  const profileByMint = new Map<string, Profile>();
  for (const p of profiles) if (!profileByMint.has(p.mint)) profileByMint.set(p.mint, p);
  // Pools already older than the window can be skipped before asking DexScreener.
  const recentPoolMints = pools.filter(p => !p.createdAt || now - p.createdAt <= RULES.maxAgeHours * 3600_000).map(p => p.mint);
  const recentPumpMints = pumpPools.filter(p => !p.createdAt || now - p.createdAt <= RULES.maxAgeHours * 3600_000).map(p => p.mint);
  const mints = [...new Set([...profileByMint.keys(), ...recentPoolMints, ...recentPumpMints])].slice(0, 180);

  const allMarkets = await tracked<Market>("DexScreener · harga & likuiditas", sources, () => deps.dexMarkets(mints));
  // Tokens whose only market is the pump.fun bonding curve go to the "about to graduate" track.
  const bondingMarkets = allMarkets.filter(m => isBondingDex(m.dexId));
  const markets = allMarkets.filter(m => !isBondingDex(m.dexId));

  const prefilterRejected = { umur: 0, harga: 0, likuiditas: 0, data: 0 };
  const survivors: Market[] = [];
  for (const m of markets) {
    const r = prefilter(m, fx.rate, now);
    if (r.ok) survivors.push(m);
    else prefilterRejected[r.reason]++;
  }
  // Prefer tokens with a profile (socials) and more liquidity.
  survivors.sort((a, b) => Number(profileByMint.has(b.mint)) - Number(profileByMint.has(a.mint)) || (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  const toCheck = survivors.slice(0, MAX_RUGCHECK);

  const started = Date.now();
  const reports = await mapLimit(toCheck, 4, m => deps.rugReport(m.mint));
  const okReports = reports.filter(r => r.status === "fulfilled").length;
  sources.push({
    name: "RugCheck · holder, dev & insider",
    ok: toCheck.length === 0 || okReports > 0,
    count: okReports,
    error: toCheck.length > 0 && okReports === 0 ? String((reports[0] as PromiseRejectedResult).reason?.message ?? "gagal") : undefined,
    ms: Date.now() - started,
  });

  const analyzed: TokenCandidate[] = [];
  toCheck.forEach((m, i) => {
    const r = reports[i];
    if (r.status === "fulfilled") analyzed.push(analyzeToken(m, r.value, profileByMint.get(m.mint), fx.rate, now));
  });

  // --- pump.fun: about to graduate --------------------------------------
  const bondingSurvivors = bondingMarkets.filter(m => prefilterBonding(m, fx.rate, now).ok);
  const curveList = bondingSurvivors.length
    ? await tracked<CurveState>("Solana RPC · bonding curve pump.fun", sources, () => deps.curves(bondingSurvivors.map(m => m.mint)))
    : [];
  const curveByMint = new Map(curveList.map(c => [c.mint, c]));
  const nearly = bondingSurvivors
    .filter(m => { const c = curveByMint.get(m.mint); return c && !c.complete && c.progressPct >= RULES.minCurveProgressPct; })
    .sort((a, b) => curveByMint.get(b.mint)!.progressPct - curveByMint.get(a.mint)!.progressPct)
    .slice(0, MAX_BONDING_CHECK);
  const bondingReports = await mapLimit(nearly, 4, m => deps.rugReport(m.mint));
  const bondingAnalyzed: TokenCandidate[] = [];
  nearly.forEach((m, i) => {
    const r = bondingReports[i];
    if (r.status === "fulfilled") bondingAnalyzed.push(analyzeToken(m, r.value, profileByMint.get(m.mint), fx.rate, now, curveByMint.get(m.mint)));
  });
  const nearGraduation = bondingAnalyzed
    .filter(c => c.status !== "Ditolak")
    .sort((a, b) => ({ Lolos: 0, Pantau: 1, Ditolak: 2 })[a.status] - ({ Lolos: 0, Pantau: 1, Ditolak: 2 })[b.status] || (b.curve?.progressPct ?? 0) - (a.curve?.progressPct ?? 0));
  const bondingRejected = bondingAnalyzed.filter(c => c.status === "Ditolak");

  const order = { Lolos: 0, Pantau: 1, Ditolak: 2 } as const;
  const riskOrder = { Low: 0, Medium: 1, High: 2 } as const;
  analyzed.sort((a, b) =>
    order[a.status] - order[b.status] || riskOrder[a.risk] - riskOrder[b.risk] || a.unmet.length - b.unmet.length || (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  const candidates = analyzed.filter(c => c.status !== "Ditolak");
  const rejectedList = [...analyzed.filter(c => c.status === "Ditolak"), ...bondingRejected];

  return {
    generatedAt: new Date(now).toISOString(),
    usdIdr: fx.rate,
    usdIdrLive: fx.live,
    scanned: markets.length,
    prefilterRejected,
    checked: analyzed.length,
    candidates,
    nearGraduation,
    bondingScanned: bondingMarkets.length,
    rejected: rejectedList.map(c => ({ symbol: c.symbol, mint: c.mint, reason: `${c.curve ? "[pump.fun] " : ""}${c.critical ?? `Tidak memenuhi ${c.unmet.length} syarat: ${c.unmet.join(", ")}`}` })),
    rejectedCount: rejectedList.length + Object.values(prefilterRejected).reduce((a, b) => a + b, 0),
    sources,
    rules: RULES,
  };
}

let inflight: Promise<ScreeningResult> | null = null;

export type ScreeningResponse = ScreeningResult & { cached: boolean; nextScanAt: string | null; autoScanMinutes: number };

const nextScan = (generatedAt: string, minutes: number) => (minutes > 0 ? new Date(Date.parse(generatedAt) + minutes * 60_000).toISOString() : null);

/**
 * Returns the latest screening. A new scan runs only when `force` is set (manual,
 * password-confirmed) or automatic scanning is on and the last result is older
 * than `autoScanMinutes`. With automatic scanning off, opening the app only
 * shows the last result (or null if there has never been a scan).
 */
export async function getScreening(force = false, trigger: ScanLogEntry["trigger"] = force ? "manual" : "buka"): Promise<ScreeningResponse | null> {
  const kv = getKv();
  const { autoScanMinutes } = await getAutomation();
  if (!force) {
    const last = await kv.get<ScreeningResult>(CACHE_KEY).catch(() => null);
    const fresh = last && Date.now() - Date.parse(last.generatedAt) < Math.max(autoScanMinutes, SCAN_CACHE_MINUTES) * 60_000;
    if (last && (autoScanMinutes === 0 || fresh)) return { ...last, cached: true, nextScanAt: nextScan(last.generatedAt, autoScanMinutes), autoScanMinutes };
    if (autoScanMinutes === 0) return null;
  }
  if (!inflight) {
    inflight = runScreening().finally(() => { inflight = null; });
  }
  const fresh = await inflight;
  // Keep the last good result (no expiry: it is shown when automatic scanning is off).
  if (fresh.sources.some(s => s.ok && s.count > 0)) await kv.set(CACHE_KEY, fresh).catch(() => undefined);
  const entry: ScanLogEntry = {
    at: fresh.generatedAt,
    scanned: fresh.scanned,
    lolos: fresh.candidates.filter(c => c.status === "Lolos").length,
    pantau: fresh.candidates.filter(c => c.status === "Pantau").length,
    ditolak: fresh.rejectedCount,
    sourcesOk: fresh.sources.filter(s => s.ok).length,
    sourcesTotal: fresh.sources.length,
    trigger,
  };
  const log = await getScanLog();
  if (log[0]?.at !== entry.at) await kv.set(LOG_KEY, [entry, ...log].slice(0, 30)).catch(() => undefined);
  return { ...fresh, cached: false, nextScanAt: nextScan(fresh.generatedAt, autoScanMinutes), autoScanMinutes };
}

/** Finds a candidate in the stored result without triggering a scan. */
export async function findCandidate(mint: string) {
  const last = await getKv().get<ScreeningResult>(CACHE_KEY).catch(() => null);
  return last?.candidates.find(c => c.mint === mint) ?? last?.nearGraduation?.find(c => c.mint === mint) ?? null;
}
