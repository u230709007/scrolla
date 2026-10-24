import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { WORKER_OUTPUT_DIR } from "@/lib/server/config";

const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
const ALLOWED_DIRS = new Set(["videos", "thumbs"]);

/**
 * Streams worker output with HTTP Range support: browsers (Safari in
 * particular) need 206 responses to start playback early and to seek.
 * Filenames are unique per render, so responses are immutable.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/media/[...path]">) {
  const parts = (await ctx.params).path;
  if (parts.length !== 2 || !ALLOWED_DIRS.has(parts[0])) return new Response("Not found", { status: 404 });

  const file = path.resolve(/*turbopackIgnore: true*/ WORKER_OUTPUT_DIR, ...parts);
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!file.startsWith(WORKER_OUTPUT_DIR + path.sep) || !type) return new Response("Not found", { status: 404 });

  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers({
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
  });

  const range = req.headers.get("range");
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) {
    headers.set("Content-Length", String(size));
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers });
  }

  // bytes=start-end | bytes=start- | bytes=-suffixLength
  let start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
  let end = match[1] && match[2] ? Number(match[2]) : size - 1;
  end = Math.min(end, size - 1);
  if (start > end || start >= size) {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  start = Math.max(start, 0);

  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, {
    status: 206,
    headers,
  });
}
