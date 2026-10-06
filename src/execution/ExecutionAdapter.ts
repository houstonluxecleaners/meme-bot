import { type Fill, type Quote } from "../shared/types.js";
export type Order =
  | { side: "BUY"; budgetLamports: number; quote: Quote }
  | { side: "SELL"; quantityRaw: string; quote: Quote };
export interface ExecutionAdapter {
  readonly mode: "paper" | "live";
  /** Pure valuation: MUST NOT place an order or perform wallet execution. */
  estimateSell(quantityRaw: string, quote: Quote): Fill;
  /** V1 supplies only PaperExecutor. A future adapter can execute asynchronously. */
  execute(order: Order): Promise<Fill>;
}
