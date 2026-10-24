import "server-only";
import { appDb, workerDb } from "./db";
import type { FeedPage, FeedVideo, TokenInfo } from "@/lib/types";

type VideoRow = {
  id: string;
  created_at: string;
  video_path: string;
  thumbnail: string;
  duration: number;
  token_symbol: string;
  token_name: string;
  chain: string;
  pair_address: string | null;
  price_usd: number | null;
  change_24h: number | null;
  volume_24h: number | null;
  market_cap: number | null;
  narration: string | null;
  hook: string | null;
  token_json: string | null;
  format?: string | null;
  persona?: string | null;
};

const mediaUrl = (rel: string) => `/api/media/${rel.split("/").map(encodeURIComponent).join("/")}`;

function toToken(row: VideoRow): TokenInfo {
  let extra: Record<string, unknown> = {};
  try {
    extra = row.token_json ? JSON.parse(row.token_json) : {};
  } catch {
    // Older rows may hold malformed JSON; the flat columns are enough.
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    symbol: row.token_symbol,
    name: row.token_name,
    chain: row.chain,
    pairAddress: row.pair_address || null,
    tokenAddress: str(extra.token_address),
    dexUrl: str(extra.dex_url),
    priceUsd: row.price_usd ?? 0,
    change24h: row.change_24h ?? 0,
    volume24h: row.volume_24h ?? 0,
    liquidityUsd: Number(extra.liquidity_usd ?? 0),
    marketCap: row.market_cap ?? 0,
  };
}

function hasColumn(table: string, column: string): boolean {
  const db = workerDb();
  if (!db) return false;
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** Cursor = "<created_at>|<id>" of the last item on the previous page. */
export function listVideos({ cursor, limit = 10, viewer }: { cursor?: string | null; limit?: number; viewer?: string | null }): FeedPage {
  const db = workerDb();
  if (!db) return { videos: [], nextCursor: null };

  // `format`/`persona` were added later; older worker DBs don't have them.
  const extraCols = hasColumn("videos", "format") ? ", format, persona" : "";
  const [cAt, cId] = cursor ? cursor.split("|") : [null, null];
  const rows = (
    cAt && cId
      ? db
          .prepare(
            `SELECT *${extraCols} FROM videos WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(cAt, cId, limit + 1)
      : db.prepare(`SELECT *${extraCols} FROM videos ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit + 1)
  ) as unknown as VideoRow[];

  const page = rows.slice(0, limit);
  const social = socialCounts(page.map((r) => r.id), viewer ?? null);

  const videos: FeedVideo[] = page.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    videoUrl: mediaUrl(r.video_path),
    posterUrl: mediaUrl(r.thumbnail),
    duration: r.duration,
    format: r.format === "avatar" ? "avatar" : "classic",
    persona: r.persona ?? null,
    hook: r.hook ?? "",
    narration: r.narration ?? "",
    token: toToken(r),
    ...social(r.id),
  }));

  const last = page.at(-1);
  return { videos, nextCursor: rows.length > limit && last ? `${last.created_at}|${last.id}` : null };
}

export function videoExists(id: string): boolean {
  const db = workerDb();
  return !!db?.prepare("SELECT 1 FROM videos WHERE id = ?").get(id);
}

export function getVideoToken(id: string): TokenInfo | null {
  const row = workerDb()?.prepare("SELECT * FROM videos WHERE id = ?").get(id) as unknown as VideoRow | undefined;
  return row ? toToken(row) : null;
}

function socialCounts(ids: string[], viewer: string | null) {
  const empty = { likes: 0, comments: 0, trades: 0, likedByMe: false };
  if (!ids.length) return () => empty;
  const db = appDb();
  const marks = ids.map(() => "?").join(",");
  const count = (table: string) =>
    new Map(
      (db.prepare(`SELECT video_id, COUNT(*) AS n FROM ${table} WHERE video_id IN (${marks}) GROUP BY video_id`).all(
        ...ids,
      ) as { video_id: string; n: number }[]).map((r) => [r.video_id, Number(r.n)]),
    );
  const likes = count("likes");
  const comments = count("comments");
  const trades = count("trades");
  const mine = viewer
    ? new Set(
        (db.prepare(`SELECT video_id FROM likes WHERE address = ? AND video_id IN (${marks})`).all(viewer, ...ids) as {
          video_id: string;
        }[]).map((r) => r.video_id),
      )
    : new Set<string>();

  return (id: string) => ({
    likes: likes.get(id) ?? 0,
    comments: comments.get(id) ?? 0,
    trades: trades.get(id) ?? 0,
    likedByMe: mine.has(id),
  });
}
