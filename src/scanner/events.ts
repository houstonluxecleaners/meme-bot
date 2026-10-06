import {
  decode,
  idls,
  PUMP,
  AMM,
  addressField,
  bigintField,
  boolField,
  stringField,
  timestamp,
} from "../blockchain/idl.js";
import { ZERO, WSOL } from "../blockchain/rpc.js";
import { price } from "../blockchain/pricing.js";
import { type Token, type Activity, SOL } from "../shared/types.js";
export class UnsupportedTokenError extends Error {}
export interface ChainEvent {
  program: string;
  name: string;
  data: Record<string, unknown>;
  index: number;
}
export function decodeLogs(logs: string[]): ChainEvent[] {
  const stack: string[] = [];
  const out: ChainEvent[] = [];
  for (const [index, line] of logs.entries()) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    const done = /^Program (\w+) (?:success|failed:.*)$/.exec(line);
    if (done) {
      if (stack.at(-1) !== done[1])
        throw new Error("Invalid program log nesting");
      stack.pop();
      continue;
    }
    const active = stack.at(-1);
    if (
      (active === PUMP || active === AMM) &&
      line.startsWith("Program data: ")
    ) {
      const raw = line.slice(14);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length > 100000)
        throw new Error("Invalid event encoding");
      const bytes = Buffer.from(raw, "base64");
      const idl = active === PUMP ? idls.pump : idls.pump_amm;
      const definition = idl.events.find((e) =>
        bytes.subarray(0, 8).equals(Buffer.from(e.discriminator)),
      );
      if (
        !definition ||
        !["CreateEvent", "TradeEvent", "BuyEvent", "SellEvent"].includes(
          definition.name,
        )
      )
        continue;
      const decoded = decode(bytes, idl, "events");
      out.push({ program: active, ...decoded, index });
    }
  }
  return out;
}
export function createToken(
  d: Record<string, unknown>,
  now = Date.now(),
): Token {
  const mint = addressField(d.mint),
    creator = addressField(d.creator),
    curve = addressField(d.bonding_curve),
    createdAt = timestamp(d.timestamp);
  const base = bigintField(d.virtual_token_reserves),
    quote = bigintField(d.virtual_sol_reserves),
    supply = bigintField(d.token_total_supply);
  const marketCap =
    base > 0n ? Number((quote * supply) / base) / SOL : undefined;
  const quoteMint =
    d.quote_mint === undefined ? ZERO : addressField(d.quote_mint);
  return {
    mint,
    name: stringField(d.name).slice(0, 128),
    symbol: stringField(d.symbol).slice(0, 32),
    creator,
    curve,
    createdAt,
    discoveredAt: now,
    initialMarketCapSol:
      quoteMint === ZERO || quoteMint === WSOL ? marketCap : undefined,
    complete: false,
    activities: [],
    buyCount: 0,
    sellCount: 0,
    volumeSol: 0,
    uniqueBuyers: [],
    score: 0,
    reasons: ["OBSERVATION_PERIOD"],
  };
}
export function activity(e: ChainEvent, id: string, token: Token): Activity {
  const d = e.data;
  const buy =
    e.name === "TradeEvent" ? boolField(d.is_buy) : e.name === "BuyEvent";
  const quoteMint =
    d.quote_mint === undefined ? ZERO : addressField(d.quote_mint);
  if (quoteMint !== ZERO && quoteMint !== WSOL)
    throw new UnsupportedTokenError("NON_SOL_QUOTE_ASSET");
  const amount = bigintField(
    e.name === "TradeEvent"
      ? d.sol_amount
      : buy
        ? d.quote_amount_in
        : d.quote_amount_out,
  );
  const volumeSol = Number(amount) / SOL;
  if (!Number.isFinite(volumeSol) || volumeSol < 0)
    throw new Error("Invalid volume");
  const eventPrice =
    e.name === "TradeEvent"
      ? price(
          bigintField(d.virtual_token_reserves),
          bigintField(d.virtual_sol_reserves),
          token.quote?.decimals ?? 6,
        )
      : (token.quote?.price ?? 0);
  return {
    id,
    timestamp: timestamp(d.timestamp),
    buyer: addressField(d.user),
    buy,
    volumeSol,
    price: eventPrice,
  };
}
