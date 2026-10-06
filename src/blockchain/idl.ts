import { readFileSync } from "node:fs";
import { getAddressDecoder } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { z } from "zod";
type Type =
  | string
  | { array: [Type, number] }
  | { vec: Type }
  | { defined: { name: string } }
  | { option: Type };
interface Field {
  name: string;
  type: Type;
}
interface Idl {
  address: string;
  accounts: { name: string; discriminator: number[] }[];
  events: { name: string; discriminator: number[] }[];
  types: { name: string; type: { kind: string; fields?: Field[] } }[];
}
export const idls = Object.fromEntries(
  ["pump", "pump_amm", "pump_fees"].map((name) => [
    name,
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            `../../vendor/pump-public-docs/idl/${name}.json`,
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ) as Idl,
  ]),
) as Record<"pump" | "pump_amm" | "pump_fees", Idl>;
export const PUMP = idls.pump.address,
  AMM = idls.pump_amm.address,
  FEES = idls.pump_fees.address;
const decoder = getAddressDecoder();
class Reader {
  offset = 8;
  constructor(
    readonly bytes: Buffer,
    readonly idl: Idl,
  ) {}
  take(n: number): Buffer {
    if (n < 0 || this.offset + n > this.bytes.length)
      throw new Error("Truncated IDL data");
    const v = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }
  read(t: Type): unknown {
    if (typeof t !== "string") {
      if ("array" in t)
        return Array.from({ length: t.array[1] }, () => this.read(t.array[0]));
      if ("vec" in t) {
        const n = this.take(4).readUInt32LE();
        if (n > 10000) throw new Error("Oversized vector");
        return Array.from({ length: n }, () => this.read(t.vec));
      }
      if ("option" in t) {
        const b = this.take(1)[0];
        if (b !== 0 && b !== 1) throw new Error("Invalid option");
        return b === 1 ? this.read(t.option) : null;
      }
      return this.struct(t.defined.name);
    }
    if (t === "pubkey") return decoder.decode(this.take(32));
    if (t === "bool") {
      const n = this.take(1)[0];
      if (n !== 0 && n !== 1) throw new Error("Invalid boolean");
      return n === 1;
    }
    if (t === "string") {
      const n = this.take(4).readUInt32LE();
      if (n > 4096) throw new Error("Oversized string");
      return new TextDecoder("utf-8", { fatal: true }).decode(this.take(n));
    }
    if (t === "u8") return this.take(1).readUInt8();
    if (t === "u16") return this.take(2).readUInt16LE();
    if (t === "u32") return this.take(4).readUInt32LE();
    if (t === "u64") return this.take(8).readBigUInt64LE();
    if (t === "i64") return this.take(8).readBigInt64LE();
    if (t === "u128" || t === "i128") {
      const b = this.take(16);
      let n = b.readBigUInt64LE() + (b.readBigUInt64LE(8) << 64n);
      if (t === "i128" && b[15]! & 128) n -= 1n << 128n;
      return n;
    }
    throw new Error(`Unsupported IDL type ${t}`);
  }
  struct(name: string, trailingDefaults = false): Record<string, unknown> {
    const fields = this.idl.types.find((t) => t.name === name)?.type.fields;
    if (!fields) throw new Error("Unknown IDL struct");
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (trailingDefaults && this.offset === this.bytes.length) break;
      out[f.name] = this.read(f.type);
    }
    return out;
  }
}
export function decode(
  bytes: Buffer,
  idl: Idl,
  kind: "accounts" | "events",
  expected?: string,
): { name: string; data: Record<string, unknown> } {
  if (bytes.length < 8) throw new Error("Missing discriminator");
  const def = idl[kind].find((d) =>
    bytes.subarray(0, 8).equals(Buffer.from(d.discriminator)),
  );
  if (!def || (expected && def.name !== expected))
    throw new Error("Unexpected discriminator");
  return {
    name: def.name,
    data: new Reader(bytes, idl).struct(def.name, true),
  };
}
export const bigintField = (v: unknown): bigint => z.bigint().parse(v);
export const stringField = (v: unknown): string => z.string().parse(v);
export const addressField = (v: unknown): string =>
  z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    .parse(v);
export const boolField = (v: unknown): boolean => z.boolean().parse(v);
export function timestamp(v: unknown): number {
  const n = Number(bigintField(v)) * 1000;
  if (!Number.isSafeInteger(n) || n < 0 || n > Date.now() + 60000)
    throw new Error("Invalid timestamp");
  return n;
}
