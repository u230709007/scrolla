import { currentAddress } from "@/auth";
import { appDb } from "@/lib/server/db";

const NO_STORE = { "Cache-Control": "no-store" };

/** The signed-in user's saved videos, newest first. */
export async function GET() {
  const me = await currentAddress();
  if (!me) return Response.json({ videos: [] }, { headers: NO_STORE });
  const rows = await (await appDb()).all<{ video_json: string }>(
    "SELECT video_json FROM saved_videos WHERE lower(address) = lower(?) ORDER BY created_at DESC",
    me,
  );
  const videos = rows.flatMap((r) => {
    try {
      return [JSON.parse(r.video_json)];
    } catch {
      return [];
    }
  });
  return Response.json({ videos }, { headers: NO_STORE });
}

/** Save or unsave a video: body { video, saved } (or { videos } to bulk import). */
export async function POST(req: Request) {
  const me = await currentAddress();
  if (!me) return Response.json({ error: "Sign in" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    video?: { id?: unknown };
    videos?: { id?: unknown }[];
    saved?: boolean;
  };
  const db = await appDb();
  const items = body.videos ?? (body.video ? [body.video] : []);
  for (const v of items.slice(0, 200)) {
    if (!v || typeof v.id !== "string") continue;
    if (body.saved === false) {
      await db.run("DELETE FROM saved_videos WHERE lower(address) = lower(?) AND video_id = ?", me, v.id);
    } else {
      await db.run(
        "INSERT OR IGNORE INTO saved_videos (address, video_id, video_json) VALUES (?, ?, ?)",
        me, v.id, JSON.stringify(v),
      );
    }
  }
  return Response.json({ ok: true });
}
