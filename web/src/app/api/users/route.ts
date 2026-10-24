import { currentAddress } from "@/auth";
import { appDb } from "@/lib/server/db";

type Row = { address: string; following: number; follows_me: number };

/** Other registered users, people I already follow first, then newest.
 * ?list=followers|following narrows it to my followers / people I follow. */
export async function GET(req: Request) {
  const me = await currentAddress();
  if (!me) return Response.json({ error: "Sign in" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const q = params.get("q")?.trim().toLowerCase().replace(/[^0-9a-fx]/g, "") ?? "";
  const list = params.get("list");
  const filter =
    list === "followers" ? "AND follows_me" : list === "following" ? "AND following" : "";
  const rows = await (await appDb()).all<Row>(
    `SELECT * FROM (
       SELECT u.address, u.last_seen,
              EXISTS (SELECT 1 FROM follows f WHERE f.follower = ?1 AND f.followee = u.address) AS following,
              EXISTS (SELECT 1 FROM follows f WHERE f.follower = u.address AND f.followee = ?1) AS follows_me
         FROM users u
        WHERE u.address <> ?1 AND (?2 = '' OR lower(u.address) LIKE '%' || ?2 || '%')
     ) WHERE 1 ${filter}
      ORDER BY following DESC, follows_me DESC, last_seen DESC
      LIMIT 50`,
    me, q,
  );
  return Response.json(
    { users: rows.map((r) => ({ address: r.address, following: !!Number(r.following), followsMe: !!Number(r.follows_me) })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
