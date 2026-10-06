import { type Holders, type Quote, type Token } from "../shared/types.js";
import { config } from "../config.js";
import { mintInfo, tokenAccounts } from "./rpc.js";
export function summarizeHolders(
  accounts: { owner: string; amount: bigint }[],
  supply: bigint,
  creator: string,
  excluded: string[],
  now = Date.now(),
): Holders {
  if (supply <= 0n) throw new Error("Invalid supply");
  const owners = new Map<string, bigint>();
  let total = 0n;
  for (const a of accounts) {
    if (a.amount < 0n) throw new Error("Negative holding");
    total += a.amount;
    owners.set(a.owner, (owners.get(a.owner) ?? 0n) + a.amount);
  }
  // A complete response must account for minted supply. Token-2022 withheld fees or
  // inconsistent snapshots cause rejection instead of falsely low concentration.
  if (total !== supply)
    throw new Error("Incomplete or inconsistent holder snapshot");
  const creatorAmount = owners.get(creator) ?? 0n;
  for (const owner of excluded) owners.delete(owner);
  const holdings = [...owners.values()]
    .filter((v) => v > 0n)
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const top = holdings
    .slice(0, config.topHolderCount)
    .reduce((a, b) => a + b, 0n);
  return {
    timestamp: now,
    count: holdings.length,
    creatorRaw: creatorAmount.toString(),
    creatorFraction: Number(creatorAmount) / Number(supply),
    topFraction: Number(top) / Number(supply),
  };
}
export async function fetchHolders(
  token: Token,
  quote: Quote,
): Promise<Holders> {
  const startedAt = Date.now();
  const mint = await mintInfo(token.mint);
  if (mint.supply.toString() !== quote.supply)
    throw new Error("Supply changed");
  return summarizeHolders(
    await tokenAccounts(token.mint, mint.program),
    mint.supply,
    token.creator,
    quote.vaultOwners,
    startedAt,
  );
}
