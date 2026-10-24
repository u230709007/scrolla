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
};

export type FeedPage = { videos: FeedVideo[]; nextCursor: string | null };

export type Comment = { id: number; address: string; body: string; createdAt: string };

export type LiveStats = Pick<TokenInfo, "priceUsd" | "change24h" | "volume24h" | "liquidityUsd" | "marketCap"> & {
  live: boolean;
  updatedAt: string;
};
