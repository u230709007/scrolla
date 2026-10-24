import { currentAddress } from "@/auth";
import { appDb } from "@/lib/server/db";
import { isAddress } from "@/lib/server/social";

export async function POST(req: Request) {
  const me = await currentAddress();
  if (!me) return Response.json({ error: "Sign in to follow" }, { status: 401 });

  const { address, follow } = (await req.json().catch(() => ({}))) as { address?: unknown; follow?: unknown };
  if (!isAddress(address) || address.toLowerCase() === me.toLowerCase()) {
    return Response.json({ error: "Invalid user" }, { status: 400 });
  }
  const db = await appDb();
  const target = await db.get<{ address: string }>("SELECT address FROM users WHERE lower(address) = lower(?)", address);
  if (!target) return Response.json({ error: "User not found" }, { status: 404 });

  if (follow === false) {
    await db.run("DELETE FROM follows WHERE follower = ? AND followee = ?", me, target.address);
  } else {
    await db.run("INSERT OR IGNORE INTO follows (follower, followee) VALUES (?, ?)", me, target.address);
  }
  return Response.json({ following: follow !== false });
}
