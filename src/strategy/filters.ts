import { config, type Config } from "../config.js";
import { type Token } from "../shared/types.js";
export function filterReasons(
  t: Token,
  now = Date.now(),
  c: Config = config,
): string[] {
  const reasons: string[] = [];
  if (t.error) reasons.push("BLOCKCHAIN_DATA_UNAVAILABLE");
  if (
    !t.quote ||
    !Number.isFinite(t.quote.price) ||
    t.quote.price <= 0 ||
    now - t.quote.timestamp > c.maxDataAgeMs
  )
    reasons.push("UNRELIABLE_PRICE");
  if (!t.holders || now - t.holders.timestamp > c.maxHolderAgeMs)
    reasons.push("HOLDER_DATA_UNAVAILABLE");
  if (t.holders && t.holders.creatorFraction > c.maxCreatorConcentration)
    reasons.push("CREATOR_CONCENTRATION");
  if (t.holders && t.holders.topFraction > c.maxTopHolderConcentration)
    reasons.push("TOP_HOLDER_CONCENTRATION");
  if (now - t.discoveredAt < c.minObservationMs)
    reasons.push("OBSERVATION_PERIOD");
  const recent = t.activities.filter(
    (a) => a.timestamp > now - 2 * c.windowMs && a.timestamp <= now,
  );
  if (
    recent.length < c.minTrades ||
    new Set(recent.filter((a) => a.buy).map((a) => a.buyer)).size <
      c.minUniqueBuyers ||
    recent.reduce((n, a) => n + a.volumeSol, 0) < c.minVolumeSol
  )
    reasons.push("LOW_ACTIVITY");
  return reasons;
}
