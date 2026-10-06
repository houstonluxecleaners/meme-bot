import { config, type Config } from "../config.js";
import { type Token } from "../shared/types.js";
export function momentum(
  token: Token,
  now = Date.now(),
  c: Config = config,
): { score: number; components: Record<string, number> } {
  const current = token.activities.filter(
    (a) => a.timestamp > now - c.windowMs && a.timestamp <= now,
  );
  const previous = token.activities.filter(
    (a) =>
      a.timestamp > now - 2 * c.windowMs && a.timestamp <= now - c.windowMs,
  );
  const buyers = new Set(current.filter((a) => a.buy).map((a) => a.buyer));
  const oldBuyers = new Set(previous.filter((a) => a.buy).map((a) => a.buyer));
  const newBuyers = [...buyers].filter((b) => !oldBuyers.has(b)).length;
  const volume = current.reduce((s, a) => s + a.volumeSol, 0),
    oldVolume = previous.reduce((s, a) => s + a.volumeSol, 0);
  const buys = current.filter((a) => a.buy).length;
  const prices = current.filter((a) => a.price > 0);
  const first = prices[0]?.price,
    last = prices.at(-1)?.price;
  const clamp = (n: number) =>
    Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  const holderGrowth =
    token.holders && token.previousHolders
      ? (token.holders.count - token.previousHolders.count) /
        Math.max(1, token.previousHolders.count)
      : 0;
  const components = {
    transactionVelocity: clamp(
      current.length / (c.windowMs / 1000) / c.normalization.tradesPerSecond,
    ),
    uniqueBuyerGrowth: clamp(
      newBuyers / Math.max(1, oldBuyers.size) / c.normalization.buyerGrowth,
    ),
    buySellRatio: clamp(buys / Math.max(1, current.length)),
    volumeAcceleration:
      oldVolume > 0
        ? clamp((volume / oldVolume - 1) / c.normalization.volumeAcceleration)
        : 0,
    priceMomentum:
      first && last
        ? clamp((last / first - 1) / c.normalization.priceMomentum)
        : 0,
    holderGrowth: clamp(holderGrowth / c.normalization.holderGrowth),
    creatorConcentration: clamp(
      1 - (token.holders?.creatorFraction ?? 1) / c.maxCreatorConcentration,
    ),
    topHolderConcentration: clamp(
      1 - (token.holders?.topFraction ?? 1) / c.maxTopHolderConcentration,
    ),
  };
  const sum = Object.values(c.weights).reduce((a, b) => a + b, 0);
  const score =
    (Object.entries(components).reduce(
      (s, [k, v]) => s + v * c.weights[k as keyof typeof c.weights],
      0,
    ) /
      sum) *
    100;
  return { score: Math.round(score * 100) / 100, components };
}
