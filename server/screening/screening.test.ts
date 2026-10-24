import { afterEach, describe, expect, it } from "vitest";
import { createMemoryKv, setKvForTests } from "../kv";
import { analyzeToken, prefilter, sparkFromChanges } from "./analyze";
import { runScreening, type ScreeningDeps } from "./index";
import { parseDexPairs, parseDexProfiles, parseGeckoNewPools, parseRugReport, type Market } from "./sources";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const RATE = 16_000;
const MINT_A = "AAAAaaaa1111111111111111111111111111111pump";
const MINT_B = "BBBBbbbb2222222222222222222222222222222pump";
const MINT_C = "CCCCcccc3333333333333333333333333333333pump";

const pair = (mint: string, over: Record<string, unknown> = {}) => ({
  chainId: "solana",
  dexId: "pumpswap",
  url: `https://dexscreener.com/solana/pair${mint.slice(0, 4)}`,
  pairAddress: `pair${mint}`,
  baseToken: { address: mint, name: `Token ${mint.slice(0, 4)}`, symbol: mint.slice(0, 4) },
  quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
  priceUsd: "0.0000123",
  liquidity: { usd: 25_000 },
  volume: { h24: 90_000 },
  priceChange: { m5: 1, h1: 5, h6: 20, h24: 40 },
  marketCap: 12_300,
  pairCreatedAt: NOW - 3 * 3600_000,
  info: { imageUrl: "https://img/x.png", websites: [{ label: "Website", url: "https://example.org" }], socials: [{ type: "twitter", url: "https://x.com/example" }] },
  ...over,
});

const healthyReport = (mint: string, over: Record<string, unknown> = {}) => ({
  mint,
  token: { mintAuthority: null, freezeAuthority: null, supply: 1_000_000_000, decimals: 6 },
  creator: "Creator111",
  creatorBalance: 10_000_000, // 1%
  topHolders: [
    { address: "PoolVault", owner: "AmmAuthority", pct: 60, insider: false },
    ...Array.from({ length: 12 }, (_, i) => ({ address: `H${i}`, owner: `O${i}`, pct: 2, insider: false })),
  ],
  knownAccounts: { AmmAuthority: { name: "Pump Fun AMM", type: "AMM" } },
  markets: [{ pubkey: "Market1", lp: { lpLockedPct: 100 } }],
  totalHolders: 812,
  graphInsidersDetected: 0,
  insiderNetworks: [],
  risks: [{ name: "Low amount of LP Providers", level: "warn", description: "few LPs", score: 100 }],
  score_normalised: 12,
  rugged: false,
  ...over,
});

afterEach(() => setKvForTests(null));

describe("source parsers", () => {
  it("parses GeckoTerminal new pools", () => {
    const pools = parseGeckoNewPools({ data: [{ attributes: { address: "Pool1", pool_created_at: "2026-10-24T10:00:00Z" }, relationships: { base_token: { data: { id: `solana_${MINT_A}` } }, dex: { data: { id: "raydium" } } } }, { attributes: {} }] });
    expect(pools).toEqual([{ mint: MINT_A, poolAddress: "Pool1", createdAt: Date.parse("2026-10-24T10:00:00Z"), dex: "raydium" }]);
  });

  it("parses DexScreener profiles (Solana only) and pairs (most liquid, earliest age)", () => {
    expect(parseDexProfiles([{ chainId: "solana", tokenAddress: MINT_A, description: "d", links: [{ type: "twitter", url: "https://x.com/a" }] }, { chainId: "base", tokenAddress: "0x1" }])).toHaveLength(1);
    const markets = parseDexPairs([pair(MINT_A, { liquidity: { usd: 5_000 }, pairCreatedAt: NOW - 3600_000 }), pair(MINT_A, { liquidity: { usd: 30_000 }, pairCreatedAt: NOW - 600_000 }), { chainId: "solana" }]);
    expect(markets).toHaveLength(1);
    expect(markets[0]).toMatchObject({ liquidityUsd: 30_000, pairCreatedAt: NOW - 3600_000, priceUsd: 0.0000123 });
    expect(markets[0].socials).toEqual([{ label: "twitter", url: "https://x.com/example" }]);
  });

  it("tolerates a malformed RugCheck report", () => {
    const r = parseRugReport(MINT_A, { weird: true });
    expect(r).toMatchObject({ mintAuthority: null, topHolders: [], insiderNetworks: 0, risks: [] });
  });
});

describe("analysis rules", () => {
  const market = (over: Record<string, unknown> = {}) => parseDexPairs([pair(MINT_A, over)])[0] as Market;

  it("prefilter: age, price under Rp1, minimum liquidity", () => {
    expect(prefilter(market(), RATE, NOW)).toEqual({ ok: true });
    expect(prefilter(market({ pairCreatedAt: NOW - 30 * 3600_000 }), RATE, NOW)).toEqual({ ok: false, reason: "umur" });
    expect(prefilter(market({ priceUsd: "0.0001" }), RATE, NOW)).toEqual({ ok: false, reason: "harga" }); // Rp1.6
    expect(prefilter(market({ liquidity: { usd: 2_000 } }), RATE, NOW)).toEqual({ ok: false, reason: "likuiditas" });
  });

  it("passes a healthy token and excludes the AMM pool from holder concentration", () => {
    const c = analyzeToken(market(), parseRugReport(MINT_A, healthyReport(MINT_A)), undefined, RATE, NOW);
    expect(c.checks.holders.top10Pct).toBe(20);
    expect(c.status).toBe("Lolos");
    expect(c.priceIdr).toBeCloseTo(0.1968);
    expect(c.ageMinutes).toBe(180);
  });

  it("always rejects active mint/freeze authority (critical)", () => {
    const mintAuth = analyzeToken(market(), parseRugReport(MINT_A, healthyReport(MINT_A, { token: { mintAuthority: "X", freezeAuthority: null, supply: 1e9 } })), undefined, RATE, NOW);
    expect(mintAuth.status).toBe("Ditolak");
    expect(mintAuth.critical).toMatch(/Mint authority/);
  });

  it("lists a token missing 1–2 requirements as Pantau and names them", () => {
    const dev = analyzeToken(market(), parseRugReport(MINT_A, healthyReport(MINT_A, { creatorBalance: 200_000_000 })), undefined, RATE, NOW);
    expect(dev.checks.devWallet.tone).toBe("bad");
    expect(dev.status).toBe("Pantau");
    expect(dev.unmet).toEqual(["Wallet dev (dev pegang 20%)"]);
    const two = analyzeToken(market({ info: {} }), parseRugReport(MINT_A, healthyReport(MINT_A, { graphInsidersDetected: 14, insiderNetworks: [{ id: 1 }] })), undefined, RATE, NOW);
    expect(two.status).toBe("Pantau");
    expect(two.unmet).toHaveLength(2);
  });

  it("rejects a token missing more than 2 requirements", () => {
    const three = analyzeToken(market({ info: {} }), parseRugReport(MINT_A, healthyReport(MINT_A, { creatorBalance: 200_000_000, graphInsidersDetected: 14, insiderNetworks: [{ id: 1 }] })), undefined, RATE, NOW);
    expect(three.status).toBe("Ditolak");
    expect(three.unmet).toHaveLength(3);
  });

  it("puts a token without socials on watch instead of passing it", () => {
    const c = analyzeToken(market({ info: {} }), parseRugReport(MINT_A, healthyReport(MINT_A)), undefined, RATE, NOW);
    expect(c.checks.socials.tone).toBe("bad");
    expect(c.status).toBe("Pantau");
    expect(c.unmet).toEqual(["Media sosial (tanpa media sosial)"]);
  });

  it("builds a price path from change windows", () => {
    expect(sparkFromChanges(2, { m5: 0, h1: 100, h6: null, h24: 100 })).toEqual([1, 1, 2, 2]);
  });
});

describe("screening pipeline", () => {
  it("combines sources, filters, checks RugCheck and reports source health", async () => {
    setKvForTests(createMemoryKv());
    const deps: ScreeningDeps = {
      now: () => NOW,
      usdIdr: async () => ({ rate: RATE, live: true }),
      geckoPools: async () => [{ mint: MINT_B, poolAddress: "P", createdAt: NOW - 600_000, dex: "raydium" }],
      dexProfiles: async () => [{ mint: MINT_A, description: "Proyek A", links: [], icon: null }],
      dexMarkets: async mints => {
        expect(new Set(mints)).toEqual(new Set([MINT_A, MINT_B]));
        return parseDexPairs([pair(MINT_A), pair(MINT_B, { priceUsd: "0.01" })]); // B costs Rp160 → filtered
      },
      rugReport: async mint => parseRugReport(mint, healthyReport(mint)),
    };
    const result = await runScreening(deps);
    expect(result.scanned).toBe(2);
    expect(result.prefilterRejected.harga).toBe(1);
    expect(result.candidates.map(c => c.mint)).toEqual([MINT_A]);
    expect(result.candidates[0].description).toBe("Proyek A");
    expect(result.sources.every(s => s.ok)).toBe(true);
    const cached = await (await import("./index")).getScreening(false);
    expect(cached.nextScanAt).toBeDefined();
  });

  it("keeps working and reports which source failed", async () => {
    const deps: ScreeningDeps = {
      now: () => NOW,
      usdIdr: async () => ({ rate: RATE, live: false }),
      geckoPools: async () => { throw new Error("HTTP 429"); },
      dexProfiles: async () => [{ mint: MINT_C, description: null, links: [], icon: null }],
      dexMarkets: async () => parseDexPairs([pair(MINT_C)]),
      rugReport: async () => { throw new Error("timeout"); },
    };
    const result = await runScreening(deps);
    expect(result.sources.find(s => s.name.startsWith("GeckoTerminal"))).toMatchObject({ ok: false, error: "HTTP 429" });
    expect(result.sources.find(s => s.name.startsWith("RugCheck"))).toMatchObject({ ok: false });
    expect(result.candidates).toEqual([]);
  });
});
