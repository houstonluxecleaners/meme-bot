import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import {
  type Fill,
  type Position,
  type Token,
  SOL,
  toJson,
} from "../shared/types.js";
export class Store {
  readonly db: DatabaseSync;
  constructor(path = config.databasePath) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tokens(mint TEXT PRIMARY KEY,name TEXT NOT NULL,symbol TEXT NOT NULL,creator TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS signals(id INTEGER PRIMARY KEY,mint TEXT NOT NULL REFERENCES tokens(mint),timestamp INTEGER NOT NULL,score REAL NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,components TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS positions(id INTEGER PRIMARY KEY,mint TEXT NOT NULL REFERENCES tokens(mint),opened_at INTEGER NOT NULL,closed_at INTEGER,data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_position ON positions(mint) WHERE closed_at IS NULL;
      CREATE TABLE IF NOT EXISTS paper_trades(id INTEGER PRIMARY KEY,position_id INTEGER NOT NULL REFERENCES positions(id),mint TEXT NOT NULL,timestamp INTEGER NOT NULL,side TEXT NOT NULL,quantity_raw TEXT NOT NULL,gross_lamports INTEGER NOT NULL,fee_lamports INTEGER NOT NULL,cash_lamports INTEGER NOT NULL,realized_lamports INTEGER NOT NULL,reason TEXT NOT NULL,quote TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS price_snapshots(id INTEGER PRIMARY KEY,mint TEXT NOT NULL REFERENCES tokens(mint),timestamp INTEGER NOT NULL,price_sol REAL NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_mint_time ON price_snapshots(mint,timestamp);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      PRAGMA user_version=1;`);
    if (this.getState("cash") === undefined)
      this.setState("cash", Math.round(config.startingBalanceSol * SOL));
  }
  getState<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM state WHERE key=?").get(key);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }
  setState(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, toJson(value));
  }
  cash(): number {
    return this.getState<number>("cash")!;
  }
  atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  token(t: Token): void {
    this.db
      .prepare(
        "INSERT INTO tokens VALUES(?,?,?,?,?,?) ON CONFLICT(mint) DO UPDATE SET data=excluded.data",
      )
      .run(t.mint, t.name, t.symbol, t.creator, t.createdAt, toJson(t));
  }
  tokens(): Token[] {
    return this.db
      .prepare(
        "SELECT data FROM tokens WHERE mint IN (SELECT mint FROM positions WHERE closed_at IS NULL) OR mint IN (SELECT mint FROM tokens ORDER BY created_at DESC LIMIT 500) ORDER BY created_at DESC",
      )
      .all()
      .map((r) => JSON.parse(String(r.data)) as Token);
  }
  signal(
    mint: string,
    score: number,
    action: string,
    reason: string,
    components: unknown = {},
  ): void {
    this.db
      .prepare(
        "INSERT INTO signals(mint,timestamp,score,action,reason,components) VALUES(?,?,?,?,?,?)",
      )
      .run(mint, Date.now(), score, action, reason, toJson(components));
  }
  snapshot(t: Token): void {
    if (t.quote)
      this.db
        .prepare(
          "INSERT INTO price_snapshots(mint,timestamp,price_sol,data) VALUES(?,?,?,?)",
        )
        .run(t.mint, t.quote.timestamp, t.quote.price, toJson(t.quote));
  }
  positions(openOnly = true): Position[] {
    return this.db
      .prepare(
        `SELECT data FROM positions ${openOnly ? "WHERE closed_at IS NULL" : ""}`,
      )
      .all()
      .map((r) => JSON.parse(String(r.data)) as Position);
  }
  updatePosition(p: Position): void {
    this.db
      .prepare("UPDATE positions SET data=?,closed_at=? WHERE id=?")
      .run(toJson(p), p.closedAt ?? null, p.id);
  }
  open(mint: string, fill: Fill, now = Date.now()): Position {
    const debit = -fill.cashLamports;
    if (!Number.isSafeInteger(debit) || debit <= 0 || debit > this.cash())
      throw new Error("Insufficient virtual cash");
    const row = this.db
      .prepare("INSERT INTO positions(mint,opened_at,data) VALUES(?,?,?)")
      .run(mint, now, "{}");
    const p: Position = {
      id: Number(row.lastInsertRowid),
      mint,
      openedAt: now,
      initialRaw: fill.quantityRaw,
      remainingRaw: fill.quantityRaw,
      entryPrice: fill.price,
      costLamports: debit,
      remainingCostLamports: debit,
      realizedLamports: 0,
      tp1: false,
      tp2: false,
      highWater: fill.price,
    };
    this.updatePosition(p);
    this.setState("cash", this.cash() - debit);
    this.trade(p, fill, "BUY", "MOMENTUM_ENTRY", 0, now);
    return p;
  }
  close(p: Position, fill: Fill, reason: string, now = Date.now()): void {
    const remaining = BigInt(p.remainingRaw),
      sold = BigInt(fill.quantityRaw);
    if (sold <= 0n || sold > remaining)
      throw new Error("Invalid position fill");
    const allocated =
      sold === remaining
        ? p.remainingCostLamports
        : Number((BigInt(p.remainingCostLamports) * sold) / remaining);
    const realized = fill.cashLamports - allocated;
    p.remainingCostLamports -= allocated;
    p.realizedLamports += realized;
    p.remainingRaw = (remaining - sold).toString();
    if (reason === "TP1") p.tp1 = true;
    if (reason === "TP2") {
      p.tp2 = true;
      p.highWater = fill.quote.price;
    }
    if (p.remainingRaw === "0") p.closedAt = now;
    this.updatePosition(p);
    this.setState("cash", this.cash() + fill.cashLamports);
    this.trade(p, fill, "SELL", reason, realized, now);
  }
  private trade(
    p: Position,
    f: Fill,
    side: string,
    reason: string,
    realized: number,
    now: number,
  ): void {
    this.db
      .prepare(
        "INSERT INTO paper_trades(position_id,mint,timestamp,side,quantity_raw,gross_lamports,fee_lamports,cash_lamports,realized_lamports,reason,quote) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        p.id,
        p.mint,
        now,
        side,
        f.quantityRaw,
        f.grossLamports,
        f.feeLamports,
        f.cashLamports,
        realized,
        reason,
        toJson(f.quote),
      );
  }
  recentTrades(): Record<string, unknown>[] {
    return this.db
      .prepare("SELECT * FROM paper_trades ORDER BY id DESC LIMIT 100")
      .all();
  }
  realizedSince(time: number): number {
    return Number(
      this.db
        .prepare(
          "SELECT COALESCE(SUM(realized_lamports),0) AS n FROM paper_trades WHERE timestamp>=?",
        )
        .get(time)!.n,
    );
  }
  closeDb(): void {
    this.db.close();
  }
}
