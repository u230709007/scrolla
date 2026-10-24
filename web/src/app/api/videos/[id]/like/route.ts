import { currentAddress } from "@/auth";
import { appDb } from "@/lib/server/db";
import { videoExists } from "@/lib/server/feed";

/** Toggle (or force with {"liked": true}) the viewer's like on a video. */
export async function POST(req: Request, ctx: RouteContext<"/api/videos/[id]/like">) {
  const address = await currentAddress();
  if (!address) return Response.json({ error: "Sign in to like videos" }, { status: 401 });

  const { id } = await ctx.params;
  if (!(await videoExists(id))) return Response.json({ error: "Video not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { liked?: boolean };
  const db = await appDb();
  const already = !!(await db.get("SELECT 1 FROM likes WHERE video_id = ? AND address = ?", id, address));
  const liked = typeof body.liked === "boolean" ? body.liked : !already;

  if (liked && !already) await db.run("INSERT INTO likes (video_id, address) VALUES (?, ?)", id, address);
  if (!liked && already) await db.run("DELETE FROM likes WHERE video_id = ? AND address = ?", id, address);

  const { n } = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM likes WHERE video_id = ?", id))!;
  return Response.json({ liked, likes: Number(n) });
}
