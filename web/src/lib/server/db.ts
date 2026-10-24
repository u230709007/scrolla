import "server-only";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { APP_DB_PATH, WORKER_DB_PATH } from "./config";

// Reuse connections across hot reloads in dev.
const g = globalThis as unknown as { __appDb?: DatabaseSync; __workerDb?: DatabaseSync };

const APP_SCHEMA = `
CREATE TABLE IF NOT EXISTS likes (
  video_id   TEXT NOT NULL,
  address    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (video_id, address)
);
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id   TEXT NOT NULL,
  address    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id, id DESC);
CREATE TABLE IF NOT EXISTS trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id      TEXT NOT NULL,
  address       TEXT NOT NULL,
  token_symbol  TEXT NOT NULL,
  token_address TEXT,
  amount_in_wei TEXT NOT NULL,
  amount_out    TEXT,
  tx_hash       TEXT UNIQUE,
  mode          TEXT NOT NULL CHECK (mode IN ('onchain', 'demo')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_trades_video ON trades(video_id);
`;

export function appDb(): DatabaseSync {
  if (!g.__appDb) {
    mkdirSync(path.dirname(APP_DB_PATH), { recursive: true });
    const db = new DatabaseSync(APP_DB_PATH);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    db.exec(APP_SCHEMA);
    g.__appDb = db;
  }
  return g.__appDb;
}

/** Read-only handle on the worker's index, or null until the worker has run once. */
export function workerDb(): DatabaseSync | null {
  if (!g.__workerDb) {
    if (!existsSync(WORKER_DB_PATH)) return null;
    const db = new DatabaseSync(WORKER_DB_PATH, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 3000;");
    g.__workerDb = db;
  }
  return g.__workerDb;
}
