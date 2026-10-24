import { type HandleUploadBody, handleUpload } from "@vercel/blob/client";
import { currentAddress } from "@/auth";
import { BLOB_TOKEN } from "@/lib/server/config";

const MAX_SIZE = 50 * 1024 * 1024;
const PATHNAME = /^videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/;

/**
 * Issues short-lived client tokens so the browser can upload a video straight
 * to Vercel Blob (serverless request bodies are capped at ~4.5 MB). Only for
 * signed-in users, MP4 up to 50 MB, at the id handed out by /api/uploads presign.
 * The upload is registered afterwards by /api/uploads {action:"complete"}.
 */
export async function POST(request: Request) {
  if (!BLOB_TOKEN) return Response.json({ error: "Blob storage is not configured" }, { status: 404 });
  const body = (await request.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request,
      token: BLOB_TOKEN,
      onBeforeGenerateToken: async (pathname) => {
        if (!(await currentAddress())) throw new Error("Video paylaşmak için hesabına giriş yap.");
        if (!PATHNAME.test(pathname)) throw new Error("Geçersiz dosya yolu.");
        return {
          allowedContentTypes: ["video/mp4"],
          maximumSizeInBytes: MAX_SIZE,
          addRandomSuffix: false, // the feed derives the URL from the id
          allowOverwrite: false,
          cacheControlMaxAge: 31536000,
        };
      },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Yükleme reddedildi." }, { status: 400 });
  }
}
