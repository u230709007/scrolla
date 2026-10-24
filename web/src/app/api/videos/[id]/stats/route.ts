import { getVideoToken } from "@/lib/server/feed";
import type { LiveStats, TokenInfo } from "@/lib/types";

const TTL_MS = 15_000;
const cache = new Map<string, { at: number; stats: LiveStats }>();

type DexPair = {
  priceUsd?: string;
  priceChange?: { h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
};

async function fetchLive(token: TokenInfo): Promise<LiveStats | null> {
  if (!token.pairAddress) return null;
  const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(token.chain)}/${encodeURIComponent(token.pairAddress)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000), cache: "no-store" });
  if (!res.ok) return null;
  const pair = ((await res.json()) as { pairs?: DexPair[] }).pairs?.[0];
  if (!pair) return null; // mock tokens have no real pair
  return {
    priceUsd: Number(pair.priceUsd ?? token.priceUsd),
    change24h: Number(pair.priceChange?.h24 ?? token.change24h),
    volume24h: Number(pair.volume?.h24 ?? token.volume24h),
    liquidityUsd: Number(pair.liquidity?.usd ?? token.liquidityUsd),
    marketCap: Number(pair.marketCap ?? pair.fdv ?? token.marketCap),
    live: true,
    updatedAt: new Date().toISOString(),
  };
}

/** Live DexScreener stats for the video's token, falling back to the
 * snapshot the worker recorded at render time. Cached 15s per video. */
export async function GET(_req: Request, ctx: RouteContext<"/api/videos/[id]/stats">) {
  const { id } = await ctx.params;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return Response.json(hit.stats);

  const token = await getVideoToken(id);
  if (!token) return Response.json({ error: "Video not found" }, { status: 404 });

  const stats: LiveStats = (await fetchLive(token).catch(() => null)) ?? {
    priceUsd: token.priceUsd,
    change24h: token.change24h,
    volume24h: token.volume24h,
    liquidityUsd: token.liquidityUsd,
    marketCap: token.marketCap,
    live: false,
    updatedAt: new Date().toISOString(),
  };
  cache.set(id, { at: Date.now(), stats });
  return Response.json(stats);
}
