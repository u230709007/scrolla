import { currentAddress } from "@/auth";
import { appDb } from "@/lib/server/db";
import { videoExists } from "@/lib/server/feed";
import { isAddress } from "@/lib/server/social";

const MAX_RECIPIENTS = 20;

export async function POST(req: Request, ctx: RouteContext<"/api/videos/[id]/share">) {
  const me = await currentAddress();
  if (!me) return Response.json({ error: "Sign in to share" }, { status: 401 });

  const { id } = await ctx.params;
  if (!(await videoExists(id))) return Response.json({ error: "Video not found" }, { status: 404 });

  const { to } = (await req.json().catch(() => ({}))) as { to?: unknown };
  const wanted = Array.isArray(to) ? [...new Set(to.filter(isAddress).map((a) => a.toLowerCase()))] : [];
  if (!wanted.length || wanted.length > MAX_RECIPIENTS) {
    return Response.json({ error: `Pick 1-${MAX_RECIPIENTS} people` }, { status: 400 });
  }

  const db = await appDb();
  let sent = 0;
  for (const a of wanted) {
    if (a === me.toLowerCase()) continue;
    const user = await db.get<{ address: string }>("SELECT address FROM users WHERE lower(address) = ?", a);
    if (!user) continue;
    await db.run("INSERT INTO shares (video_id, from_address, to_address) VALUES (?, ?, ?)", id, me, user.address);
    sent++;
  }
  if (!sent) return Response.json({ error: "No valid recipients" }, { status: 400 });
  return Response.json({ sent }, { status: 201 });
}
