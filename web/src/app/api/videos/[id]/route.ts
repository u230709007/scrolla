import { currentAddress } from "@/auth";
import { getVideo } from "@/lib/server/feed";

export async function GET(_req: Request, ctx: RouteContext<"/api/videos/[id]">) {
  const { id } = await ctx.params;
  const video = await getVideo(id, await currentAddress());
  if (!video) return Response.json({ error: "Video not found" }, { status: 404 });
  return Response.json({ video }, { headers: { "Cache-Control": "no-store" } });
}
