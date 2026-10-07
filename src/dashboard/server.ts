import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { Store } from "../database/store.js";
import { Engine } from "../portfolio/engine.js";
import { Scanner } from "../scanner/scanner.js";
import { SOL } from "../shared/types.js";
import { config } from "../config.js";
export function dashboard(
  store: Store,
  engine: Engine,
  scanner: Scanner,
  port: number = config.port,
): Server {
  const html = readFileSync(new URL("./public/index.html", import.meta.url));
  const server = createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.url === "/api/status") {
      const positions = store.positions(),
        all = store.positions(false),
        closed = all.filter((p) => p.closedAt !== undefined);
      const value = engine.value();
      const realized = all.reduce((n, p) => n + p.realizedLamports, 0);
      const sorted = [...closed].sort(
        (a, b) => b.realizedLamports - a.realizedLamports,
      );
      const tradeCount = Number(
        store.db.prepare("SELECT COUNT(*) AS n FROM paper_trades").get()!.n,
      );
      const status = {
        mode: "PAPER ONLY",
        health: scanner.health,
        strategy: {
          entryScore: config.entryScore,
          maxPositions: config.maxPositions,
          positionSol: config.positionSol,
          stopLoss: config.stopLoss,
          takeProfit1: config.takeProfit1,
          takeProfit2: config.takeProfit2,
          trailingStop: config.trailingStop,
          dailyLossSol: config.dailyLossSol,
          maxDataAgeMs: config.maxDataAgeMs,
        },
        stats: {
          equitySol: value.unknown
            ? null
            : (store.cash() + value.liquidationLamports) / SOL,
          virtualSolBalance: store.cash() / SOL,
          totalPnl: value.unknown
            ? null
            : (realized + value.unrealizedLamports) / SOL,
          realizedPnl: realized / SOL,
          unrealizedPnl: value.unknown ? null : value.unrealizedLamports / SOL,
          winRate: closed.length
            ? closed.filter((p) => p.realizedLamports > 0).length /
              closed.length
            : null,
          trades: tradeCount,
          closedPositions: closed.length,
          unvaluedPositions: value.unknown,
        },
        positions,
        trades: store.recentTrades(),
        tokens: [...scanner.tokens.values()].map((t) => ({
          ...t,
          activities: undefined,
          uniqueBuyers: t.uniqueBuyers.length,
        })),
        best: sorted[0] ?? null,
        worst: sorted.at(-1) ?? null,
      };
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(status));
      return;
    }
    if (
      new URL(req.url ?? "/", "http://localhost").pathname === "/" ||
      new URL(req.url ?? "/", "http://localhost").pathname === "/index.html"
    ) {
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(html);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1");
  return server;
}
