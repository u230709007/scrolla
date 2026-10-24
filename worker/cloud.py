"""
Scrolla — cloud publishing (optional)
=========================================

When the web app runs on Vercel it can't see this machine's disk, so the
worker publishes there instead:

  R2    : videos/<id>.mp4 and thumbs/<id>.jpg go to a Cloudflare R2 bucket
          (S3 API via boto3); the site plays them from the bucket's public URL
  Turso : the `videos` row goes to the shared Turso (libSQL) database the site
          reads, via its HTTP pipeline API (no extra client library)

Both are off unless their env vars are set; the local SQLite + output/ folder
keep working either way.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import requests

log = logging.getLogger("alphascroll")

TURSO_URL = os.getenv("TURSO_DATABASE_URL", "").strip().replace("libsql://", "https://").rstrip("/")
TURSO_TOKEN = os.getenv("TURSO_AUTH_TOKEN", "").strip()
R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID", "").strip()
R2_BUCKET = os.getenv("R2_BUCKET", "").strip()
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "").strip()
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "").strip()

BLOB_TOKEN = os.getenv("BLOB_READ_WRITE_TOKEN", "").strip()
# The web app ships the official Blob SDK; the worker shells out to its uploader
BLOB_UPLOADER = Path(__file__).resolve().parent.parent / "web" / "scripts" / "blob-upload.mjs"

TURSO_ENABLED = bool(TURSO_URL and TURSO_TOKEN)
R2_ENABLED = bool(R2_ACCOUNT_ID and R2_BUCKET and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY)
BLOB_ENABLED = bool(BLOB_TOKEN)
MEDIA_ENABLED = BLOB_ENABLED or R2_ENABLED
MEDIA_TARGET = "Vercel Blob" if BLOB_ENABLED else f"R2 bucket {R2_BUCKET}"


# --------------------------------------------------------------------------- #
# Turso
# --------------------------------------------------------------------------- #


def _arg(value) -> dict:
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": str(int(value))}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "float", "value": value}
    return {"type": "text", "value": str(value)}


def _cell(cell: dict):
    kind, value = cell.get("type"), cell.get("value")
    if kind == "integer":
        return int(value)
    if kind == "float":
        return float(value)
    return None if kind == "null" else value


def turso(*statements: tuple[str, tuple | list]) -> list[list[tuple]]:
    """Run statements in order (one HTTP round trip); returns rows per statement."""
    body = {"requests": [
        *({"type": "execute", "stmt": {"sql": sql, "args": [_arg(a) for a in args]}} for sql, args in statements),
        {"type": "close"},
    ]}
    resp = requests.post(f"{TURSO_URL}/v2/pipeline", json=body, timeout=30,
                         headers={"Authorization": f"Bearer {TURSO_TOKEN}"})
    resp.raise_for_status()
    out = []
    for result in resp.json()["results"][: len(statements)]:
        if result["type"] != "ok":
            raise RuntimeError(f"Turso: {result.get('error', {}).get('message', result)}")
        rows = result["response"]["result"]["rows"]
        out.append([tuple(_cell(c) for c in row) for row in rows])
    return out


# --------------------------------------------------------------------------- #
# R2
# --------------------------------------------------------------------------- #

CONTENT_TYPES = {".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}


def r2_upload(path: Path, key: str) -> None:
    import boto3

    s3 = boto3.client(
        "s3", endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID, aws_secret_access_key=R2_SECRET_ACCESS_KEY, region_name="auto",
    )
    s3.upload_file(str(path), R2_BUCKET, key, ExtraArgs={
        "ContentType": CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream"),
        # filenames are unique per render, so the CDN can cache them forever
        "CacheControl": "public, max-age=31536000, immutable",
    })


# --------------------------------------------------------------------------- #
# Vercel Blob
# --------------------------------------------------------------------------- #


def blob_upload(files: list[tuple[Path, str]]) -> None:
    import subprocess

    # cwd=web so Node resolves @vercel/blob from web/node_modules
    result = subprocess.run(
        ["node", str(BLOB_UPLOADER), *(f"{path}={key}" for path, key in files)],
        cwd=BLOB_UPLOADER.parent.parent, env={**os.environ, "BLOB_READ_WRITE_TOKEN": BLOB_TOKEN},
        capture_output=True, text=True, timeout=600,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Blob upload failed: {(result.stderr or result.stdout).strip()[-500:]}")


def upload_media(files: list[tuple[Path, str]]) -> None:
    """Publish (local file, storage key) pairs, e.g. (…/videos/x.mp4, "videos/x.mp4")."""
    if BLOB_ENABLED:
        blob_upload(files)
    else:
        for path, key in files:
            r2_upload(path, key)
