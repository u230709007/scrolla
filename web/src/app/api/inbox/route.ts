import { currentAddress } from "@/auth";
import { appDb } from "@/lib/server/db";

type Row = { id: number; video_id: string; from_address: string; seen: number; created_at: string };

export async function GET() {
  const me = await currentAddress();
  if (!me) return Response.json({ items: [], unseen: 0 }, { headers: { "Cache-Control": "no-store" } });
  const rows = await (await appDb()).all<Row>(
    "SELECT id, video_id, from_address, seen, created_at FROM shares WHERE to_address = ? ORDER BY id DESC LIMIT 50",
    me,
  );
  const items = rows.map((r) => ({
    id: Number(r.id),
    videoId: r.video_id,
    from: r.from_address,
    seen: !!Number(r.seen),
    createdAt: r.created_at,
  }));
  return Response.json({ items, unseen: items.filter((i) => !i.seen).length }, { headers: { "Cache-Control": "no-store" } });
}

/** Mark everything in my inbox as seen. */
export async function POST() {
  const me = await currentAddress();
  if (!me) return Response.json({ error: "Sign in" }, { status: 401 });
  await (await appDb()).run("UPDATE shares SET seen = 1 WHERE to_address = ? AND seen = 0", me);
  return Response.json({ ok: true });
}
