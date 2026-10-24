import "server-only";
import { compareActivity, isLive, liveActivity, tokenKey } from "./activity";
import { MEDIA_BASE_URL } from "./config";
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

/** "videos/x.mp4" -> R2 public URL in production, /api/media/... locally. */
export const mediaUrl = (rel: string) => {
  const encoded = rel.split("/").map(encodeURIComponent).join("/");
  return MEDIA_BASE_URL ? `${MEDIA_BASE_URL}/${encoded}` : `/api/media/${encoded}`;
};

/** Uploads stored before R2 point at /api/media; resolve them like worker paths. */
export function resolveUpload(video: FeedVideo): FeedVideo {
  const local = "/api/media/";
  return video.videoUrl.startsWith(local)
    ? { ...video, videoUrl: mediaUrl(decodeURIComponent(video.videoUrl.slice(local.length))) }
    : video;
}

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

async function hasColumn(table: string, column: string): Promise<boolean> {
  const db = workerDb();
  if (!db) return false;
  return (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).some((c) => c.name === column);
}

function rowToVideo(r: VideoRow): Omit<FeedVideo, "likes" | "comments" | "trades" | "likedByMe"> {
  return {
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
  };
}

/** Cursor that starts the chronological feed from the top, handed out when the
 * live section filled the whole first page. */
export const CHRONO_START = "start";
/** How many recent worker videos compete for the live section. */
const LIVE_CANDIDATES = 200;

/**
 * First page of the feed: one video per token that is trading right now
 * (newest AlphaScroll buy first, then DexScreener 5m/1h trades), topped up
 * with the newest videos. Later pages continue chronologically via
 * listVideos, so pagination stays stable while the ranking moves.
 */
export async function listLiveFeed({
  limit = 10,
  viewer,
}: {
  limit?: number;
  viewer?: string | null;
}): Promise<FeedPage> {
  const db = workerDb();
  const extraCols = (await hasColumn("videos", "format")) ? ", format, persona" : "";
  const rows = db
    ? await db.all<VideoRow>(`SELECT *${extraCols} FROM videos ORDER BY created_at DESC, id DESC LIMIT ?`,
        LIVE_CANDIDATES)
    : [];
  const candidates = rows.map(rowToVideo);
  const newest = await listVideos({ limit, viewer });
  const minted = newest.videos.filter((v) => v.source !== "upload"); // uploads have no token
  const activity = await liveActivity([...candidates, ...minted].map((v) => v.token));
  const liveOf = (v: { token: TokenInfo; source?: string }) =>
    v.source === "upload" ? undefined : activity.get(tokenKey(v.token));

  const seen = new Set<string>();
  const hot = candidates
    .filter((v) => {
      const key = tokenKey(v.token);
      if (seen.has(key) || !isLive(activity.get(key))) return false;
      seen.add(key); // candidates are newest first: keep each token's latest video
      return true;
    })
    .sort((a, b) => compareActivity(liveOf(a)!, liveOf(b)!) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);

  const hotIds = new Set(hot.map((v) => v.id));
  const fill = newest.videos.filter((v) => !hotIds.has(v.id)).slice(0, limit - hot.length);
  const social = await socialCounts([...hotIds], viewer ?? null);
  const videos: FeedVideo[] = [
    ...hot.map((v) => ({ ...v, ...social(v.id), live: liveOf(v) })),
    ...fill.map((v) => (isLive(liveOf(v)) ? { ...v, live: liveOf(v) } : v)),
  ];

  const lastFill = fill.at(-1);
  const moreAfterFill =
    !!newest.nextCursor || fill.length < newest.videos.filter((v) => !hotIds.has(v.id)).length;
  return {
    videos,
    nextCursor: lastFill
      ? moreAfterFill
        ? `${lastFill.createdAt}|${lastFill.id}`
        : null
      : newest.videos.length
        ? CHRONO_START
        : null,
  };
}

/** Cursor = "<created_at>|<id>" of the last item on the previous page. */
export async function listVideos({
  cursor,
  limit = 10,
  viewer,
}: {
  cursor?: string | null;
  limit?: number;
  viewer?: string | null;
}): Promise<FeedPage> {
  const db = workerDb();

  // `format`/`persona` were added later; older worker DBs don't have them.
  const extraCols = (await hasColumn("videos", "format")) ? ", format, persona" : "";
  const [cAt, cId] = cursor && cursor !== CHRONO_START ? cursor.split("|") : [null, null];
  const rows = !db
    ? []
    : cAt && cId
      ? await db.all<VideoRow>(
          `SELECT *${extraCols} FROM videos WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?`,
          cAt, cId, limit + 1,
        )
      : await db.all<VideoRow>(
          `SELECT *${extraCols} FROM videos ORDER BY created_at DESC, id DESC LIMIT ?`,
          limit + 1,
        );

  const page = rows.slice(0, limit);
  const social = await socialCounts(
    page.map((r) => r.id),
    viewer ?? null,
  );

  const videos: FeedVideo[] = page.map((r) => ({ ...rowToVideo(r), ...social(r.id) }));

  const app = await appDb();
  const uploaded =
    cAt && cId
      ? await app.all<{ video_json: string }>(
          "SELECT video_json FROM uploads WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?",
          cAt, cId, limit + 1,
        )
      : await app.all<{ video_json: string }>(
          "SELECT video_json FROM uploads ORDER BY created_at DESC, id DESC LIMIT ?",
          limit + 1,
        );
  const uploads = uploaded.map((r) => resolveUpload(JSON.parse(r.video_json) as FeedVideo));
  const counts = await socialCounts(
    uploads.map((v) => v.id),
    viewer ?? null,
  );
  const combined = [
    ...videos,
    ...uploads.map((v) => ({ ...v, ...counts(v.id) })),
  ].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  const result = combined.slice(0, limit);
  const last = result.at(-1);
  return {
    videos: result,
    nextCursor:
      (combined.length > limit || rows.length > limit) && last
        ? `${last.createdAt}|${last.id}`
        : null,
  };
}

export async function videoExists(id: string): Promise<boolean> {
  const db = workerDb();
  return (
    !!(db && (await db.get("SELECT 1 FROM videos WHERE id = ?", id))) ||
    !!(await (await appDb()).get("SELECT 1 FROM uploads WHERE id = ?", id))
  );
}

export async function getVideoToken(id: string): Promise<TokenInfo | null> {
  const row = await workerDb()?.get<VideoRow>("SELECT * FROM videos WHERE id = ?", id);
  return row ? toToken(row) : null;
}

/** A single reel by id (worker or user upload), with social counts for `viewer`. */
export async function getVideo(id: string, viewer: string | null): Promise<FeedVideo | null> {
  const db = workerDb();
  const extraCols = (await hasColumn("videos", "format")) ? ", format, persona" : "";
  const row = db ? await db.get<VideoRow>(`SELECT *${extraCols} FROM videos WHERE id = ?`, id) : undefined;
  let video: Omit<FeedVideo, "likes" | "comments" | "trades" | "likedByMe"> | null = row ? rowToVideo(row) : null;
  if (!video) {
    const up = await (await appDb()).get<{ video_json: string }>("SELECT video_json FROM uploads WHERE id = ?", id);
    if (up) video = resolveUpload(JSON.parse(up.video_json) as FeedVideo);
  }
  if (!video) return null;
  return { ...video, ...(await socialCounts([id], viewer))(id) };
}


async function socialCounts(ids: string[], viewer: string | null) {
  const empty = { likes: 0, comments: 0, trades: 0, likedByMe: false };
  if (!ids.length) return () => empty;
  const db = await appDb();
  const marks = ids.map(() => "?").join(",");
  const count = async (table: string) =>
    new Map(
      (
        await db.all<{ video_id: string; n: number }>(
          `SELECT video_id, COUNT(*) AS n FROM ${table} WHERE video_id IN (${marks}) GROUP BY video_id`,
          ...ids,
        )
      ).map((r) => [r.video_id, Number(r.n)]),
    );
  const [likes, comments, trades] = await Promise.all([count("likes"), count("comments"), count("trades")]);
  const mine = viewer
    ? new Set(
        (
          await db.all<{ video_id: string }>(
            `SELECT video_id FROM likes WHERE address = ? AND video_id IN (${marks})`,
            viewer, ...ids,
          )
        ).map((r) => r.video_id),
      )
    : new Set<string>();

  return (id: string) => ({
    likes: likes.get(id) ?? 0,
    comments: comments.get(id) ?? 0,
    trades: trades.get(id) ?? 0,
    likedByMe: mine.has(id),
  });
}
