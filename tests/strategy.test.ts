import { describe, it, expect } from "vitest";
import { momentum } from "../src/strategy/momentum.js";
import { filterReasons } from "../src/strategy/filters.js";
import { nextExit } from "../src/strategy/exits.js";
import { type Position } from "../src/shared/types.js";
import { config } from "../src/config.js";
import { token, quote } from "./fixtures.js";
const position = (): Position => ({
  id: 1,
  mint: "test",
  openedAt: 0,
  initialRaw: "1000",
  remainingRaw: "1000",
  entryPrice: 1,
  costLamports: 10000000,
  remainingCostLamports: 10000000,
  realizedLamports: 0,
  tp1: false,
  tp2: false,
  highWater: 1,
});
describe("strategy", () => {
  it("uses original size for both partial exits and activates trailing only after TP2", () => {
    const p = position();
    expect(nextExit(p, 0.8)?.reason).toBe("STOP_LOSS");
    expect(nextExit(p, 1.3)).toEqual({ reason: "TP1", quantityRaw: "250" });
    p.tp1 = true;
    p.remainingRaw = "750";
    expect(nextExit(p, 1.6)).toEqual({ reason: "TP2", quantityRaw: "250" });
    expect(nextExit(p, 1.3)).toBeNull();
    p.tp2 = true;
    p.remainingRaw = "500";
    p.highWater = 2;
    expect(nextExit(p, 1.69)).toEqual({
      reason: "TRAILING_STOP",
      quantityRaw: "500",
    });
    expect(nextExit(p, 1.8)).toBeNull();
  });
  it("rejects missing, stale, concentrated and inactive tokens", () => {
    const t = token({ quote: undefined, holders: undefined });
    expect(filterReasons(t)).toEqual(
      expect.arrayContaining([
        "UNRELIABLE_PRICE",
        "HOLDER_DATA_UNAVAILABLE",
        "LOW_ACTIVITY",
      ]),
    );
    const bad = token();
    bad.holders!.creatorFraction = 0.5;
    bad.holders!.topFraction = 0.8;
    expect(filterReasons(bad)).toContain("CREATOR_CONCENTRATION");
    expect(filterReasons(bad)).toContain("TOP_HOLDER_CONCENTRATION");
    expect(filterReasons(token({ quote: quote({ timestamp: 0 }) }))).toContain(
      "UNRELIABLE_PRICE",
    );
  });
  it("scores all components between zero and 100 and responds to configurable weights", () => {
    const now = Date.now(),
      t = token();
    for (let i = 0; i < 100; i++)
      t.activities.push({
        id: String(i),
        timestamp: now - 25000 + i * 200,
        buyer: "new" + i,
        buy: true,
        volumeSol: 0.1,
        price: 1 + i / 100,
      });
    for (let i = 0; i < 10; i++)
      t.activities.push({
        id: "old" + i,
        timestamp: now - 45000 + i * 100,
        buyer: "old" + i,
        buy: false,
        volumeSol: 0.01,
        price: 0.9,
      });
    const result = momentum(t, now);
    expect(result.score).toBeGreaterThan(75);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(Object.keys(result.components)).toHaveLength(8);
    const weights = {
      ...config.weights,
      transactionVelocity: 0,
      uniqueBuyerGrowth: 0,
      buySellRatio: 100,
      volumeAcceleration: 0,
      priceMomentum: 0,
      holderGrowth: 0,
      creatorConcentration: 0,
      topHolderConcentration: 0,
    };
    expect(
      momentum(t, now, { ...config, weights } as typeof config).score,
    ).toBe(100);
    expect(
      momentum(token({ holders: undefined, previousHolders: undefined }), now)
        .score,
    ).toBe(0);
  });
});
