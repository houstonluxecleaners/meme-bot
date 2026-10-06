import { config } from "./config.js";
import { Store } from "./database/store.js";
import { Scanner } from "./scanner/scanner.js";
import { PaperExecutor } from "./execution/PaperExecutor.js";
import { Engine } from "./portfolio/engine.js";
import { fetchQuote } from "./blockchain/pricing.js";
import { fetchHolders } from "./blockchain/holders.js";
import { verifyMainnet } from "./blockchain/rpc.js";
import { dashboard } from "./dashboard/server.js";
import { log } from "./shared/logger.js";
const store = new Store(),
  scanner = new Scanner(store),
  engine = new Engine(
    store,
    new PaperExecutor(),
    scanner.tokens,
    scanner.health,
  );
const server = dashboard(store, engine, scanner);
log("info", "PumpTrader started in PAPER mode", { dashboardPort: config.port });
let stopped = false,
  started = false,
  verifiedAt = 0;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function run(): Promise<void> {
  while (!stopped) {
    try {
      if (!started || Date.now() - verifiedAt > 60000) {
        await verifyMainnet();
        verifiedAt = Date.now();
        scanner.health.rpc = true;
        if (!started) {
          scanner.start();
          started = true;
        }
      }
      await engine.executeDue(fetchQuote);
      scanner.prune();
      const open = new Set(store.positions().map((p) => p.mint));
      const tokens = [...scanner.tokens.values()].sort(
        (a, b) =>
          Number(open.has(b.mint)) - Number(open.has(a.mint)) ||
          (a.quote?.timestamp ?? 0) - (b.quote?.timestamp ?? 0),
      );
      // Bound each refresh batch; repeatedly prioritize open positions and oldest data.
      for (const t of tokens.slice(0, Math.max(5, open.size))) {
        if (stopped) break;
        try {
          t.quote = await fetchQuote(t);
          store.snapshot(t);
          if (
            !t.holders ||
            Date.now() - t.holders.timestamp > config.holderRefreshMs
          ) {
            const holders = await fetchHolders(t, t.quote);
            t.previousHolders = t.holders;
            t.holders = holders;
          }
          t.error = undefined;
        } catch {
          t.error = "Required pricing or holder data unavailable";
        }
        store.token(t);
        engine.evaluate();
        await engine.executeDue(fetchQuote);
      }
      engine.evaluate();
      await engine.executeDue(fetchQuote);
    } catch {
      scanner.health.rpc = false;
      scanner.health.error = "RPC_UNAVAILABLE_OR_WRONG_NETWORK";
      log(
        "warn",
        "Mainnet read failed; entries blocked. Check RPC access and settings.",
      );
    }
    await pause(config.refreshMs);
  }
}
function shutdown(): void {
  if (stopped) return;
  stopped = true;
  scanner.stop();
  server.close();
  log("info", "Stopping PumpTrader");
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("error", () => {
  log("error", "Dashboard failed to bind; check port");
  shutdown();
  process.exitCode = 1;
});
await run();
store.closeDb();
