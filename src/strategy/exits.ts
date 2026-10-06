import { config, type Config } from "../config.js";
import { type Exit, type Position } from "../shared/types.js";
export function nextExit(
  p: Position,
  price: number,
  c: Config = config,
): Exit | null {
  if (!Number.isFinite(price) || price <= 0 || p.entryPrice <= 0)
    throw new Error("Invalid exit price");
  const remaining = BigInt(p.remainingRaw);
  if (remaining <= 0n) return null;
  const gain = price / p.entryPrice - 1;
  if (gain <= -c.stopLoss)
    return { reason: "STOP_LOSS", quantityRaw: p.remainingRaw };
  const portion = (f: number) => {
    const n =
      (BigInt(p.initialRaw) * BigInt(Math.round(f * 1000000))) / 1000000n;
    return (n < remaining ? n : remaining).toString();
  };
  // TP1 and TP2 each sell a fraction of ORIGINAL quantity, not remaining quantity.
  if (!p.tp1 && gain >= c.takeProfit1)
    return { reason: "TP1", quantityRaw: portion(c.takeProfit1Fraction) };
  if (p.tp1 && !p.tp2 && gain >= c.takeProfit2)
    return { reason: "TP2", quantityRaw: portion(c.takeProfit2Fraction) };
  if (p.tp2 && price <= p.highWater * (1 - c.trailingStop))
    return { reason: "TRAILING_STOP", quantityRaw: p.remainingRaw };
  return null;
}
