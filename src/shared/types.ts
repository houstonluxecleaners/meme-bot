export type Venue = "pump" | "pumpswap";
export interface Quote {
  mint: string;
  venue: Venue;
  timestamp: number;
  slot: number;
  price: number;
  baseReserve: string;
  quoteReserve: string;
  realBaseReserve: string;
  realQuoteReserve: string;
  supply: string;
  decimals: number;
  feeBps: number;
  vaultOwners: string[];
}
export interface Activity {
  id: string;
  timestamp: number;
  buyer: string;
  buy: boolean;
  volumeSol: number;
  price: number;
}
export interface Holders {
  timestamp: number;
  count: number;
  creatorFraction: number;
  topFraction: number;
  creatorRaw: string;
}
export interface Token {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  createdAt: number;
  discoveredAt: number;
  curve: string;
  pool?: string;
  quote?: Quote;
  holders?: Holders;
  previousHolders?: Holders;
  initialMarketCapSol?: number;
  complete: boolean;
  activities: Activity[];
  buyCount: number;
  sellCount: number;
  volumeSol: number;
  uniqueBuyers: string[];
  score: number;
  reasons: string[];
  error?: string;
}
export interface Position {
  id: number;
  mint: string;
  openedAt: number;
  initialRaw: string;
  remainingRaw: string;
  entryPrice: number;
  costLamports: number;
  remainingCostLamports: number;
  realizedLamports: number;
  tp1: boolean;
  tp2: boolean;
  highWater: number;
  closedAt?: number;
}
export interface Fill {
  quantityRaw: string;
  grossLamports: number;
  feeLamports: number;
  cashLamports: number;
  price: number;
  quote: Quote;
}
export interface Exit {
  reason: "STOP_LOSS" | "TP1" | "TP2" | "TRAILING_STOP";
  quantityRaw: string;
}
export interface Health {
  rpcFailure?: string | null;
  retryAt?: number | null;
  rpc: boolean;
  websocket: boolean;
  caughtUp: boolean;
  lastEventAt: number | null;
  error: string | null;
}
export const SOL = 1e9;
export const toJson = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
