import { z } from "zod";
import { config } from "../config.js";
import { PUMP, AMM, stringField } from "../blockchain/idl.js";
import { Subscriptions } from "../blockchain/subscriptions.js";
import { signatures, transactionLogs } from "../blockchain/rpc.js";
import {
  decodeLogs,
  createToken,
  activity,
  UnsupportedTokenError,
} from "./events.js";
import { type Health, type Token } from "../shared/types.js";
import { Store } from "../database/store.js";
import { log } from "../shared/logger.js";
interface Envelope {
  program: string;
  signature: string;
  logs: string[];
  slot: number;
}
export class Scanner {
  readonly tokens = new Map<string, Token>();
  readonly health: Health = {
    rpc: false,
    websocket: false,
    caughtUp: false,
    lastEventAt: null,
    error: null,
  };
  private queue: Envelope[] = [];
  private processing = false;
  private syncing = false;
  private stopped = false;
  private overflow = false;
  private readonly seen: Set<string>;
  private readonly subscriptions: Subscriptions;
  constructor(readonly store: Store) {
    const open = new Set(store.positions().map((p) => p.mint));
    for (const t of store.tokens())
      if (open.has(t.mint) || Date.now() - t.discoveredAt < config.tokenTtlMs)
        this.tokens.set(t.mint, t);
    this.seen = new Set(store.getState<string[]>("seenSignatures") ?? []);
    this.subscriptions = new Subscriptions(
      (program, signature, logs, slot) => {
        if (this.queue.length >= config.maxQueuedEvents) {
          this.health.caughtUp = false;
          this.health.error = "EVENT_QUEUE_OVERFLOW";
          this.overflow = true;
          return;
        }
        this.queue.push({ program, signature, logs, slot });
        if (!this.syncing) void this.drain();
      },
      (online) => {
        this.health.websocket = online;
        this.health.caughtUp = false;
        if (online) void this.catchup();
      },
    );
  }
  start(): void {
    this.subscriptions.start();
  }
  private async catchup(): Promise<void> {
    if (this.syncing || this.stopped) return;
    this.syncing = true;
    const cursors = new Map(
      [PUMP, AMM].map((program) => [
        program,
        this.store.getState<{ signature: string; slot: number }>(
          `cursor:${program}`,
        ),
      ]),
    );
    try {
      for (const program of [PUMP, AMM]) {
        const cursor = this.store.getState<{ signature: string; slot: number }>(
          `cursor:${program}`,
        );
        const collected: { signature: string; err: unknown; slot: number }[] =
          [];
        let before: string | undefined;
        let found = !cursor;
        for (let page = 0; page < config.maxCatchupPages; page++) {
          const rows = await signatures(program, before);
          if (!cursor) {
            if (rows[0]) this.store.setState(`cursor:${program}`, rows[0]);
            break;
          }
          const index = rows.findIndex((r) => r.signature === cursor.signature);
          collected.push(...(index >= 0 ? rows.slice(0, index) : rows));
          if (index >= 0) {
            found = true;
            break;
          }
          if (rows.length === 0) break;
          before = rows.at(-1)!.signature;
        }
        if (!found) throw new Error("CATCHUP_LIMIT_EXCEEDED");
        for (const row of collected.reverse()) {
          if (row.err !== null) continue;
          const tx = await transactionLogs(row.signature);
          if (!tx) throw new Error("CATCHUP_TRANSACTION_UNAVAILABLE");
          if (
            !this.process({
              program,
              signature: row.signature,
              logs: tx.logs,
              slot: tx.slot,
            })
          )
            throw new Error("INVALID_CATCHUP_EVENT");
        }
      }
      this.health.rpc = true;
      this.health.caughtUp = this.health.websocket && !this.overflow;
      this.health.error = this.overflow ? "EVENT_QUEUE_OVERFLOW" : null;
    } catch (error) {
      for (const [program, cursor] of cursors)
        if (cursor) this.store.setState(`cursor:${program}`, cursor);
      this.health.rpc = false;
      this.health.error =
        error instanceof Error &&
        [
          "CATCHUP_LIMIT_EXCEEDED",
          "CATCHUP_TRANSACTION_UNAVAILABLE",
          "INVALID_CATCHUP_EVENT",
        ].includes(error.message)
          ? error.message
          : "CATCHUP_RPC_FAILED";
      log(
        "warn",
        "Catch-up failed; entries disabled until a complete reconnect catch-up",
        { reason: this.health.error },
      );
    } finally {
      this.syncing = false;
      await this.drain();
    }
  }
  private async drain(): Promise<void> {
    if (this.processing || this.syncing || this.stopped) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        this.process(item);
      }
    } finally {
      this.processing = false;
    }
  }
  private process(item: Envelope): boolean {
    const key = `${item.program}:${item.signature}`;
    if (this.seen.has(key)) return true;
    try {
      const events = decodeLogs(item.logs);
      for (const e of events) {
        if (e.program !== item.program) continue;
        if (e.name === "CreateEvent") {
          const token = createToken(e.data);
          if (
            !this.tokens.has(token.mint) &&
            this.tokens.size < config.maxMonitoredTokens
          ) {
            this.tokens.set(token.mint, token);
            this.store.token(token);
          }
        } else if (["TradeEvent", "BuyEvent", "SellEvent"].includes(e.name)) {
          const token =
            e.name === "TradeEvent"
              ? this.tokens.get(stringField(e.data.mint))
              : [...this.tokens.values()].find((t) => t.pool === e.data.pool);
          if (!token) continue;
          let a;
          try {
            a = activity(e, `${item.signature}:${e.index}`, token);
          } catch (error) {
            if (error instanceof UnsupportedTokenError) {
              token.error = error.message;
              this.store.token(token);
              continue;
            }
            throw error;
          }
          if (token.activities.some((v) => v.id === a.id)) continue;
          token.activities.push(a);
          token.activities = token.activities
            .filter((v) => v.timestamp > Date.now() - 2 * config.windowMs)
            .sort((a, b) => a.timestamp - b.timestamp);
          if (a.buy) {
            token.buyCount++;
            if (!token.uniqueBuyers.includes(a.buyer))
              token.uniqueBuyers.push(a.buyer);
          } else token.sellCount++;
          token.volumeSol += a.volumeSol;
          this.store.token(token);
        }
      }
      this.health.lastEventAt = Date.now();
      this.seen.add(key);
      if (this.seen.size > 2000)
        this.seen.delete(this.seen.values().next().value!);
      this.store.setState("seenSignatures", [...this.seen]);
      const cursor = this.store.getState<{ slot: number }>(
        `cursor:${item.program}`,
      );
      if (
        (this.syncing || this.health.caughtUp) &&
        (!cursor || item.slot >= cursor.slot)
      )
        this.store.setState(`cursor:${item.program}`, {
          signature: item.signature,
          slot: item.slot,
        });
      return true;
    } catch (error) {
      this.health.caughtUp = false;
      this.health.error = "INVALID_CHAIN_EVENT";
      log("warn", "Invalid blockchain event; entries disabled", {
        diagnostic:
          error instanceof z.ZodError
            ? error.issues.map((i) => ({ code: i.code, path: i.path }))
            : error instanceof Error &&
                /^(Invalid |Truncated |Unsupported |Missing |Unknown |Oversized )/.test(
                  error.message,
                )
              ? error.message.slice(0, 120)
              : "VALIDATION_OR_STORAGE_ERROR",
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : undefined,
      });
      return false;
    }
  }
  prune(): void {
    const open = new Set(this.store.positions().map((p) => p.mint));
    for (const [mint, t] of this.tokens)
      if (!open.has(mint) && Date.now() - t.discoveredAt > config.tokenTtlMs)
        this.tokens.delete(mint);
  }
  stop(): void {
    this.stopped = true;
    this.subscriptions.stop();
  }
}
