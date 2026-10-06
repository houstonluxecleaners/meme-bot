import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { getAddressEncoder, address } from "@solana/kit";
import { Store } from "../src/database/store.js";
import { Scanner } from "../src/scanner/scanner.js";
import { decodeLogs, createToken } from "../src/scanner/events.js";
import { idls, PUMP, AMM } from "../src/blockchain/idl.js";
import { TOKEN, ZERO } from "../src/blockchain/rpc.js";
import { mint } from "./fixtures.js";
const sockets = vi.hoisted(() => ({ instances: [] as unknown[] }));
vi.mock("ws", () => ({
  default: class extends EventEmitter {
    sent: string[] = [];
    constructor() {
      super();
      sockets.instances.push(this);
    }
    send(s: string) {
      this.sent.push(s);
    }
    ping() {}
    terminate() {
      this.emit("close");
    }
  },
}));
import { Subscriptions } from "../src/blockchain/subscriptions.js";
function creation(): string[] {
  const key = (s: string) =>
    Buffer.from(getAddressEncoder().encode(address(s)));
  const str = (s: string) => {
    const b = Buffer.from(s),
      len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  const u64 = (n: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b;
  };
  const bytes = Buffer.concat([
    Buffer.from(
      idls.pump.events.find((e) => e.name === "CreateEvent")!.discriminator,
    ),
    str("Fresh coin"),
    str("FRESH"),
    str("https://example.com/metadata"),
    key(mint),
    key(PUMP),
    key(AMM),
    key(AMM),
    u64(BigInt(Math.floor(Date.now() / 1000))),
    u64(1073000000000000n),
    u64(30000000000n),
    u64(793100000000000n),
    u64(1000000000000000n),
    key(TOKEN),
    Buffer.from([0, 0]),
    key(ZERO),
    u64(30000000000n),
    u64(0n),
    Buffer.from([0]),
  ]);
  return [
    `Program ${PUMP} invoke [1]`,
    `Program data: ${bytes.toString("base64")}`,
    `Program ${PUMP} success`,
  ];
}
afterEach(() => vi.useRealTimers());
describe("scanner and reconnect", () => {
  it("captures a validated creation event and computes initial SOL market cap", () => {
    const e = decodeLogs(creation())[0]!;
    expect(e.name).toBe("CreateEvent");
    const t = createToken(e.data);
    expect(t.name).toBe("Fresh coin");
    expect(t.symbol).toBe("FRESH");
    expect(t.creator).toBe(AMM);
    expect(t.mint).toBe(mint);
    expect(t.initialMarketCapSol).toBeCloseTo(27.95899, 4);
  });
  it("deduplicates signatures across restart and fails closed on malformed data", () => {
    const db = new Store(":memory:"),
      scanner = new Scanner(db);
    type Internal = {
      process: (v: {
        program: string;
        signature: string;
        logs: string[];
        slot: number;
      }) => boolean;
    };
    const internal = scanner as unknown as Internal;
    const input = {
      program: PUMP,
      signature: "s1",
      logs: creation(),
      slot: 100,
    };
    expect(internal.process(input)).toBe(true);
    expect(internal.process(input)).toBe(true);
    expect(scanner.tokens.size).toBe(1);
    const restarted = new Scanner(db);
    expect((restarted as unknown as Internal).process(input)).toBe(true);
    expect(restarted.tokens.size).toBe(1);
    expect(
      internal.process({
        ...input,
        signature: "bad",
        logs: [`Program ${PUMP} invoke [1]`, "Program data: !!!"],
      }),
    ).toBe(false);
    expect(scanner.health.caughtUp).toBe(false);
    scanner.stop();
    restarted.stop();
    db.closeDb();
  });
  it("rejects a non-SOL token without disabling the entire stream", () => {
    const db = new Store(":memory:"),
      scanner = new Scanner(db);
    const internal = scanner as unknown as {
      process: (v: {
        program: string;
        signature: string;
        logs: string[];
        slot: number;
      }) => boolean;
    };
    internal.process({
      program: PUMP,
      signature: "create",
      logs: creation(),
      slot: 100,
    });
    scanner.health.caughtUp = true;
    const definition = idls.pump.types.find((t) => t.name === "TradeEvent")!;
    const chunks = [
      Buffer.from(
        idls.pump.events.find((e) => e.name === "TradeEvent")!.discriminator,
      ),
    ];
    for (const f of definition.type.fields!) {
      const t = f.type;
      if (typeof t !== "string") {
        if ("vec" in t) {
          chunks.push(Buffer.alloc(4));
          continue;
        }
        throw new Error("Update fixture");
      }
      if (t === "pubkey") {
        const value =
          f.name === "mint"
            ? mint
            : f.name === "quote_mint"
              ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
              : AMM;
        chunks.push(Buffer.from(getAddressEncoder().encode(address(value))));
      } else if (t === "bool")
        chunks.push(Buffer.from([f.name === "is_buy" ? 1 : 0]));
      else if (t === "u64" || t === "i64") {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(
          f.name === "timestamp"
            ? BigInt(Math.floor(Date.now() / 1000))
            : 1000n,
        );
        chunks.push(b);
      } else if (t === "string") {
        const value = Buffer.from("buy"),
          n = Buffer.alloc(4);
        n.writeUInt32LE(value.length);
        chunks.push(n, value);
      } else throw new Error("Update fixture");
    }
    const logs = [
      `Program ${PUMP} invoke [1]`,
      `Program data: ${Buffer.concat(chunks).toString("base64")}`,
      `Program ${PUMP} success`,
    ];
    expect(
      internal.process({ program: PUMP, signature: "trade", logs, slot: 101 }),
    ).toBe(true);
    expect(scanner.health.caughtUp).toBe(true);
    expect(scanner.tokens.get(mint)?.error).toBe("NON_SOL_QUOTE_ASSET");
    expect(scanner.tokens.get(mint)?.buyCount).toBe(0);
    scanner.stop();
    db.closeDb();
  });
  it("requires both subscription acknowledgements and reconnects after a dropped socket", () => {
    vi.useFakeTimers();
    sockets.instances = [];
    const state = vi.fn(),
      logs = vi.fn(),
      s = new Subscriptions(logs, state);
    s.start();
    const ws = sockets.instances[0] as EventEmitter & { sent: string[] };
    ws.emit("open");
    expect(ws.sent).toHaveLength(2);
    ws.emit("message", Buffer.from(JSON.stringify({ id: 1, result: 101 })));
    expect(state).not.toHaveBeenCalledWith(true);
    ws.emit("message", Buffer.from(JSON.stringify({ id: 2, result: 102 })));
    expect(state).toHaveBeenCalledWith(true);
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          method: "logsNotification",
          params: {
            subscription: 101,
            result: {
              context: { slot: 100 },
              value: { signature: "s", err: null, logs: creation() },
            },
          },
        }),
      ),
    );
    expect(logs).toHaveBeenCalledWith(PUMP, "s", expect.any(Array), 100);
    ws.emit("close");
    expect(state).toHaveBeenCalledWith(false);
    vi.advanceTimersByTime(1600);
    expect(sockets.instances).toHaveLength(2);
    s.stop();
  });
});
