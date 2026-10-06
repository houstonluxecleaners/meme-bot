import { describe, it, expect, vi } from "vitest";
import { Store } from "../src/database/store.js";
import { PaperExecutor } from "../src/execution/PaperExecutor.js";
import { Engine } from "../src/portfolio/engine.js";
import { token, quote, mint } from "./fixtures.js";
import { type Health, SOL } from "../src/shared/types.js";
import { config } from "../src/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const health = (): Health => ({
  rpc: true,
  websocket: true,
  caughtUp: true,
  lastEventAt: Date.now(),
  error: null,
});
function eligible() {
  const t = token(),
    now = Date.now();
  for (let i = 0; i < 100; i++)
    t.activities.push({
      id: String(i),
      timestamp: now - 25000 + i * 200,
      buyer: "b" + i,
      buy: true,
      volumeSol: 0.1,
      price: 1 + i / 100,
    });
  for (let i = 0; i < 10; i++)
    t.activities.push({
      id: "p" + i,
      timestamp: now - 45000 + i * 100,
      buyer: "p" + i,
      buy: false,
      volumeSol: 0.01,
      price: 0.9,
    });
  return t;
}
describe("portfolio safety and persistence", () => {
  it("blocks duplicate open positions and rolls back the cash ledger", () => {
    const db = new Store(":memory:"),
      e = new PaperExecutor();
    db.token(token());
    db.atomic(() => db.open(mint, e.buy(50000000, quote())));
    const cash = db.cash();
    expect(() =>
      db.atomic(() => db.open(mint, e.buy(50000000, quote()))),
    ).toThrow();
    expect(db.cash()).toBe(cash);
    expect(db.positions()).toHaveLength(1);
    db.closeDb();
  });
  it("allocates partial cost basis exactly and reconciles net profit to cash", () => {
    const db = new Store(":memory:"),
      e = new PaperExecutor();
    db.token(token());
    const p = db.atomic(() => db.open(mint, e.buy(50000000, quote())));
    const quarter = (BigInt(p.initialRaw) / 4n).toString();
    db.atomic(() => db.close(p, e.sell(quarter, quote()), "TP1"));
    db.atomic(() => db.close(p, e.sell(quarter, quote()), "TP2"));
    expect(p.tp2).toBe(true);
    db.atomic(() =>
      db.close(p, e.sell(p.remainingRaw, quote()), "TRAILING_STOP"),
    );
    expect(db.positions()).toHaveLength(0);
    expect(p.remainingCostLamports).toBe(0);
    expect(db.cash() - 10 * SOL).toBe(p.realizedLamports);
    expect(db.recentTrades()).toHaveLength(4);
    db.closeDb();
  });
  it("restores balance and exit state after reopening SQLite", () => {
    const dir = mkdtempSync(join(tmpdir(), "pumptrader-")),
      path = join(dir, "db.sqlite");
    let db = new Store(path);
    db.token(token());
    const p = db.atomic(() =>
      db.open(mint, new PaperExecutor().buy(50000000, quote())),
    );
    p.tp1 = true;
    p.highWater = 2;
    db.updatePosition(p);
    const cash = db.cash();
    db.closeDb();
    db = new Store(path);
    expect(db.cash()).toBe(cash);
    expect(db.positions()[0]?.tp1).toBe(true);
    expect(db.positions()[0]?.highWater).toBe(2);
    db.closeDb();
    rmSync(dir, { recursive: true });
  });
  it("blocks new entries during unhealthy streams, unknown valuations and daily loss", () => {
    const db = new Store(":memory:"),
      e = new PaperExecutor(),
      tokens = new Map([[mint, token()]]),
      h = health();
    const engine = new Engine(db, e, tokens, h);
    h.websocket = false;
    expect(engine.riskReasons()).toContain("CHAIN_STREAM_UNHEALTHY");
    h.websocket = true;
    db.token(token());
    db.atomic(() => db.open(mint, e.buy(2 * SOL, quote())));
    tokens.delete(mint);
    expect(engine.riskReasons()).toContain("UNVALUED_OPEN_POSITION");
    tokens.set(
      mint,
      token({
        quote: quote({
          quoteReserve: "1000000",
          realQuoteReserve: "1000000",
          price: 1e-12,
        }),
      }),
    );
    expect(engine.riskReasons()).toContain("DAILY_LOSS_LIMIT");
    db.closeDb();
  });
  it("reserves maximum slots before delayed fills", () => {
    const db = new Store(":memory:"),
      tokens = new Map();
    for (let i = 0; i < 5; i++) {
      const t = eligible();
      t.mint = "test" + i;
      t.quote!.mint = t.mint;
      tokens.set(t.mint, t);
      db.token(t);
    }
    const engine = new Engine(db, new PaperExecutor(), tokens, health());
    engine.evaluate();
    const count = Number(
      db.db
        .prepare(
          "SELECT COUNT(*) AS n FROM signals WHERE action='ENTRY_SCHEDULED'",
        )
        .get()!.n,
    );
    expect(count).toBe(config.maxPositions);
    db.closeDb();
  });
  it("waits for execution delay and fills using a fresh later quote", async () => {
    const db = new Store(":memory:"),
      t = eligible();
    db.token(t);
    const engine = new Engine(
      db,
      new PaperExecutor(),
      new Map([[mint, t]]),
      health(),
    );
    const now = Date.now();
    engine.evaluate(now);
    const fetch = vi.fn(async () =>
      quote({ quoteReserve: "40000000000", price: 0.00000004 }),
    );
    await engine.executeDue(fetch, now + config.executionDelayMs - 1);
    expect(fetch).not.toHaveBeenCalled();
    expect(db.positions()).toHaveLength(0);
    await engine.executeDue(fetch, now + config.executionDelayMs + 1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(db.positions()).toHaveLength(1);
    expect(db.positions()[0]!.entryPrice).toBeGreaterThan(0.00000004);
    db.closeDb();
  });
});
