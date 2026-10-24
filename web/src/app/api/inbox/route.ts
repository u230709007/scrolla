import { currentAddress } from "@/auth";
import { appDb } from "@/lib/server/db";

type Row = {
  kind: "share" | "follow" | "join";
  id: string;
  video_id: string | null;
  from_address: string;
  seen: number;
  following: number;
  created_at: string;
};

/** Notifications: reels sent to me, new followers and newly joined users.
 * Shares keep their own seen flag; the rest are unseen until inbox_reads.seen_at. */
export async function GET() {
  const me = await currentAddress();
  if (!me) return Response.json({ items: [], unseen: 0 }, { headers: { "Cache-Control": "no-store" } });
  const rows = await (await appDb()).all<Row>(
    `WITH r AS (SELECT COALESCE((SELECT seen_at FROM inbox_reads WHERE address = ?1), '') AS seen_at)
     SELECT n.*, EXISTS (SELECT 1 FROM follows f WHERE f.follower = ?1 AND f.followee = n.from_address) AS following
       FROM (
       SELECT 'share' AS kind, 's' || s.id AS id, s.video_id, s.from_address, s.seen, s.created_at
         FROM shares s WHERE s.to_address = ?1
       UNION ALL
       SELECT 'follow', 'f' || f.follower, NULL, f.follower, f.created_at <= r.seen_at, f.created_at
         FROM follows f, r WHERE f.followee = ?1
       UNION ALL
       SELECT 'join', 'j' || u.address, NULL, u.address, u.created_at <= r.seen_at, u.created_at
         FROM users u, r
        WHERE u.address <> ?1 AND u.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
          AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower = u.address AND f.followee = ?1)
     ) n
     ORDER BY created_at DESC LIMIT 50`,
    me,
  );
  const items = rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    videoId: r.video_id,
    from: r.from_address,
    seen: !!Number(r.seen),
    following: !!Number(r.following),
    createdAt: r.created_at,
  }));
  return Response.json({ items, unseen: items.filter((i) => !i.seen).length }, { headers: { "Cache-Control": "no-store" } });
}

/** Mark everything in my inbox as seen. */
export async function POST() {
  const me = await currentAddress();
  if (!me) return Response.json({ error: "Sign in" }, { status: 401 });
  const db = await appDb();
  await db.run("UPDATE shares SET seen = 1 WHERE to_address = ? AND seen = 0", me);
  await db.run(
    `INSERT INTO inbox_reads (address, seen_at) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(address) DO UPDATE SET seen_at = excluded.seen_at`,
    me,
  );
  return Response.json({ ok: true });
}
