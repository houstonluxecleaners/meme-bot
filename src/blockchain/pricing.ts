import { config } from "../config.js";
import { type Quote, type Token, SOL } from "../shared/types.js";
import {
  AMM,
  FEES,
  PUMP,
  bigintField,
  boolField,
  idls,
  stringField,
} from "./idl.js";
import {
  ZERO,
  WSOL,
  addressBytes,
  mintInfo,
  pda,
  readAccount,
  vaultInfo,
} from "./rpc.js";
export function effectiveQuote(raw: bigint, virtual: bigint): bigint {
  const result = raw + virtual;
  if (result <= 0n) throw new Error("Nonpositive effective quote reserves");
  return result;
}
export function price(base: bigint, quote: bigint, decimals: number): number {
  if (base <= 0n || quote <= 0n) throw new Error("Invalid reserves");
  const p = Number(quote) / SOL / (Number(base) / 10 ** decimals);
  if (!Number.isFinite(p) || p <= 0) throw new Error("Invalid price");
  return p;
}
function b(
  data: Record<string, unknown>,
  key: string,
  fallback?: bigint,
): bigint {
  return data[key] === undefined && fallback !== undefined
    ? fallback
    : bigintField(data[key]);
}
function feeTotal(value: unknown): number {
  if (!value || typeof value !== "object")
    throw new Error("Invalid fee struct");
  const f = value as Record<string, unknown>;
  const total = Number(
    b(f, "lp_fee_bps") + b(f, "protocol_fee_bps") + b(f, "creator_fee_bps"),
  );
  if (!Number.isFinite(total) || total < 0 || total >= 10000)
    throw new Error("Invalid fees");
  return total;
}
export function tierFees(tiers: unknown, cap: bigint): number {
  if (!Array.isArray(tiers) || !tiers.length)
    throw new Error("Missing fee tiers");
  const values = tiers.map((v) => {
    if (!v || typeof v !== "object") throw new Error("Invalid tier");
    const t = v as Record<string, unknown>;
    return {
      threshold: b(t, "market_cap_lamports_threshold"),
      fees: feeTotal(t.fees),
    };
  });
  for (let i = 1; i < values.length; i++)
    if (values[i]!.threshold < values[i - 1]!.threshold)
      throw new Error("Unsorted fee tiers");
  return (
    [...values].reverse().find((t) => cap >= t.threshold)?.fees ??
    values[0]!.fees
  );
}
const feeCache = new Map<
  string,
  { at: number; data: Record<string, unknown> }
>();
async function fees(
  program: string,
  cap: bigint,
  canonical: boolean,
): Promise<number> {
  let cached = feeCache.get(program);
  if (!cached || Date.now() - cached.at > 60000) {
    const key = await pda(FEES, ["fee_config", addressBytes(program)]);
    const { data } = await readAccount(key, FEES, idls.pump_fees, "FeeConfig");
    cached = { at: Date.now(), data };
    feeCache.set(program, cached);
  }
  // Fail closed if dynamic fee config cannot be fetched. Do not silently use obsolete flat fees.
  return canonical
    ? tierFees(cached.data.fee_tiers, cap)
    : feeTotal(cached.data.flat_fees);
}
export async function fetchQuote(token: Token): Promise<Quote> {
  const startedAt = Date.now();
  const mint = await mintInfo(token.mint);
  const curve = await readAccount(token.curve, PUMP, idls.pump, "BondingCurve");
  const d = curve.data;
  token.complete = boolField(d.complete);
  let base = b(d, "virtual_token_reserves"),
    quote = b(d, "virtual_quote_reserves");
  let realBase = b(d, "real_token_reserves"),
    realQuote = b(d, "real_quote_reserves");
  let slot = curve.slot;
  let vaultOwners = [token.curve];
  let venue: Quote["venue"] = "pump";
  let canonical = true;
  const quoteMint =
    d.quote_mint === undefined ? ZERO : stringField(d.quote_mint);
  if (quoteMint !== ZERO && quoteMint !== WSOL)
    throw new Error("V1 accepts only SOL-paired tokens");
  if (d.is_mayhem_mode === true)
    throw new Error("Mayhem tokens are not supported by this estimator");
  if (token.complete) {
    venue = "pumpswap";
    if (!token.pool) {
      const authority = await pda(PUMP, [
        "pool-authority",
        addressBytes(token.mint),
      ]);
      token.pool = await pda(AMM, [
        "pool",
        new Uint8Array([0, 0]),
        addressBytes(authority),
        addressBytes(token.mint),
        addressBytes(WSOL),
      ]);
    }
    const pool = await readAccount(token.pool, AMM, idls.pump_amm, "Pool");
    if (
      pool.data.base_mint !== token.mint ||
      pool.data.quote_mint !== WSOL ||
      pool.data.is_mayhem_mode === true
    )
      throw new Error("Unsupported pool");
    const baseVault = await vaultInfo(
      stringField(pool.data.pool_base_token_account),
      token.mint,
    );
    const quoteVault = await vaultInfo(
      stringField(pool.data.pool_quote_token_account),
      WSOL,
    );
    if (baseVault.owner !== token.pool || quoteVault.owner !== token.pool)
      throw new Error("Unexpected vault owner");
    if (
      Math.max(pool.slot, baseVault.slot, quoteVault.slot) -
        Math.min(pool.slot, baseVault.slot, quoteVault.slot) >
      32
    )
      throw new Error("Inconsistent reserve slots");
    base = baseVault.amount;
    quote = effectiveQuote(
      quoteVault.amount,
      b(pool.data, "virtual_quote_reserves", 0n),
    );
    realBase = base;
    realQuote = quoteVault.amount;
    slot = Math.max(pool.slot, baseVault.slot, quoteVault.slot);
    vaultOwners = [token.curve, token.pool];
    canonical =
      pool.data.creator ===
      (await pda(PUMP, ["pool-authority", addressBytes(token.mint)]));
  }
  if (base <= 0n || quote <= 0n || realBase < 0n || realQuote < 0n)
    throw new Error("Invalid reserves");
  const feeBps = await fees(
    venue === "pump" ? PUMP : AMM,
    (quote * mint.supply) / base,
    canonical,
  );
  const result: Quote = {
    mint: token.mint,
    venue,
    timestamp: startedAt,
    slot,
    price: price(base, quote, mint.decimals),
    baseReserve: base.toString(),
    quoteReserve: quote.toString(),
    realBaseReserve: realBase.toString(),
    realQuoteReserve: realQuote.toString(),
    supply: mint.supply.toString(),
    decimals: mint.decimals,
    feeBps,
    vaultOwners,
  };
  if (Date.now() - result.timestamp > config.maxDataAgeMs)
    throw new Error("Stale quote");
  return result;
}
