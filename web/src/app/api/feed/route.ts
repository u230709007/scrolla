import type { NextRequest } from "next/server";
import { currentAddress } from "@/auth";
import { listCategory, listLiveFeed, listVideos } from "@/lib/server/feed";
import { FEED_CATEGORIES, type FeedCategory } from "@/lib/types";

/** First page is ranked by live trading activity (?order=new for plain newest-first).
 * ?cat=gainers|losers|whales lists only the reels of that category, newest first. */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const cursor = params.get("cursor");
  const limit = Math.min(Math.max(Number(params.get("limit")) || 8, 1), 30);
  const cat = params.get("cat") as FeedCategory | null;
  if (cat && !FEED_CATEGORIES.includes(cat)) {
    return Response.json({ error: "Unknown category" }, { status: 400 });
  }
  const viewer = await currentAddress();
  const page =
    cat && cat !== "live"
      ? await listCategory({ category: cat, cursor, limit, viewer })
      : cursor || params.get("order") === "new"
        ? await listVideos({ cursor, limit, viewer })
        : await listLiveFeed({ limit, viewer });
  return Response.json(page, { headers: { "Cache-Control": "no-store" } });
}
