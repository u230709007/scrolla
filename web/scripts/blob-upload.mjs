#!/usr/bin/env node
// Uploads worker output to Vercel Blob with the official SDK (the Python worker
// shells out to this: Blob's HTTP API is versioned and undocumented).
//
//   BLOB_READ_WRITE_TOKEN=... node scripts/blob-upload.mjs <file>=<pathname> [...]
//
// Pathnames are kept as-is (no random suffix) so the site can build the URL
// from the path stored in the database. Prints one JSON line per file.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { put } from "@vercel/blob";

const TYPES = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set");
  process.exit(1);
}
for (const arg of process.argv.slice(2)) {
  const split = arg.lastIndexOf("=");
  const file = arg.slice(0, split);
  const pathname = arg.slice(split + 1);
  const blob = await put(pathname, await readFile(file), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true, // re-running --publish-existing is safe
    contentType: TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    cacheControlMaxAge: 31536000, // filenames are unique per render
  });
  console.log(JSON.stringify({ pathname, url: blob.url }));
}
