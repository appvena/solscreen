import { getKv } from "./kv";

// Anthropic has no API to read the prepaid credit balance, so SolScreen meters
// its own calls: token usage from every response × the published price list.
// Prices (USD per million tokens) from platform.claude.com/docs/en/about-claude/pricing.
export const PRICES: Record<string, { input: number; output: number; longInput?: number; longOutput?: number; longThreshold?: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longInput: 0.5, longOutput: 2.5, longThreshold: 100_000 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};
export const WEB_SEARCH_USD = 10 / 1000;

export type CallUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
};

export function estimateCostUsd(u: CallUsage): number {
  const price = PRICES[u.model] ?? Object.entries(PRICES).find(([k]) => u.model.startsWith(k))?.[1] ?? PRICES["claude-sonnet-5-5"];
  const promptTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const long = price.longThreshold !== undefined && promptTokens > price.longThreshold;
  const inRate = long ? price.longInput! : price.input;
  const outRate = long ? price.longOutput! : price.output;
  // Cache reads ~0.1×, cache writes ~1.25× input price.
  const input = (u.inputTokens + u.cacheReadTokens * 0.1 + u.cacheWriteTokens * 1.25) * inRate;
  return input / 1e6 + (u.outputTokens * outRate) / 1e6 + u.webSearches * WEB_SEARCH_USD;
}

const K = {
  cost: "solscreen:usage:costUsd",
  input: "solscreen:usage:inputTokens",
  output: "solscreen:usage:outputTokens",
  calls: "solscreen:usage:calls",
  searches: "solscreen:usage:webSearches",
  since: "solscreen:usage:since",
  balance: "solscreen:usage:balance",
  day: (d: string) => `solscreen:usage:newReviews:${d}`,
};

export async function recordUsage(u: CallUsage): Promise<number> {
  const kv = getKv();
  const cost = estimateCostUsd(u);
  await Promise.all([
    kv.incrByFloat(K.cost, cost),
    kv.incrByFloat(K.input, u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens),
    kv.incrByFloat(K.output, u.outputTokens),
    kv.incrByFloat(K.calls, 1),
    kv.incrByFloat(K.searches, u.webSearches),
    kv.get<string>(K.since).then(s => (s ? undefined : kv.set(K.since, new Date().toISOString()))),
  ]).catch(error => console.error("[Usage] gagal mencatat pemakaian", error));
  return cost;
}

type Balance = { amountUsd: number; setAt: string; costAtSet: number };

export async function setBalance(amountUsd: number) {
  const kv = getKv();
  const costAtSet = Number((await kv.get<number>(K.cost)) ?? 0);
  await kv.set<Balance>(K.balance, { amountUsd, setAt: new Date().toISOString(), costAtSet });
}

export async function getUsageSummary() {
  const kv = getKv();
  const [cost, input, output, calls, searches, since, balance] = await Promise.all([
    kv.get<number>(K.cost), kv.get<number>(K.input), kv.get<number>(K.output), kv.get<number>(K.calls),
    kv.get<number>(K.searches), kv.get<string>(K.since), kv.get<Balance>(K.balance),
  ]);
  const costUsd = Number(cost ?? 0);
  const spentSinceBalance = balance ? Math.max(0, costUsd - balance.costAtSet) : null;
  return {
    persistent: kv.persistent,
    since: since ?? null,
    costUsd,
    inputTokens: Number(input ?? 0),
    outputTokens: Number(output ?? 0),
    calls: Number(calls ?? 0),
    webSearches: Number(searches ?? 0),
    balance: balance ? { amountUsd: balance.amountUsd, setAt: balance.setAt } : null,
    spentSinceBalanceUsd: spentSinceBalance,
    remainingUsd: balance && spentSinceBalance !== null ? Math.max(0, balance.amountUsd - spentSinceBalance) : null,
  };
}

/** Daily cap on new (uncached) Claude reviews — protects the prepaid credit. */
export async function takeDailyReviewSlot(limit: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const used = await getKv().incrByFloat(K.day(day), 1);
  return used <= limit;
}
