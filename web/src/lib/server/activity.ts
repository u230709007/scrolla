import "server-only";
import { appDb } from "./db";
import type { LiveActivity, TokenInfo } from "@/lib/types";

/** In-app buys older than this don't count as "live". */
export const LIVE_WINDOW_MIN = 60;
const DEX_TTL_MS = 20_000;
const DEX_BATCH = 30; // /tokens/v1 accepts up to 30 comma-separated addresses

type DexPair = {
  baseToken?: { address?: string };
  txns?: { m5?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
};
type DexTxns = { txns5m: number; txns1h: number };

const dexCache = new Map<string, { at: number; txns: DexTxns }>();

// GeckoTerminal: individual trades per pool (free, ~30 req/min, no key).
const GT_TTL_MS = 30_000; // matches their own Cache-Control
const GT_MAX_POOLS = 8; // per feed request, busiest tokens only
const GT_BACKOFF_MS = 60_000;
const BIG_BUY_WINDOW_MS = 15 * 60_000;
/** DexScreener chain ids that GeckoTerminal names differently. */
const GT_NETWORK: Record<string, string> = { ethereum: "eth", polygon: "polygon_pos", avalanche: "avax" };

type GtTrade = {
  attributes?: { block_timestamp?: string; kind?: string; volume_in_usd?: string; is_anomalous?: boolean };
};
type PoolTrades = { lastTradeAt: string | null; largestBuyUsd15m: number };

const gtCache = new Map<string, { at: number; trades: PoolTrades }>();
let gtBlockedUntil = 0;

async function poolTrades(chain: string, pool: string): Promise<PoolTrades | null> {
  const id = `${chain}:${pool.toLowerCase()}`;
  const hit = gtCache.get(id);
  if (hit && Date.now() - hit.at < GT_TTL_MS) return hit.trades;
  if (Date.now() < gtBlockedUntil) return hit?.trades ?? null;

  const network = GT_NETWORK[chain] ?? chain;
  const url = `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(pool)}/trades`;
  const res = await fetch(url, { signal: AbortSignal.timeout(3000), cache: "no-store" }).catch(() => null);
  if (res?.status === 429) gtBlockedUntil = Date.now() + GT_BACKOFF_MS;
  if (!res?.ok) return hit?.trades ?? null;

  const rows = (((await res.json().catch(() => ({}))) as { data?: GtTrade[] }).data ?? [])
    .map((t) => t.attributes ?? {})
    .filter((t) => t.block_timestamp && !t.is_anomalous);
  const since = Date.now() - BIG_BUY_WINDOW_MS;
  const trades: PoolTrades = {
    // newest first in the API, but don't rely on it
    lastTradeAt: rows.reduce<string | null>((max, t) => (!max || t.block_timestamp! > max ? t.block_timestamp! : max), null),
    largestBuyUsd15m: Math.max(
      0,
      ...rows
        .filter((t) => t.kind === "buy" && Date.parse(t.block_timestamp!) >= since)
        .map((t) => Number(t.volume_in_usd) || 0),
    ),
  };
  gtCache.set(id, { at: Date.now(), trades });
  return trades;
}

/** Same token across videos, uploads and the trades table. */
export function tokenKey(t: Pick<TokenInfo, "tokenAddress" | "symbol">): string {
  return t.tokenAddress ? t.tokenAddress.toLowerCase() : `sym:${t.symbol.toUpperCase()}`;
}

/** Testnet pools and mock tokens aren't on DexScreener. */
const onDexScreener = (t: TokenInfo) => !!t.tokenAddress && !t.chain.includes("testnet");

async function appTrades(sinceIso: string): Promise<Map<string, { last: string; count: number }>> {
  const rows = await (await appDb()).all<{ token_address: string | null; token_symbol: string; last: string; n: number }>(
    `SELECT token_address, token_symbol, MAX(created_at) AS last, COUNT(*) AS n
     FROM trades WHERE created_at >= ? GROUP BY token_address, token_symbol`,
    sinceIso,
  );
  const out = new Map<string, { last: string; count: number }>();
  for (const r of rows) {
    const key = tokenKey({ tokenAddress: r.token_address, symbol: r.token_symbol });
    const prev = out.get(key);
    out.set(key, {
      last: prev && prev.last > r.last ? prev.last : r.last,
      count: (prev?.count ?? 0) + Number(r.n),
    });
  }
  return out;
}

/** 5m / 1h trade counts summed over every pair of each token. Cached 20s;
 * a DexScreener outage just means no on-chain signal, never a broken feed. */
async function dexTxns(tokens: TokenInfo[]): Promise<Map<string, DexTxns>> {
  const out = new Map<string, DexTxns>();
  const missing = new Map<string, Set<string>>(); // chain -> addresses
  for (const t of tokens.filter(onDexScreener)) {
    const id = `${t.chain}:${tokenKey(t)}`;
    const hit = dexCache.get(id);
    if (hit && Date.now() - hit.at < DEX_TTL_MS) out.set(tokenKey(t), hit.txns);
    else missing.set(t.chain, (missing.get(t.chain) ?? new Set()).add(t.tokenAddress!));
  }

  const jobs: Promise<void>[] = [];
  for (const [chain, set] of missing) {
    const addrs = [...set];
    for (let i = 0; i < addrs.length; i += DEX_BATCH) {
      const batch = addrs.slice(i, i + DEX_BATCH);
      const url = `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chain)}/${batch.join(",")}`;
      jobs.push(
        fetch(url, { signal: AbortSignal.timeout(3000), cache: "no-store" })
          .then((r) => (r.ok ? (r.json() as Promise<DexPair[]>) : []))
          .catch(() => [] as DexPair[])
          .then((pairs) => {
            const sums = new Map<string, DexTxns>(batch.map((a) => [a.toLowerCase(), { txns5m: 0, txns1h: 0 }]));
            for (const p of Array.isArray(pairs) ? pairs : []) {
              const s = sums.get(p.baseToken?.address?.toLowerCase() ?? "");
              if (!s) continue;
              s.txns5m += (p.txns?.m5?.buys ?? 0) + (p.txns?.m5?.sells ?? 0);
              s.txns1h += (p.txns?.h1?.buys ?? 0) + (p.txns?.h1?.sells ?? 0);
            }
            for (const [key, txns] of sums) {
              dexCache.set(`${chain}:${key}`, { at: Date.now(), txns });
              out.set(key, txns);
            }
          }),
      );
    }
  }
  await Promise.all(jobs);
  return out;
}

/** Live trading activity per token key: Scrolla buys from the last
 * LIVE_WINDOW_MIN minutes, market-wide trade counts from DexScreener, and for
 * the busiest tokens the exact time of the last on-chain trade from GeckoTerminal. */
export async function liveActivity(tokens: TokenInfo[]): Promise<Map<string, LiveActivity>> {
  const sinceMs = Date.now() - LIVE_WINDOW_MIN * 60_000;
  const [app, dex] = await Promise.all([appTrades(new Date(sinceMs).toISOString()), dexTxns(tokens)]);
  const out = new Map<string, LiveActivity>();
  const pools = new Map<string, TokenInfo>(); // token key -> first token seen (has the pool)
  for (const t of tokens) {
    const key = tokenKey(t);
    if (out.has(key)) continue;
    const a = app.get(key);
    const d = dex.get(key);
    out.set(key, {
      lastTradeAt: a?.last ?? null,
      appTrades1h: a?.count ?? 0,
      txns5m: d?.txns5m ?? 0,
      txns1h: d?.txns1h ?? 0,
      lastMarketTradeAt: null,
      largestBuyUsd15m: 0,
    });
    if (onDexScreener(t) && t.pairAddress && (d?.txns1h ?? 0) > 0) pools.set(key, t);
  }

  const busiest = [...pools.entries()]
    .sort(([a], [b]) => compareActivity(out.get(a)!, out.get(b)!))
    .slice(0, GT_MAX_POOLS);
  await Promise.all(
    busiest.map(async ([key, t]) => {
      const trades = await poolTrades(t.chain, t.pairAddress!).catch(() => null);
      const live = out.get(key)!;
      if (trades?.lastTradeAt && Date.parse(trades.lastTradeAt) >= sinceMs) {
        live.lastMarketTradeAt = trades.lastTradeAt;
      }
      live.largestBuyUsd15m = trades?.largestBuyUsd15m ?? 0;
    }),
  );
  return out;
}

export const isLive = (a: LiveActivity | undefined) =>
  !!a && (a.appTrades1h > 0 || a.txns5m > 0 || a.txns1h > 0 || !!a.lastMarketTradeAt);

/** Freshest in-app buy first (the strongest signal: people trading from the
 * feed right now), then the freshest on-chain trade, then trade counts. */
export function compareActivity(a: LiveActivity, b: LiveActivity): number {
  return (
    (b.lastTradeAt ?? "").localeCompare(a.lastTradeAt ?? "") ||
    (b.lastMarketTradeAt ?? "").localeCompare(a.lastMarketTradeAt ?? "") ||
    b.txns5m - a.txns5m ||
    b.txns1h - a.txns1h
  );
}
