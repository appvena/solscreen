import { PublicKey } from "@solana/web3.js";

// pump.fun bonding curves: tokens trade on the curve until it is "complete",
// then they graduate (migrate) to a DEX. Progress is read straight from the
// on-chain bonding-curve account via a Solana RPC node.

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
/** Tokens sellable on the curve at launch (793.1M with 6 decimals). */
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;
const LAMPORTS_PER_SOL = 1_000_000_000;

export type CurveState = {
  mint: string;
  address: string;
  progressPct: number;
  solInCurve: number;
  complete: boolean;
};

export const rpcUrl = () => process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const pid = new PublicKey(PUMP_PROGRAM_ID);

export function bondingCurveAddress(mint: string): string | null {
  try {
    return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], pid)[0].toBase58();
  } catch {
    return null; // not a valid base58 address
  }
}

/**
 * Account layout: 8-byte discriminator, then u64 LE virtualTokenReserves,
 * virtualSolReserves, realTokenReserves, realSolReserves, tokenTotalSupply, bool complete.
 */
export function parseBondingCurve(mint: string, address: string, data: Buffer): CurveState | null {
  if (data.length < 8 + 8 * 5 + 1) return null;
  const realToken = data.readBigUInt64LE(8 + 16);
  const realSol = data.readBigUInt64LE(8 + 24);
  const complete = data.readUInt8(8 + 40) === 1;
  const sold = INITIAL_REAL_TOKEN_RESERVES - realToken;
  const pct = Number((sold * 10_000n) / INITIAL_REAL_TOKEN_RESERVES) / 100;
  return {
    mint,
    address,
    progressPct: complete ? 100 : Math.max(0, Math.min(100, pct)),
    solInCurve: Number(realSol) / LAMPORTS_PER_SOL,
    complete,
  };
}

/** Reads many curves in one `getMultipleAccounts` call per 100 mints. */
export async function fetchCurves(mints: string[]): Promise<CurveState[]> {
  const pairs = mints.map(mint => ({ mint, address: bondingCurveAddress(mint) })).filter((p): p is { mint: string; address: string } => !!p.address);
  const out: CurveState[] = [];
  for (let i = 0; i < pairs.length; i += 100) {
    const chunk = pairs.slice(i, i + 100);
    const res = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [chunk.map(c => c.address), { encoding: "base64" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = (await res.json()) as { result?: { value?: ({ data?: [string, string]; owner?: string } | null)[] }; error?: { message?: string } };
    if (json.error) throw new Error(`RPC ${json.error.message ?? "error"}`);
    (json.result?.value ?? []).forEach((acct, k) => {
      if (!acct?.data?.[0] || acct.owner !== PUMP_PROGRAM_ID) return;
      const state = parseBondingCurve(chunk[k].mint, chunk[k].address, Buffer.from(acct.data[0], "base64"));
      if (state) out.push(state);
    });
  }
  return out;
}
