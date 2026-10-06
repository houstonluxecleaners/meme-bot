import { config } from "../config.js";
import { Store } from "../database/store.js";
import { type ExecutionAdapter } from "../execution/ExecutionAdapter.js";
import { type Health, type Quote, type Token, SOL } from "../shared/types.js";
import { momentum } from "../strategy/momentum.js";
import { filterReasons } from "../strategy/filters.js";
import { nextExit } from "../strategy/exits.js";
import { log } from "../shared/logger.js";
interface Pending {
  mint: string;
  due: number;
  positionId?: number;
  reason: string;
  quantityRaw?: string;
}
export class Engine {
  private pending = new Map<string, Pending>();
  constructor(
    readonly store: Store,
    readonly execution: ExecutionAdapter,
    readonly tokens: Map<string, Token>,
    readonly health: Health,
  ) {}
  value(): {
    unrealizedLamports: number;
    unknown: number;
    liquidationLamports: number;
  } {
    let unrealizedLamports = 0,
      unknown = 0,
      liquidationLamports = 0;
    for (const p of this.store.positions()) {
      const q = this.tokens.get(p.mint)?.quote;
      try {
        if (!q) throw new Error("No quote");
        const fill = this.execution.estimateSell(p.remainingRaw, q);
        liquidationLamports += fill.cashLamports;
        unrealizedLamports += fill.cashLamports - p.remainingCostLamports;
      } catch {
        unknown++;
      }
    }
    return { unrealizedLamports, unknown, liquidationLamports };
  }
  riskReasons(now = Date.now()): string[] {
    const reasons: string[] = [];
    const value = this.value();
    const midnight = new Date(now);
    midnight.setUTCHours(0, 0, 0, 0);
    // Conservative daily loss: realized losses today plus current open losses.
    // Profitable marks cannot offset realized losses for this gate.
    let openLoss = 0;
    for (const p of this.store.positions()) {
      const q = this.tokens.get(p.mint)?.quote;
      try {
        if (!q) throw new Error("No price");
        openLoss += Math.min(
          0,
          this.execution.estimateSell(p.remainingRaw, q).cashLamports -
            p.remainingCostLamports,
        );
      } catch {
        /* unknown valuation handled below */
      }
    }
    if (
      Math.min(0, this.store.realizedSince(midnight.getTime())) + openLoss <=
      -config.dailyLossSol * SOL
    )
      reasons.push("DAILY_LOSS_LIMIT");
    if (value.unknown) reasons.push("UNVALUED_OPEN_POSITION");
    if (!this.health.rpc || !this.health.websocket || !this.health.caughtUp)
      reasons.push("CHAIN_STREAM_UNHEALTHY");
    return reasons;
  }
  evaluate(now = Date.now()): void {
    for (const p of this.store.positions()) {
      const t = this.tokens.get(p.mint);
      if (!t?.quote || now - t.quote.timestamp > config.maxDataAgeMs) continue;
      if (p.tp2) {
        p.highWater = Math.max(p.highWater, t.quote.price);
        this.store.updatePosition(p);
      }
      if (this.pending.has(p.mint)) continue;
      const exit = nextExit(p, t.quote.price);
      if (exit) {
        this.pending.set(p.mint, {
          mint: p.mint,
          due: now + config.executionDelayMs,
          positionId: p.id,
          ...exit,
        });
        this.store.signal(p.mint, t.score, "EXIT_SCHEDULED", exit.reason);
      }
    }
    const risk = this.riskReasons(now);
    for (const t of this.tokens.values()) {
      const scored = momentum(t, now);
      t.score = scored.score;
      t.reasons = [...filterReasons(t, now), ...risk];
      this.store.token(t);
      if (
        this.pending.has(t.mint) ||
        this.store.positions().some((p) => p.mint === t.mint)
      )
        continue;
      if (t.score < config.entryScore) t.reasons.push("SCORE_BELOW_THRESHOLD");
      const reservations = [...this.pending.values()].filter(
        (p) => !p.positionId,
      ).length;
      if (this.store.positions().length + reservations >= config.maxPositions)
        t.reasons.push("POSITION_LIMIT");
      if (
        this.store.cash() <
        (reservations + 1) * Math.round(config.positionSol * SOL)
      )
        t.reasons.push("INSUFFICIENT_CASH");
      this.store.signal(
        t.mint,
        t.score,
        t.reasons.length ? "REJECT" : "ENTRY_SCHEDULED",
        t.reasons.join(",") || "MOMENTUM_ENTRY",
        scored.components,
      );
      if (!t.reasons.length)
        this.pending.set(t.mint, {
          mint: t.mint,
          due: now + config.executionDelayMs,
          reason: "MOMENTUM_ENTRY",
        });
    }
  }
  async executeDue(
    fetch: (t: Token) => Promise<Quote>,
    now = Date.now(),
  ): Promise<void> {
    for (const [mint, pending] of this.pending) {
      if (pending.due > now) continue;
      const t = this.tokens.get(mint);
      if (!t) {
        this.pending.delete(mint);
        continue;
      }
      try {
        // Fetch AFTER the execution delay; never fill using the trigger quote.
        const q = await fetch(t);
        t.quote = q;
        this.store.token(t);
        this.store.snapshot(t);
        if (pending.positionId) {
          const p = this.store
            .positions()
            .find((p) => p.id === pending.positionId);
          if (!p) throw new Error("Position no longer open");
          const fill = await this.execution.execute({
            side: "SELL",
            quantityRaw: pending.quantityRaw!,
            quote: q,
          });
          this.store.atomic(() => this.store.close(p, fill, pending.reason));
        } else {
          const reasons = [...filterReasons(t), ...this.riskReasons()];
          const scored = momentum(t);
          if (scored.score < config.entryScore) reasons.push("SCORE_CHANGED");
          if (this.store.positions().length >= config.maxPositions)
            reasons.push("POSITION_LIMIT");
          if (reasons.length) throw new Error("Entry no longer eligible");
          const fill = await this.execution.execute({
            side: "BUY",
            budgetLamports: Math.round(config.positionSol * SOL),
            quote: q,
          });
          this.store.atomic(() => this.store.open(mint, fill));
        }
        this.store.signal(mint, t.score, "FILLED", pending.reason);
        log("info", "Paper fill recorded", { mint, reason: pending.reason });
      } catch {
        this.store.signal(
          mint,
          t.score,
          "EXECUTION_FAILED",
          `${pending.reason}: data, eligibility, cash or liquidity check failed`,
        );
        log("warn", "Paper execution rejected", {
          mint,
          reason: pending.reason,
        });
      } finally {
        this.pending.delete(mint);
      }
    }
  }
}
