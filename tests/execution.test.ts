import { describe, it, expect } from "vitest";
import { PaperExecutor } from "../src/execution/PaperExecutor.js";
import { quote } from "./fixtures.js";
import { config } from "../src/config.js";
describe("paper execution", () => {
  it("charges fees, impact, adverse slippage and account cost on round trip", () => {
    const e = new PaperExecutor(),
      q = quote();
    const buy = e.buy(50000000, q);
    expect(buy.cashLamports).toBeLessThan(0);
    expect(-buy.cashLamports).toBeLessThanOrEqual(50000000);
    expect(buy.feeLamports).toBeGreaterThan(config.accountRentLamports);
    const sale = e.sell(buy.quantityRaw, q);
    expect(sale.cashLamports + buy.cashLamports).toBeLessThan(0);
    expect(sale.feeLamports).toBeGreaterThan(config.transactionFeeLamports);
  });
  it("rejects stale quotes and insufficient real liquidity", () => {
    const e = new PaperExecutor();
    expect(() =>
      e.buy(50000000, quote({ timestamp: Date.now() - 60000 })),
    ).toThrow();
    expect(() => e.buy(50000000, quote({ realBaseReserve: "1" }))).toThrow();
    expect(() =>
      e.sell("1000000000000", quote({ realQuoteReserve: "1" })),
    ).toThrow();
  });
  it("rejects invalid budgets and fees", () => {
    const e = new PaperExecutor();
    expect(() => e.buy(NaN, quote())).toThrow();
    expect(() => e.buy(100, quote())).toThrow();
    expect(() => e.sell("0", quote())).toThrow();
    expect(() => e.buy(50000000, quote({ feeBps: 10000 }))).toThrow();
  });
});
