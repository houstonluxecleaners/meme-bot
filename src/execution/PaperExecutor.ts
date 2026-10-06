import { config, type Config } from "../config.js";
import { type Fill, type Quote, SOL } from "../shared/types.js";
import { type ExecutionAdapter, type Order } from "./ExecutionAdapter.js";
function safe(n: bigint): number {
  const value = Number(n);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid simulated amount");
  return value;
}
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
export class PaperExecutor implements ExecutionAdapter {
  readonly mode = "paper" as const;
  constructor(readonly c: Config = config) {}
  estimateSell(quantityRaw: string, q: Quote): Fill {
    return this.sell(quantityRaw, q);
  }
  async execute(order: Order): Promise<Fill> {
    return order.side === "BUY"
      ? this.buy(order.budgetLamports, order.quote)
      : this.sell(order.quantityRaw, order.quote);
  }
  private validate(q: Quote): void {
    if (
      Date.now() - q.timestamp > this.c.maxDataAgeMs ||
      q.timestamp > Date.now() + 1000 ||
      BigInt(q.baseReserve) <= 0n ||
      BigInt(q.quoteReserve) <= 0n ||
      !Number.isInteger(q.feeBps) ||
      q.feeBps < 0 ||
      q.feeBps >= 10000
    )
      throw new Error("Invalid or stale quote");
  }
  buy(budgetLamports: number, q: Quote): Fill {
    this.validate(q);
    if (!Number.isSafeInteger(budgetLamports) || budgetLamports <= 0)
      throw new Error("Invalid budget");
    const overhead =
      this.c.transactionFeeLamports +
      this.c.priorityFeeLamports +
      this.c.accountRentLamports;
    const available = BigInt(budgetLamports - overhead);
    if (available <= 0n) throw new Error("Budget below costs");
    const input = (available * 10000n) / BigInt(10000 + q.feeBps);
    const fee = ceilDiv(input * BigInt(q.feeBps), 10000n);
    const base = BigInt(q.baseReserve),
      quote = BigInt(q.quoteReserve);
    // Constant-product impact, then additional adverse slippage. Real reserves cap fills.
    const amount =
      (((base * input) / (quote + input)) *
        BigInt(10000 - this.c.slippageBps)) /
      10000n;
    if (amount <= 0n || amount > BigInt(q.realBaseReserve))
      throw new Error("Insufficient real liquidity");
    const debit = safe(input + fee) + overhead;
    return {
      quantityRaw: amount.toString(),
      grossLamports: safe(input),
      feeLamports: safe(fee) + overhead,
      cashLamports: -debit,
      price: safe(input) / SOL / (Number(amount) / 10 ** q.decimals),
      quote: q,
    };
  }
  sell(quantityRaw: string, q: Quote): Fill {
    this.validate(q);
    const amount = BigInt(quantityRaw);
    if (amount <= 0n) throw new Error("Invalid quantity");
    const base = BigInt(q.baseReserve),
      quote = BigInt(q.quoteReserve);
    const gross =
      (((quote * amount) / (base + amount)) *
        BigInt(10000 - this.c.slippageBps)) /
      10000n;
    if (gross > BigInt(q.realQuoteReserve))
      throw new Error("Insufficient real quote liquidity");
    const fee =
      ceilDiv(gross * BigInt(q.feeBps), 10000n) +
      BigInt(this.c.transactionFeeLamports + this.c.priorityFeeLamports);
    if (fee >= gross) throw new Error("Proceeds below costs");
    return {
      quantityRaw,
      grossLamports: safe(gross),
      feeLamports: safe(fee),
      cashLamports: safe(gross - fee),
      price: safe(gross) / SOL / (Number(amount) / 10 ** q.decimals),
      quote: q,
    };
  }
}
