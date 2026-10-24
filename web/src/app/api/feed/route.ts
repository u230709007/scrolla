import type { NextRequest } from "next/server";
import { currentAddress } from "@/auth";
import { listLiveFeed, listVideos } from "@/lib/server/feed";

/** First page is ranked by live trading activity (?order=new for plain newest-first). */
export async function GET(req: NextRequest) {
  const cursor = req.nextUrl.searchParams.get("cursor");
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 8, 1), 30);
  const viewer = await currentAddress();
  const page =
    cursor || req.nextUrl.searchParams.get("order") === "new"
      ? await listVideos({ cursor, limit, viewer })
      : await listLiveFeed({ limit, viewer });
  return Response.json(page, { headers: { "Cache-Control": "no-store" } });
}
