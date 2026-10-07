import { afterEach, describe, expect, it, vi } from "vitest";
import { Scanner } from "../src/scanner/scanner.js";
import { Store } from "../src/database/store.js";
import * as rpc from "../src/blockchain/rpc.js";
import { RpcRequestError, rpcFailureReason } from "../src/blockchain/errors.js";
import { PUMP, AMM } from "../src/blockchain/idl.js";
import { config } from "../src/config.js";
type Internal = { catchup: () => Promise<void> };
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("history recovery", () => {
  it("retries a transient RPC failure without requiring a WebSocket reconnect", async () => {
    vi.useFakeTimers();
    const db = new Store(":memory:"),
      scanner = new Scanner(db);
    scanner.health.websocket = true;
    const sig = vi
      .spyOn(rpc, "signatures")
      .mockRejectedValueOnce(new RpcRequestError("RATE_LIMITED"))
      .mockResolvedValue([{ signature: "head", err: null, slot: 10 }]);
    try {
      await (scanner as unknown as Internal).catchup();
      expect(scanner.health.caughtUp).toBe(false);
      expect(scanner.health.rpcFailure).toBe("RATE_LIMITED");
      expect(scanner.health.retryAt).toBe(
        Date.now() + config.catchupRetryBaseMs,
      );
      await vi.advanceTimersByTimeAsync(config.catchupRetryBaseMs);
      expect(sig).toHaveBeenCalledTimes(3);
      expect(scanner.health.caughtUp).toBe(true);
      expect(scanner.health.rpcFailure).toBeNull();
      expect(scanner.health.retryAt).toBeNull();
    } finally {
      scanner.stop();
      db.closeDb();
    }
  });
  it("retains original cursors after a partial failure and checkpoints deduplicated replay on recovery", async () => {
    vi.useFakeTimers();
    const db = new Store(":memory:"),
      scanner = new Scanner(db);
    scanner.health.websocket = true;
    db.setState(`cursor:${PUMP}`, { signature: "pump-old", slot: 1 });
    db.setState(`cursor:${AMM}`, { signature: "amm-old", slot: 1 });
    let fail = true;
    vi.spyOn(rpc, "signatures").mockImplementation(async (program) => {
      if (program === AMM && fail) {
        fail = false;
        throw new RpcRequestError("TIMEOUT");
      }
      return program === PUMP
        ? [
            { signature: "pump-new", err: null, slot: 2 },
            { signature: "pump-old", err: null, slot: 1 },
          ]
        : [{ signature: "amm-old", err: null, slot: 1 }];
    });
    vi.spyOn(rpc, "transactionLogs").mockResolvedValue({ logs: [], slot: 2 });
    try {
      await (scanner as unknown as Internal).catchup();
      expect(db.getState(`cursor:${PUMP}`)).toEqual({
        signature: "pump-old",
        slot: 1,
      });
      await vi.advanceTimersByTimeAsync(config.catchupRetryBaseMs);
      expect(scanner.health.caughtUp).toBe(true);
      expect(db.getState(`cursor:${PUMP}`)).toEqual({
        signature: "pump-new",
        slot: 2,
      });
    } finally {
      scanner.stop();
      db.closeDb();
    }
  });
  it("cancels scheduled recovery when stopped", async () => {
    vi.useFakeTimers();
    const db = new Store(":memory:"),
      scanner = new Scanner(db);
    scanner.health.websocket = true;
    const sig = vi
      .spyOn(rpc, "signatures")
      .mockRejectedValue(new RpcRequestError("TIMEOUT"));
    await (scanner as unknown as Internal).catchup();
    scanner.stop();
    await vi.advanceTimersByTimeAsync(config.catchupRetryMaxMs);
    expect(sig).toHaveBeenCalledOnce();
    db.closeDb();
  });
  it("does not silently reset an exceeded history limit or retry denied access", async () => {
    vi.useFakeTimers();
    const db = new Store(":memory:"),
      scanner = new Scanner(db);
    scanner.health.websocket = true;
    db.setState(`cursor:${PUMP}`, { signature: "old", slot: 1 });
    const sig = vi.spyOn(rpc, "signatures").mockResolvedValue([]);
    try {
      await (scanner as unknown as Internal).catchup();
      expect(scanner.health.error).toBe("CATCHUP_LIMIT_EXCEEDED");
      expect(scanner.health.retryAt ?? null).toBeNull();
      await vi.advanceTimersByTimeAsync(config.catchupRetryMaxMs);
      expect(sig).toHaveBeenCalledOnce();
      expect(db.getState(`cursor:${PUMP}`)).toEqual({
        signature: "old",
        slot: 1,
      });
      sig.mockRejectedValue(new RpcRequestError("ACCESS_DENIED"));
      await (scanner as unknown as Internal).catchup();
      expect(scanner.health.rpcFailure).toBe("ACCESS_DENIED");
      expect(scanner.health.retryAt ?? null).toBeNull();
    } finally {
      scanner.stop();
      db.closeDb();
    }
  });
  it("rolls back an overflowed recovery and replays the gap before allowing entries", async () => {
    vi.useFakeTimers();
    const db = new Store(":memory:"), scanner = new Scanner(db);
    scanner.health.websocket = true;
    db.setState(`cursor:${PUMP}`, {signature: "old", slot: 1});
    db.setState(`cursor:${AMM}`, {signature: "amm-old", slot: 1});
    let first = true;
    vi.spyOn(rpc, "signatures").mockImplementation(async program => {
      if (program === PUMP) {
        if (first) {
          first = false;
          (scanner as unknown as {overflow: boolean}).overflow = true;
        }
        return [{signature: "new", err: null, slot: 2}, {signature: "old", err: null, slot: 1}];
      }
      return [{signature: "amm-old", err: null, slot: 1}];
    });
    vi.spyOn(rpc, "transactionLogs").mockResolvedValue({logs: [], slot: 2});
    try {
      await (scanner as unknown as Internal).catchup();
      expect(scanner.health.error).toBe("EVENT_QUEUE_OVERFLOW");
      expect(scanner.health.caughtUp).toBe(false);
      expect(db.getState(`cursor:${PUMP}`)).toEqual({signature: "old", slot: 1});
      expect(scanner.health.retryAt).toBe(Date.now() + config.catchupRetryBaseMs);
      await vi.advanceTimersByTimeAsync(config.catchupRetryBaseMs);
      expect(scanner.health.caughtUp).toBe(true);
      expect(scanner.health.error).toBeNull();
      expect(db.getState(`cursor:${PUMP}`)).toEqual({signature: "new", slot: 2});
    } finally {scanner.stop();db.closeDb();}
  });
  it("reports safe failure categories without echoing credentials", () => {
    const error = {
      message: "https://provider.invalid?api-key=SECRET",
      context: { statusCode: 429, headers: { authorization: "SECRET" } },
    };
    expect(rpcFailureReason(error)).toBe("RATE_LIMITED");
    expect(new RpcRequestError(rpcFailureReason(error)).message).not.toContain(
      "SECRET",
    );
    expect(rpcFailureReason({ context: { statusCode: 403 } })).toBe(
      "ACCESS_DENIED",
    );
    expect(rpcFailureReason({ name: "TimeoutError" })).toBe("TIMEOUT");
    expect(rpcFailureReason({ code: -32601 })).toBe("METHOD_UNSUPPORTED");
  });
});
