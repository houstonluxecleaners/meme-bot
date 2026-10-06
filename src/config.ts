import { z } from "zod";
const env = z
  .object({
    SOLANA_RPC_URL: z.url().default("https://api.mainnet-beta.solana.com"),
    SOLANA_WS_URL: z.url().default("wss://api.mainnet-beta.solana.com"),
    DASHBOARD_PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
    DATABASE_PATH: z.string().default("./data/pumptrader.sqlite"),
  })
  .parse(process.env);
if (
  !env.SOLANA_RPC_URL.startsWith("https:") ||
  !env.SOLANA_WS_URL.startsWith("wss:")
)
  throw new Error("HTTPS and WSS endpoints are required");
export const config = {
  rpcUrl: env.SOLANA_RPC_URL,
  wsUrl: env.SOLANA_WS_URL,
  port: env.DASHBOARD_PORT,
  databasePath: env.DATABASE_PATH,
  startingBalanceSol: 10,
  positionSol: 0.05,
  entryScore: 75,
  maxPositions: 3,
  dailyLossSol: 1,
  stopLoss: 0.15,
  takeProfit1: 0.25,
  takeProfit2: 0.5,
  takeProfit1Fraction: 0.25,
  takeProfit2Fraction: 0.25,
  trailingStop: 0.15,
  slippageBps: 100,
  executionDelayMs: 1500,
  transactionFeeLamports: 5000,
  priorityFeeLamports: 10000,
  // Estimated first ATA creation cost per entry; rent is conservatively expensed.
  accountRentLamports: 2039280,
  maxCreatorConcentration: 0.15,
  maxTopHolderConcentration: 0.5,
  topHolderCount: 10,
  minTrades: 10,
  minUniqueBuyers: 5,
  minVolumeSol: 0.5,
  minObservationMs: 60000,
  windowMs: 30000,
  maxDataAgeMs: 15000,
  maxHolderAgeMs: 90000,
  refreshMs: 10000,
  holderRefreshMs: 60000,
  tokenTtlMs: 30 * 60000,
  maxMonitoredTokens: 100,
  rpcTimeoutMs: 15000,
  rpcMinIntervalMs: 120,
  reconnectMaxMs: 30000,
  maxCatchupPages: 10,
  catchupPageSize: 100,
  maxQueuedEvents: 1000,
  weights: {
    transactionVelocity: 18,
    uniqueBuyerGrowth: 16,
    buySellRatio: 14,
    volumeAcceleration: 14,
    priceMomentum: 14,
    holderGrowth: 10,
    creatorConcentration: 7,
    topHolderConcentration: 7,
  },
  normalization: {
    tradesPerSecond: 2,
    buyerGrowth: 1,
    volumeAcceleration: 2,
    priceMomentum: 0.15,
    holderGrowth: 0.25,
  },
} as const;
export type Config = typeof config;
export function validateConfig(c: Config): void {
  for (const [key, value] of Object.entries(c))
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0))
      throw new Error(`Invalid config: ${key}`);
  if (
    c.positionSol <= 0 ||
    c.startingBalanceSol <= 0 ||
    c.maxPositions < 1 ||
    c.entryScore > 100 ||
    c.dailyLossSol <= 0 ||
    c.windowMs <= 0 ||
    c.refreshMs <= 0
  )
    throw new Error("Invalid risk/window config");
  if (
    c.takeProfit1Fraction + c.takeProfit2Fraction >= 1 ||
    c.takeProfit1 >= c.takeProfit2 ||
    c.stopLoss >= 1 ||
    c.trailingStop >= 1 ||
    c.slippageBps >= 10000
  )
    throw new Error("Invalid exit/cost config");
  if (
    Object.values(c.weights).some((x) => !Number.isFinite(x) || x < 0) ||
    Object.values(c.weights).reduce((a, b) => a + b, 0) <= 0
  )
    throw new Error("Invalid weights");
}
validateConfig(config);
