export type TokenInfo = {
  symbol: string;
  name: string;
  chain: string;
  pairAddress: string | null;
  tokenAddress: string | null;
  dexUrl: string | null;
  priceUsd: number;
  change24h: number;
  volume24h: number;
  liquidityUsd: number;
  marketCap: number;
};

export type FeedVideo = {
  creator?: string;
  source?: "upload";
  id: string;
  createdAt: string;
  videoUrl: string;
  posterUrl: string;
  duration: number;
  format: "classic" | "avatar";
  persona: string | null;
  hook: string;
  narration: string;
  token: TokenInfo;
  likes: number;
  comments: number;
  trades: number;
  likedByMe: boolean;
  /** Present on the live-ranked first page (see lib/server/activity.ts). */
  live?: LiveActivity;
};

export type LiveActivity = {
  /** Newest Scrolla buy of this token within the live window. */
  lastTradeAt: string | null;
  appTrades1h: number;
  /** Market-wide buys + sells from DexScreener. */
  txns5m: number;
  txns1h: number;
  /** Newest on-chain trade within the live window (GeckoTerminal). */
  lastMarketTradeAt: string | null;
  largestBuyUsd15m: number;
};

export type FeedPage = { videos: FeedVideo[]; nextCursor: string | null };

/** live: what trades right now; the others filter worker reels by their token. */
export const FEED_CATEGORIES = ["live", "gainers", "losers", "whales"] as const;
export type FeedCategory = (typeof FEED_CATEGORIES)[number];

export type Comment = { id: number; address: string; body: string; createdAt: string };

export type LiveStats = Pick<TokenInfo, "priceUsd" | "change24h" | "volume24h" | "liquidityUsd" | "marketCap"> & {
  live: boolean;
  updatedAt: string;
};
