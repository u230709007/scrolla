import { currentAddress } from "@/auth";
import { appDb } from "@/lib/server/db";
import { videoExists } from "@/lib/server/feed";
import type { Comment } from "@/lib/types";

const MAX_LEN = 280;

type Row = { id: number; address: string; body: string; created_at: string };
const toComment = (r: Row): Comment => ({ id: Number(r.id), address: r.address, body: r.body, createdAt: r.created_at });

export async function GET(_req: Request, ctx: RouteContext<"/api/videos/[id]/comments">) {
  const { id } = await ctx.params;
  const rows = await (await appDb()).all<Row>(
    "SELECT id, address, body, created_at FROM comments WHERE video_id = ? ORDER BY id DESC LIMIT 100",
    id,
  );
  return Response.json({ comments: rows.map(toComment) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request, ctx: RouteContext<"/api/videos/[id]/comments">) {
  const address = await currentAddress();
  if (!address) return Response.json({ error: "Sign in to comment" }, { status: 401 });

  const { id } = await ctx.params;
  if (!(await videoExists(id))) return Response.json({ error: "Video not found" }, { status: 404 });

  const { body } = (await req.json().catch(() => ({}))) as { body?: unknown };
  // Strip control characters, collapse whitespace.
  const text = typeof body === "string" ? body.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!text || text.length > MAX_LEN) {
    return Response.json({ error: `Comment must be 1-${MAX_LEN} characters` }, { status: 400 });
  }

  const row = (await (await appDb()).get<Row>(
    "INSERT INTO comments (video_id, address, body) VALUES (?, ?, ?) RETURNING id, address, body, created_at",
    id, address, text,
  ))!;
  return Response.json({ comment: toComment(row) }, { status: 201 });
}
