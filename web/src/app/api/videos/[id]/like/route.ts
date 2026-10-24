import { currentAddress } from "@/auth";
import { appDb } from "@/lib/server/db";
import { videoExists } from "@/lib/server/feed";

/** Toggle (or force with {"liked": true}) the viewer's like on a video. */
export async function POST(req: Request, ctx: RouteContext<"/api/videos/[id]/like">) {
  const address = await currentAddress();
  if (!address) return Response.json({ error: "Sign in to like videos" }, { status: 401 });

  const { id } = await ctx.params;
  if (!videoExists(id)) return Response.json({ error: "Video not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { liked?: boolean };
  const db = appDb();
  const already = !!db.prepare("SELECT 1 FROM likes WHERE video_id = ? AND address = ?").get(id, address);
  const liked = typeof body.liked === "boolean" ? body.liked : !already;

  if (liked && !already) db.prepare("INSERT INTO likes (video_id, address) VALUES (?, ?)").run(id, address);
  if (!liked && already) db.prepare("DELETE FROM likes WHERE video_id = ? AND address = ?").run(id, address);

  const { n } = db.prepare("SELECT COUNT(*) AS n FROM likes WHERE video_id = ?").get(id) as { n: number };
  return Response.json({ liked, likes: Number(n) });
}
