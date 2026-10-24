import { currentAddress } from "@/auth";
import { appDb } from "@/lib/server/db";

/** Follower / following counts for the signed-in user. */
export async function GET() {
  const me = await currentAddress();
  if (!me) return Response.json({ followers: 0, following: 0 });
  const row = await (await appDb()).get<{ followers: number; following: number }>(
    `SELECT (SELECT COUNT(*) FROM follows WHERE lower(followee) = lower(?1)) AS followers,
            (SELECT COUNT(*) FROM follows WHERE lower(follower) = lower(?1)) AS following`,
    me,
  );
  return Response.json(
    { followers: Number(row?.followers ?? 0), following: Number(row?.following ?? 0) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
