import type { NextRequest } from "next/server";
import { currentAddress } from "@/auth";
import { listVideos } from "@/lib/server/feed";

export async function GET(req: NextRequest) {
  const cursor = req.nextUrl.searchParams.get("cursor");
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 8, 1), 30);
  const page = listVideos({ cursor, limit, viewer: await currentAddress() });
  return Response.json(page, { headers: { "Cache-Control": "no-store" } });
}
