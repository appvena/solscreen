// Free public data sources (no API key). Every parser is defensive: fields that
// are missing or renamed upstream degrade to `null` instead of crashing.

const UA = { "User-Agent": "SolScreen/1.0 (+https://github.com/appvena/solscreen)", Accept: "application/json" };

export type SourceStatus = { name: string; ok: boolean; count: number; error?: string; ms: number };

async function getJson<T = unknown>(url: string, timeoutMs = 9000, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Runs a source call and records its health for the dashboard. */
export async function tracked<T>(name: string, statuses: SourceStatus[], fn: () => Promise<T[]>): Promise<T[]> {
  const started = Date.now();
  try {
    const items = await fn();
    statuses.push({ name, ok: true, count: items.length, ms: Date.now() - started });
    return items;
  } catch (error) {
    statuses.push({ name, ok: false, count: 0, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
    return [];
  }
}

// --- GeckoTerminal: newest Solana pools ------------------------------------
export type NewPool = { mint: string; poolAddress: string | null; createdAt: number | null; dex: string | null };

export function parseGeckoNewPools(json: unknown): NewPool[] {
  return arr(obj(json).data).flatMap(item => {
    const it = obj(item);
    const attrs = obj(it.attributes);
    const baseId = str(obj(obj(obj(it.relationships).base_token).data).id);
    const mint = baseId?.replace(/^solana_/, "");
    if (!mint) return [];
    const created = str(attrs.pool_created_at);
    return [{
      mint,
      poolAddress: str(attrs.address),
      createdAt: created ? Date.parse(created) || null : null,
      dex: str(obj(obj(obj(it.relationships).dex).data).id),
    }];
  });
}

export async function fetchGeckoNewPools(pages = 3): Promise<NewPool[]> {
  const results = await Promise.allSettled(
    Array.from({ length: pages }, (_, i) =>
      getJson(`https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=${i + 1}`, 9000, { Accept: "application/json;version=20230302" }),
    ),
  );
  const ok = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled");
  if (ok.length === 0) throw (results[0] as PromiseRejectedResult).reason;
  return ok.flatMap(r => parseGeckoNewPools(r.value));
}

/** Most active pump.fun pools on GeckoTerminal (bonding-curve tokens). */
export async function fetchGeckoPumpPools(pages = 2): Promise<NewPool[]> {
  const results = await Promise.allSettled(
    Array.from({ length: pages }, (_, i) =>
      getJson(`https://api.geckoterminal.com/api/v2/networks/solana/dexes/pump-fun/pools?page=${i + 1}&sort=h24_tx_count_desc`, 9000, { Accept: "application/json;version=20230302" }),
    ),
  );
  const ok = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled");
  if (ok.length === 0) throw (results[0] as PromiseRejectedResult).reason;
  return ok.flatMap(r => parseGeckoNewPools(r.value));
}

export const isBondingDex = (dex: string | null) => !!dex && /pump/i.test(dex) && !/swap|amm/i.test(dex);

// --- DexScreener: latest token profiles & boosts (tokens with socials) -----
export type Profile = { mint: string; description: string | null; links: { label: string; url: string }[]; icon: string | null };

export function parseDexProfiles(json: unknown): Profile[] {
  return arr(json).flatMap(item => {
    const it = obj(item);
    if (str(it.chainId) !== "solana") return [];
    const mint = str(it.tokenAddress);
    if (!mint) return [];
    const links = arr(it.links).flatMap(l => {
      const link = obj(l);
      const url = str(link.url);
      return url ? [{ label: str(link.type) ?? str(link.label) ?? "link", url }] : [];
    });
    return [{ mint, description: str(it.description), links, icon: str(it.icon) }];
  });
}

export async function fetchDexProfiles(): Promise<Profile[]> {
  const [profiles, boosts] = await Promise.allSettled([
    getJson("https://api.dexscreener.com/token-profiles/latest/v1"),
    getJson("https://api.dexscreener.com/token-boosts/latest/v1"),
  ]);
  if (profiles.status === "rejected" && boosts.status === "rejected") throw profiles.reason;
  return [
    ...(profiles.status === "fulfilled" ? parseDexProfiles(profiles.value) : []),
    ...(boosts.status === "fulfilled" ? parseDexProfiles(boosts.value) : []),
  ];
}

// --- DexScreener: market data for up to 30 mints per call ------------------
export type Market = {
  mint: string;
  name: string;
  symbol: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  change: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  pairCreatedAt: number | null;
  dexId: string | null;
  url: string | null;
  imageUrl: string | null;
  websites: { label: string; url: string }[];
  socials: { label: string; url: string }[];
};

export function parseDexPairs(json: unknown): Market[] {
  // Several pairs per token: keep the most liquid one.
  const best = new Map<string, Market>();
  for (const item of arr(json)) {
    const p = obj(item);
    if (str(p.chainId) !== "solana") continue;
    const base = obj(p.baseToken);
    const mint = str(base.address);
    if (!mint) continue;
    const info = obj(p.info);
    const change = obj(p.priceChange);
    const market: Market = {
      mint,
      name: str(base.name) ?? "?",
      symbol: str(base.symbol) ?? "?",
      priceUsd: num(p.priceUsd),
      liquidityUsd: num(obj(p.liquidity).usd),
      volume24hUsd: num(obj(p.volume).h24),
      marketCapUsd: num(p.marketCap) ?? num(p.fdv),
      change: { m5: num(change.m5), h1: num(change.h1), h6: num(change.h6), h24: num(change.h24) },
      pairCreatedAt: num(p.pairCreatedAt),
      dexId: str(p.dexId),
      url: str(p.url),
      imageUrl: str(info.imageUrl),
      websites: arr(info.websites).flatMap(w => { const o = obj(w); const url = str(o.url); return url ? [{ label: str(o.label) ?? "Website", url }] : []; }),
      socials: arr(info.socials).flatMap(s => { const o = obj(s); const url = str(o.url); return url ? [{ label: str(o.type) ?? str(o.platform) ?? "social", url }] : []; }),
    };
    const prev = best.get(mint);
    if (!prev || (market.liquidityUsd ?? 0) > (prev.liquidityUsd ?? 0)) {
      // Earliest pair creation = token age.
      if (prev?.pairCreatedAt && (!market.pairCreatedAt || prev.pairCreatedAt < market.pairCreatedAt)) market.pairCreatedAt = prev.pairCreatedAt;
      best.set(mint, market);
    } else if (market.pairCreatedAt && (!prev.pairCreatedAt || market.pairCreatedAt < prev.pairCreatedAt)) {
      prev.pairCreatedAt = market.pairCreatedAt;
    }
  }
  return [...best.values()];
}

export async function fetchDexMarkets(mints: string[]): Promise<Market[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));
  const results = await Promise.allSettled(chunks.map(c => getJson(`https://api.dexscreener.com/tokens/v1/solana/${c.join(",")}`)));
  const ok = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled");
  if (chunks.length > 0 && ok.length === 0) throw (results[0] as PromiseRejectedResult).reason;
  return ok.flatMap(r => parseDexPairs(r.value));
}

// --- RugCheck: authorities, holders, insiders, creator ---------------------
export type RiskFlag = { name: string; level: string; description: string | null; value: string | null };
export type RugReport = {
  mint: string;
  scoreNormalised: number | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  creator: string | null;
  creatorPct: number | null;
  topHolders: { address: string; owner: string | null; pct: number; insider: boolean }[];
  totalHolders: number | null;
  insiderNetworks: number;
  insidersDetected: number;
  lpLockedPct: number | null;
  rugged: boolean;
  risks: RiskFlag[];
  ammAccounts: Set<string>;
};

export function parseRugReport(mint: string, json: unknown): RugReport {
  const r = obj(json);
  const token = obj(r.token);
  const supply = num(token.supply);
  const known = obj(r.knownAccounts);
  const ammAccounts = new Set<string>();
  for (const [address, meta] of Object.entries(known)) {
    const type = String(obj(meta).type ?? "").toUpperCase();
    if (type.includes("AMM") || type.includes("LOCKER") || type.includes("POOL")) ammAccounts.add(address);
  }
  const markets = arr(r.markets).map(obj);
  for (const m of markets) {
    for (const key of ["pubkey", "liquidityA", "liquidityB", "liquidityAAccount", "liquidityBAccount"]) {
      const v = str(m[key]);
      if (v) ammAccounts.add(v);
    }
  }
  const lpPcts = markets.map(m => num(obj(m.lp).lpLockedPct)).filter((v): v is number => v !== null);
  const creatorBalance = num(r.creatorBalance);
  return {
    mint,
    scoreNormalised: num(r.score_normalised),
    mintAuthority: str(token.mintAuthority),
    freezeAuthority: str(token.freezeAuthority),
    creator: str(r.creator),
    creatorPct: creatorBalance !== null && supply ? (creatorBalance / supply) * 100 : null,
    topHolders: arr(r.topHolders).flatMap(h => {
      const o = obj(h);
      const address = str(o.address);
      const pct = num(o.pct);
      return address && pct !== null ? [{ address, owner: str(o.owner), pct, insider: o.insider === true }] : [];
    }),
    totalHolders: num(r.totalHolders),
    insiderNetworks: arr(r.insiderNetworks).length,
    insidersDetected: num(r.graphInsidersDetected) ?? 0,
    lpLockedPct: lpPcts.length ? Math.max(...lpPcts) : null,
    rugged: r.rugged === true,
    risks: arr(r.risks).map(x => {
      const o = obj(x);
      return { name: str(o.name) ?? "?", level: (str(o.level) ?? "info").toLowerCase(), description: str(o.description), value: str(o.value) };
    }),
    ammAccounts,
  };
}

export async function fetchRugReport(mint: string): Promise<RugReport> {
  return parseRugReport(mint, await getJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, 10000));
}

/** Runs async work with a small concurrency limit (be polite to free APIs). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = { status: "fulfilled", value: await fn(items[i]) };
        } catch (reason) {
          results[i] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}

// --- USD → IDR -----------------------------------------------------------
export const FALLBACK_USD_IDR = 16_300;

export async function fetchUsdIdr(): Promise<{ rate: number; live: boolean }> {
  try {
    const json = obj(await getJson("https://open.er-api.com/v6/latest/USD", 6000));
    const rate = num(obj(json.rates).IDR);
    if (rate && rate > 1000) return { rate, live: true };
  } catch {
    // fall through
  }
  return { rate: FALLBACK_USD_IDR, live: false };
}
