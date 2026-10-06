import { describe, it, expect } from "vitest";
import { getAddressEncoder } from "@solana/kit";
import { decode, idls, PUMP, AMM } from "../src/blockchain/idl.js";
import { effectiveQuote, tierFees } from "../src/blockchain/pricing.js";
import { summarizeHolders } from "../src/blockchain/holders.js";
import { decodeLogs } from "../src/scanner/events.js";
import { mint } from "./fixtures.js";
import { address } from "@solana/kit";
describe("official IDL validation", () => {
  it("decodes signed i128 virtual quote reserves and legacy pool tails", () => {
    const fields = [
      Buffer.from(
        idls.pump_amm.accounts.find((a) => a.name === "Pool")!.discriminator,
      ),
      Buffer.alloc(3),
    ];
    for (let i = 0; i < 6; i++)
      fields.push(Buffer.from(getAddressEncoder().encode(address(mint))));
    fields.push(
      Buffer.alloc(8),
      Buffer.from(getAddressEncoder().encode(address(mint))),
      Buffer.from([0, 0]),
    );
    const legacy = Buffer.concat(fields);
    expect(
      decode(legacy, idls.pump_amm, "accounts", "Pool").data
        .virtual_quote_reserves,
    ).toBeUndefined();
    const signed = Buffer.alloc(16, 255);
    signed[0] = 246;
    const decoded = decode(
      Buffer.concat([...fields, signed]),
      idls.pump_amm,
      "accounts",
      "Pool",
    );
    expect(decoded.data.virtual_quote_reserves).toBe(-10n);
    expect(effectiveQuote(100n, -10n)).toBe(90n);
    expect(() => effectiveQuote(5n, -10n)).toThrow();
  });
  it("rejects invalid discriminators, partial fields and invalid booleans", () => {
    expect(() => decode(Buffer.alloc(10), idls.pump, "accounts")).toThrow();
    const head = Buffer.from(
      idls.pump.accounts.find((a) => a.name === "BondingCurve")!.discriminator,
    );
    expect(() =>
      decode(Buffer.concat([head, Buffer.alloc(2)]), idls.pump, "accounts"),
    ).toThrow();
    expect(() =>
      decode(
        Buffer.concat([head, Buffer.alloc(40), Buffer.from([2])]),
        idls.pump,
        "accounts",
      ),
    ).toThrow();
  });
  it("does not attribute nested program event data to Pump", () => {
    const disc = Buffer.from(
      idls.pump.events.find((a) => a.name === "CreateEvent")!.discriminator,
    ).toString("base64");
    expect(
      decodeLogs([
        `Program ${PUMP} invoke [1]`,
        `Program ${AMM} invoke [2]`,
        `Program data: ${disc}`,
        `Program ${AMM} success`,
        `Program ${PUMP} success`,
      ]),
    ).toEqual([]);
  });
  it("selects dynamic fee tiers at exact thresholds", () => {
    const fees = (n: bigint) => ({
      lp_fee_bps: 0n,
      protocol_fee_bps: n,
      creator_fee_bps: 25n,
    });
    const tiers = [
      { market_cap_lamports_threshold: 100n, fees: fees(100n) },
      { market_cap_lamports_threshold: 200n, fees: fees(50n) },
    ];
    expect(tierFees(tiers, 0n)).toBe(125);
    expect(tierFees(tiers, 200n)).toBe(75);
    expect(() => tierFees([], 10n)).toThrow();
  });
  it("aggregates token accounts by wallet, excludes vaults and rejects incomplete supply", () => {
    const accounts = [
      { owner: "vault", amount: 60n },
      { owner: "creator", amount: 10n },
      { owner: "creator", amount: 10n },
      { owner: "buyer", amount: 20n },
    ];
    const h = summarizeHolders(accounts, 100n, "creator", ["vault"]);
    expect(h.count).toBe(2);
    expect(h.creatorFraction).toBe(0.2);
    expect(h.topFraction).toBe(0.4);
    expect(() =>
      summarizeHolders(accounts.slice(1), 100n, "creator", ["vault"]),
    ).toThrow();
  });
});
