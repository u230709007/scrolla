import "server-only";
import path from "node:path";

const root = process.cwd();

/** Folder the Python worker writes into (videos/, thumbs/, alphascroll.db). */
export const WORKER_OUTPUT_DIR = path.resolve(/*turbopackIgnore: true*/ root, process.env.WORKER_OUTPUT_DIR ?? "../worker/output");

export const WORKER_DB_PATH = path.resolve(
  /*turbopackIgnore: true*/ root,
  process.env.WORKER_DB_PATH ?? path.join(WORKER_OUTPUT_DIR, "alphascroll.db"),
);

/** The web app's own data (likes, comments, trades). Separate file so the
 * worker's writes never contend with user traffic. */
export const APP_DB_PATH = path.resolve(/*turbopackIgnore: true*/ root, process.env.APP_DB_PATH ?? "./data/app.db");

/** Production (e.g. Vercel): one Turso database holds the worker's videos and
 * the app's tables. Unset = the local SQLite files above. */
export const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "";
export const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || undefined;

/** Vercel Blob (added to the project from Vercel's Storage tab). The token is
 * vercel_blob_rw_<storeId>_<secret>; public files live at <storeId>.public.blob…. */
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || "";
const blobStoreId = BLOB_TOKEN.split("_")[3] ?? "";
const blobBaseUrl = blobStoreId ? `https://${blobStoreId.toLowerCase()}.public.blob.vercel-storage.com` : "";

/** Public base URL of the Blob store / R2 bucket the worker uploads to
 * (videos/…, thumbs/…). Unset = media is streamed from WORKER_OUTPUT_DIR by /api/media. */
export const MEDIA_BASE_URL = (process.env.MEDIA_BASE_URL || blobBaseUrl).replace(/\/+$/, "");
