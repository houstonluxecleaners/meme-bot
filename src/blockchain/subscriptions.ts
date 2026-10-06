import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { z } from "zod";
import { config } from "../config.js";
import { PUMP, AMM } from "./idl.js";
import { log } from "../shared/logger.js";
const frame = z.object({
  method: z.literal("logsNotification"),
  params: z.object({
    subscription: z.number(),
    result: z.object({
      context: z.object({ slot: z.number().int().nonnegative() }),
      value: z.object({
        signature: z.string(),
        err: z.unknown(),
        logs: z.array(z.string()),
      }),
    }),
  }),
});
export class Subscriptions {
  private socket?: WebSocket;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private attempt = 0;
  constructor(
    readonly onLogs: (
      program: string,
      signature: string,
      logs: string[],
      slot: number,
    ) => void,
    readonly onState: (online: boolean) => void,
  ) {}
  start(): void {
    if (this.stopped) return;
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const ws = new WebSocket(config.wsUrl, {
      handshakeTimeout: 15000,
      maxPayload: 2 * 1024 * 1024,
      ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
    });
    this.socket = ws;
    const subs = new Map<number, string>();
    const pending = new Map([
      [1, PUMP],
      [2, AMM],
    ]);
    let alive = true;
    ws.on("open", () => {
      for (const [id, program] of pending)
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "logsSubscribe",
            params: [{ mentions: [program] }, { commitment: "confirmed" }],
          }),
        );
      this.heartbeat = setInterval(() => {
        if (!alive || pending.size) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, 20000);
    });
    ws.on("pong", () => (alive = true));
    ws.on("message", (raw) => {
      try {
        const data: unknown = JSON.parse(raw.toString());
        const ack = z
          .object({ id: z.number(), result: z.number() })
          .safeParse(data);
        if (ack.success) {
          const program = pending.get(ack.data.id);
          if (program) {
            subs.set(ack.data.result, program);
            pending.delete(ack.data.id);
          }
          if (pending.size === 0) {
            this.attempt = 0;
            this.onState(true);
          }
          return;
        }
        const message = frame.safeParse(data);
        if (!message.success) {
          const err = z.object({ error: z.unknown() }).safeParse(data);
          if (err.success) ws.terminate();
          return;
        }
        const program = subs.get(message.data.params.subscription);
        const result = message.data.params.result;
        if (program && result.value.err === null)
          this.onLogs(
            program,
            result.value.signature,
            result.value.logs,
            result.context.slot,
          );
      } catch {
        log("warn", "Rejected invalid WebSocket message");
      }
    });
    ws.on("error", () =>
      log("warn", "WebSocket connection error; endpoint details omitted"),
    );
    ws.on("close", () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.onState(false);
      if (!this.stopped) {
        const delay = Math.min(
          config.reconnectMaxMs,
          1000 * 2 ** Math.min(this.attempt++, 6),
        );
        this.timer = setTimeout(
          () => this.start(),
          delay + Math.floor(Math.random() * 500),
        );
      }
    });
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.terminate();
  }
}
