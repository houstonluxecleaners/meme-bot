import {
  address,
  createSolanaRpc,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Base58EncodedBytes,
} from "@solana/kit";
import { z } from "zod";
import { config } from "../config.js";
import { decode, idls } from "./idl.js";
const rpc = createSolanaRpc(config.rpcUrl);
const integer = z
  .union([z.bigint(), z.number().int().nonnegative()])
  .transform(BigInt);
const context = z.object({ slot: integer });
const account = z.object({
  owner: z.string(),
  data: z
    .tuple([z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/), z.literal("base64")])
    .rest(z.unknown()),
});
const parsedAccount = z.object({
  owner: z.string(),
  data: z.object({
    parsed: z.object({
      type: z.string(),
      info: z.record(z.string(), z.unknown()),
    }),
  }),
});
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const WSOL = "So11111111111111111111111111111111111111112",
  ZERO = "11111111111111111111111111111111";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let chain = Promise.resolve();
async function request<T>(
  make: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const previous = chain;
  let release!: () => void;
  chain = new Promise<void>((r) => (release = r));
  await previous;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await make(AbortSignal.timeout(config.rpcTimeoutMs));
      } catch {
        if (attempt >= 2)
          throw new Error(
            "RPC request failed; check provider access, rate limits and endpoint settings",
          );
        await sleep(500 * 2 ** attempt);
      }
    }
  } finally {
    await sleep(config.rpcMinIntervalMs);
    release();
  }
}
export const pda = async (
  program: string,
  seeds: (Uint8Array | string)[],
): Promise<string> =>
  (
    await getProgramDerivedAddress({ programAddress: address(program), seeds })
  )[0];
export const addressBytes = (s: string): Uint8Array =>
  new Uint8Array(getAddressEncoder().encode(address(s)));
export async function verifyMainnet(): Promise<void> {
  const hash = await request((signal) =>
    rpc.getGenesisHash().send({ abortSignal: signal }),
  );
  if (hash !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")
    throw new Error("RPC must point to Solana mainnet-beta");
}
export async function readAccount(
  key: string,
  owner: string,
  idl: typeof idls.pump,
  type: string,
): Promise<{ data: Record<string, unknown>; slot: number }> {
  const res = z
    .object({ context, value: account.nullable() })
    .parse(
      await request((signal) =>
        rpc
          .getAccountInfo(address(key), {
            encoding: "base64",
            commitment: "confirmed",
          })
          .send({ abortSignal: signal }),
      ),
    );
  if (!res.value || res.value.owner !== owner)
    throw new Error("Missing account or unexpected program owner");
  return {
    data: decode(
      Buffer.from(res.value.data[0], "base64"),
      idl,
      "accounts",
      type,
    ).data,
    slot: Number(res.context.slot),
  };
}
export async function mintInfo(
  mint: string,
): Promise<{ supply: bigint; decimals: number; program: string }> {
  const res = z
    .object({ value: parsedAccount.nullable() })
    .parse(
      await request((signal) =>
        rpc
          .getAccountInfo(address(mint), {
            encoding: "jsonParsed",
            commitment: "confirmed",
          })
          .send({ abortSignal: signal }),
      ),
    );
  if (
    !res.value ||
    ![TOKEN, TOKEN2022].includes(res.value.owner) ||
    res.value.data.parsed.type !== "mint"
  )
    throw new Error("Invalid mint");
  const extensions = res.value.data.parsed.info.extensions;
  if (
    Array.isArray(extensions) &&
    extensions.some(
      (e) =>
        e &&
        typeof e === "object" &&
        [
          "transferFeeConfig",
          "transferHook",
          "confidentialTransferMint",
          "interestBearingConfig",
          "scaledUiAmountConfig",
          "nonTransferable",
        ].includes(String((e as Record<string, unknown>).extension)),
    )
  )
    throw new Error("Unsupported mint extension");
  const info = z
    .object({
      supply: z.string().regex(/^\d+$/),
      decimals: z.number().int().min(0).max(18),
    })
    .parse(res.value.data.parsed.info);
  if (BigInt(info.supply) <= 0n) throw new Error("Empty supply");
  return {
    supply: BigInt(info.supply),
    decimals: info.decimals,
    program: res.value.owner,
  };
}
export async function vaultInfo(
  key: string,
  mint: string,
): Promise<{ amount: bigint; owner: string; slot: number }> {
  const res = z
    .object({ context, value: parsedAccount.nullable() })
    .parse(
      await request((signal) =>
        rpc
          .getAccountInfo(address(key), {
            encoding: "jsonParsed",
            commitment: "confirmed",
          })
          .send({ abortSignal: signal }),
      ),
    );
  if (
    !res.value ||
    ![TOKEN, TOKEN2022].includes(res.value.owner) ||
    res.value.data.parsed.type !== "account"
  )
    throw new Error("Invalid vault");
  const info = z
    .object({
      mint: z.literal(mint),
      owner: z.string(),
      tokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }),
    })
    .parse(res.value.data.parsed.info);
  return {
    amount: BigInt(info.tokenAmount.amount),
    owner: info.owner,
    slot: Number(res.context.slot),
  };
}
export async function tokenAccounts(
  mint: string,
  program: string,
): Promise<{ owner: string; amount: bigint }[]> {
  const raw = await request((signal) =>
    rpc
      .getProgramAccounts(address(program), {
        encoding: "jsonParsed",
        commitment: "confirmed",
        filters: [
          {
            memcmp: {
              offset: 0n,
              bytes: address(mint) as unknown as Base58EncodedBytes,
              encoding: "base58",
            },
          },
        ],
      })
      .send({ abortSignal: signal }),
  );
  const rows = z.array(z.object({ account: parsedAccount })).parse(raw);
  return rows.map((row) => {
    if (
      row.account.owner !== program ||
      row.account.data.parsed.type !== "account"
    )
      throw new Error("Invalid token account response");
    const info = z
      .object({
        mint: z.literal(mint),
        owner: z.string(),
        tokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }),
      })
      .parse(row.account.data.parsed.info);
    return { owner: info.owner, amount: BigInt(info.tokenAmount.amount) };
  });
}
export async function signatures(
  program: string,
  before?: string,
): Promise<{ signature: string; err: unknown; slot: number }[]> {
  const rows = z
    .array(z.object({ signature: z.string(), err: z.unknown(), slot: integer }))
    .parse(
      await request((signal) =>
        rpc
          .getSignaturesForAddress(address(program), {
            limit: config.catchupPageSize,
            ...(before ? { before: before as never } : {}),
            commitment: "confirmed",
          })
          .send({ abortSignal: signal }),
      ),
    );
  return rows.map((r) => ({ ...r, slot: Number(r.slot) }));
}
export async function transactionLogs(
  signature: string,
): Promise<{ logs: string[]; slot: number } | null> {
  const raw = await request((signal) =>
    rpc
      .getTransaction(signature as never, {
        encoding: "json",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
      .send({ abortSignal: signal }),
  );
  if (raw === null) return null;
  const res = z
    .object({
      slot: integer,
      meta: z
        .object({
          err: z.unknown(),
          logMessages: z.array(z.string()).nullable(),
        })
        .nullable(),
    })
    .parse(raw);
  if (!res.meta || res.meta.err !== null || !res.meta.logMessages) return null;
  return { logs: res.meta.logMessages, slot: Number(res.slot) };
}
