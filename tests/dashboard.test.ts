import { describe, it, expect } from "vitest";
import { once } from "node:events";
import { type AddressInfo } from "node:net";
import { dashboard } from "../src/dashboard/server.js";
import { Store } from "../src/database/store.js";
import { Scanner } from "../src/scanner/scanner.js";
import { Engine } from "../src/portfolio/engine.js";
import { PaperExecutor } from "../src/execution/PaperExecutor.js";
import { config } from "../src/config.js";
import { token, quote, mint } from "./fixtures.js";
async function withDashboard(
  check: (base: string, store: Store) => Promise<void>,
) {
  const store = new Store(":memory:"),
    scanner = new Scanner(store),
    engine = new Engine(
      store,
      new PaperExecutor(),
      scanner.tokens,
      scanner.health,
    );
  const server = dashboard(store, engine, scanner, 0);
  try {
    await once(server, "listening");
    await check(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      store,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    scanner.stop();
    store.closeDb();
  }
}
describe("dashboard API and preview", () => {
  it("serves the labeled demo view without modifying account state", async () => {
    await withDashboard(async (base, store) => {
      const preview = await fetch(base + "/?demo=1");
      expect(preview.status).toBe(200);
      expect((await preview.text()).replace(/\s+/g, " ")).toContain(
        "Fictional tokens and simulated example results",
      );
      const status = await (await fetch(base + "/api/status")).json();
      expect(status.mode).toBe("PAPER ONLY");
      expect(status.stats.equitySol).toBe(10);
      expect(status.stats.trades).toBe(0);
      expect(status.strategy.entryScore).toBe(config.entryScore);
      expect(status.strategy.maxPositions).toBe(config.maxPositions);
      expect(store.positions()).toHaveLength(0);
    });
  });
  it("returns unknown equity and unrealized P&L for an unvalued open position", async () => {
    await withDashboard(async (base, store) => {
      store.token(token());
      store.atomic(() =>
        store.open(mint, new PaperExecutor().buy(50000000, quote())),
      );
      const status = await (await fetch(base + "/api/status")).json();
      expect(status.stats.equitySol).toBeNull();
      expect(status.stats.unrealizedPnl).toBeNull();
      expect(status.stats.totalPnl).toBeNull();
      expect(status.stats.unvaluedPositions).toBe(1);
    });
  });
});
