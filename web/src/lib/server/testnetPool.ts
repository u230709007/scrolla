import "server-only";
import { type Address, createPublicClient, http, parseAbi } from "viem";
import { monadTestnet } from "viem/chains";
import { appDb } from "./db";
import { IS_TESTNET, ROUTER_ADDRESS, RPC_URL } from "@/lib/web3/chain";
import type { LiveStats, TokenInfo } from "@/lib/types";

// Same math as testnet_pool_stats() in worker/video_worker.py.
const client = createPublicClient({ chain: monadTestnet, transport: http(IS_TESTNET ? RPC_URL : undefined) });
const abi = parseAbi([
  "function pools(address) view returns (uint128 reserveNative, uint128 reserveToken)",
  "function totalSupply() view returns (uint256)",
]);

const MON_TTL_MS = 60_000;
let monCache: { at: number; usd: number; change24h: number } | null = null;

/** Real MON/USD from CoinGecko: testnet pools have no market of their own. */
async function monUsd() {
  if (monCache && Date.now() - monCache.at < MON_TTL_MS) return monCache;
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd&include_24hr_change=true", {
    signal: AbortSignal.timeout(4000),
    cache: "no-store",
  }).catch(() => null);
  const data = res?.ok ? ((await res.json()) as { monad?: { usd?: number; usd_24h_change?: number } }).monad : undefined;
  if (data?.usd) monCache = { at: Date.now(), usd: data.usd, change24h: data.usd_24h_change ?? 0 };
  return monCache; // stale beats nothing when CoinGecko rate-limits
}

/** MON in / tokens out (wei) of the last 24h of on-chain Scrolla buys. */
async function buys24h(token: Address) {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const rows = await (await appDb()).all<{ amount_in_wei: string; amount_out: string | null }>(
    `SELECT amount_in_wei, amount_out FROM trades
     WHERE mode = 'onchain' AND lower(token_address) = ? AND created_at >= ?`,
    token.toLowerCase(),
    since,
  );
  return rows.reduce(
    (s, r) => ({ in: s.in + BigInt(r.amount_in_wei || 0), out: s.out + BigInt(r.amount_out || 0) }),
    { in: 0n, out: 0n },
  );
}

/** Live stats of a setup:testnet pool, or null when it can't be read. */
export async function testnetStats(token: TokenInfo): Promise<LiveStats | null> {
  if (token.chain !== "monad-testnet" || !token.tokenAddress) return null;
  const address = token.tokenAddress as Address;
  const [[reserveMon, reserveTok], supply, mon, bought] = await Promise.all([
    client.readContract({ address: ROUTER_ADDRESS, abi, functionName: "pools", args: [address] }),
    client.readContract({ address, abi, functionName: "totalSupply" }),
    monUsd(),
    buys24h(address),
  ]);
  if (!mon || !reserveMon || !reserveTok) return null;

  const eth = (wei: bigint) => Number(wei) / 1e18;
  const price = (eth(reserveMon) / eth(reserveTok)) * mon.usd;
  // Undo the last 24h of buys: each one added MON to the pool and took tokens out
  const thenMon = reserveMon - bought.in;
  const priceThen = thenMon > 0n ? (eth(thenMon) / eth(reserveTok + bought.out)) * (mon.usd / (1 + mon.change24h / 100)) : price;
  return {
    priceUsd: price,
    change24h: (price / priceThen - 1) * 100,
    volume24h: eth(bought.in) * mon.usd,
    liquidityUsd: 2 * eth(reserveMon) * mon.usd,
    marketCap: price * eth(supply),
    live: true,
    updatedAt: new Date().toISOString(),
  };
}
