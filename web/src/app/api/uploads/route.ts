import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { currentAddress } from "@/auth";
import { appDb } from "@/lib/server/db";
import { del } from "@vercel/blob";
import { BLOB_TOKEN, DIRECT_UPLOADS, WORKER_OUTPUT_DIR } from "@/lib/server/config";
import { mediaUrl, resolveUpload } from "@/lib/server/feed";
import { deleteObject, presignPut } from "@/lib/server/r2";
import type { FeedVideo } from "@/lib/types";

const MAX_SIZE = 50 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function GET() {
  const address = await currentAddress();
  if (!address) return Response.json({ videos: [] });
  const rows = await (await appDb()).all<{ video_json: string }>(
    "SELECT video_json FROM uploads WHERE address = ? ORDER BY created_at DESC",
    address,
  );
  return Response.json(
    { videos: rows.map((r) => resolveUpload(JSON.parse(r.video_json))) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function uploadVideo(id: string, address: string, caption: string): FeedVideo {
  return {
    id,
    creator: address,
    source: "upload",
    createdAt: new Date().toISOString(),
    videoUrl: mediaUrl(`videos/${id}.mp4`),
    posterUrl: "",
    duration: 0,
    format: "classic",
    persona: null,
    hook: "",
    narration: caption,
    token: {
      symbol: "",
      name: "",
      chain: "",
      pairAddress: null,
      tokenAddress: null,
      dexUrl: null,
      priceUsd: 0,
      change24h: 0,
      volume24h: 0,
      liquidityUsd: 0,
      marketCap: 0,
    },
    likes: 0,
    comments: 0,
    trades: 0,
    likedByMe: false,
  };
}

async function insertUpload(video: FeedVideo, address: string) {
  await (await appDb()).run(
    "INSERT INTO uploads (id, address, created_at, video_json) VALUES (?, ?, ?, ?)",
    video.id, address, video.createdAt, JSON.stringify(video),
  );
}

const isMp4 = (head: Uint8Array) => Buffer.from(head).toString("ascii", 4, 8) === "ftyp";

/** First bytes + total size of a public media file, or null if it isn't there. */
async function publicHead(url: string, bytes = 12): Promise<{ head: Uint8Array; size: number } | null> {
  const res = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` }, cache: "no-store" }).catch(() => null);
  if (!res?.ok) return null;
  const size = Number(res.headers.get("content-range")?.split("/")[1] ?? res.headers.get("content-length"));
  return { head: new Uint8Array(await res.arrayBuffer()), size };
}

async function removeDirectUpload(key: string) {
  if (DIRECT_UPLOADS === "blob") await del(mediaUrl(key), { token: BLOB_TOKEN });
  else await deleteObject(key);
}

/**
 * Production (Vercel Blob or R2): {action:"presign"} reserves an id; the
 * browser then uploads straight to storage (Blob: @vercel/blob/client via
 * /api/uploads/blob, R2: PUT to a presigned URL) and {action:"complete"}
 * verifies the file and registers it. Without either (local dev) the file is
 * posted as multipart form data and stored next to the worker's videos;
 * presign answers 404 so the client falls back to that.
 */
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return Response.json({ error: "Geçersiz istek." }, { status: 403 });
  const address = await currentAddress();
  if (!address)
    return Response.json(
      { error: "Video paylaşmak için hesabına giriş yap." },
      { status: 401 },
    );
  if (request.headers.get("content-type")?.startsWith("application/json"))
    return direct(request, address);
  return multipart(request, address);
}

async function direct(request: Request, address: string) {
  if (!DIRECT_UPLOADS) return Response.json({ error: "Direct uploads are off" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    size?: number;
    type?: string;
    id?: string;
    caption?: string;
  };

  if (body.action === "presign") {
    if (body.type !== "video/mp4" || !body.size || body.size > MAX_SIZE)
      return Response.json({ error: "En fazla 50 MB boyutunda bir MP4 video seç." }, { status: 400 });
    const id = randomUUID();
    const pathname = `videos/${id}.mp4`;
    return Response.json(
      DIRECT_UPLOADS === "blob"
        ? { id, provider: "blob", pathname }
        : { id, provider: "r2", uploadUrl: await presignPut(pathname, "video/mp4") },
    );
  }

  if (body.action === "complete") {
    const caption = String(body.caption ?? "").trim();
    if (!body.id || !UUID.test(body.id) || caption.length > 300)
      return Response.json({ error: "En fazla 300 karakter açıklama kullan." }, { status: 400 });
    const key = `videos/${body.id}.mp4`;
    const object = await publicHead(mediaUrl(key));
    if (!object) return Response.json({ error: "Video bulunamadı. Tekrar yükle." }, { status: 400 });
    if (object.size > MAX_SIZE || !isMp4(object.head)) {
      await removeDirectUpload(key);
      return Response.json({ error: "Geçerli bir MP4 dosyası seç (en fazla 50 MB)." }, { status: 400 });
    }
    const video = uploadVideo(body.id, address, caption);
    try {
      await insertUpload(video, address);
    } catch {
      return Response.json({ error: "Bu video zaten paylaşıldı." }, { status: 409 });
    }
    return Response.json({ video }, { status: 201 });
  }

  return Response.json({ error: "Geçersiz istek." }, { status: 400 });
}

async function multipart(request: Request, address: string) {
  if (Number(request.headers.get("content-length")) > MAX_SIZE + 1024 * 1024)
    return Response.json(
      { error: "En fazla 50 MB yükleyebilirsin." },
      { status: 413 },
    );
  try {
    // Bound chunked requests as well as requests with Content-Length.
    const reader = request.body?.getReader();
    if (!reader)
      return Response.json(
        { error: "Video dosyası gerekli." },
        { status: 400 },
      );
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_SIZE + 1024 * 1024) {
        await reader.cancel();
        return Response.json(
          { error: "En fazla 50 MB yükleyebilirsin." },
          { status: 413 },
        );
      }
      chunks.push(chunk.value);
    }
    const form = await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": request.headers.get("content-type") ?? "" },
    }).formData();
    const file = form.get("video");
    const caption = String(form.get("caption") ?? "").trim();
    if (
      !(file instanceof File) ||
      file.size === 0 ||
      file.size > MAX_SIZE ||
      file.type !== "video/mp4" ||
      caption.length > 300
    ) {
      return Response.json(
        { error: "En fazla 50 MB MP4 ve 300 karakter açıklama kullan." },
        { status: 400 },
      );
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!isMp4(bytes))
      return Response.json(
        { error: "Geçerli bir MP4 dosyası seç." },
        { status: 400 },
      );
    const id = randomUUID();
    const target = path.join(WORKER_OUTPUT_DIR, "videos", `${id}.mp4`);
    const video = uploadVideo(id, address, caption);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
    try {
      await insertUpload(video, address);
    } catch (error) {
      await unlink(target);
      throw error;
    }
    return Response.json({ video }, { status: 201 });
  } catch {
    return Response.json(
      { error: "Video kaydedilemedi. Tekrar dene." },
      { status: 500 },
    );
  }
}
