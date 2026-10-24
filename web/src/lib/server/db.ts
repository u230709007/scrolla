import "server-only";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Client, createClient, type InValue } from "@libsql/client";
import { APP_DB_PATH, TURSO_AUTH_TOKEN, TURSO_DATABASE_URL, WORKER_DB_PATH } from "./config";

/** Small async facade over libSQL: local SQLite files in dev, one Turso
 * database in production (TURSO_DATABASE_URL), same SQL either way. */
export type Db = {
  all<T = Record<string, unknown>>(sql: string, ...args: InValue[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, ...args: InValue[]): Promise<T | undefined>;
  run(sql: string, ...args: InValue[]): Promise<void>;
};

// Reuse connections across hot reloads in dev.
const g = globalThis as unknown as {
  __appDb?: Promise<Db>;
  __workerDb?: Db;
  __remote?: Client;
};

const APP_SCHEMA = `
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  video_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads(created_at DESC, id DESC);
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

function wrap(client: Client): Db {
  return {
    async all<T>(sql: string, ...args: InValue[]) {
      return (await client.execute({ sql, args })).rows as unknown as T[];
    },
    async get<T>(sql: string, ...args: InValue[]) {
      return (await client.execute({ sql, args })).rows[0] as unknown as T | undefined;
    },
    async run(sql: string, ...args: InValue[]) {
      await client.execute({ sql, args });
    },
  };
}

function remote(): Client | null {
  if (!TURSO_DATABASE_URL) return null;
  g.__remote ??= createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
  return g.__remote;
}

const fileUrl = (file: string) => pathToFileURL(file).href;

export function appDb(): Promise<Db> {
  g.__appDb ??= (async () => {
    let client = remote();
    if (!client) {
      mkdirSync(path.dirname(APP_DB_PATH), { recursive: true });
      client = createClient({ url: fileUrl(APP_DB_PATH) });
      await client.execute("PRAGMA journal_mode = WAL");
      await client.execute("PRAGMA busy_timeout = 3000");
    }
    await client.executeMultiple(APP_SCHEMA);
    return wrap(client);
  })().catch((error) => {
    g.__appDb = undefined; // retry on the next request instead of caching the failure
    throw error;
  });
  return g.__appDb;
}

/** The worker's video index: the shared Turso database in production, or the
 * worker's local SQLite file (null until the worker has run once). */
export function workerDb(): Db | null {
  if (!g.__workerDb) {
    const client = remote();
    if (client) {
      g.__workerDb = wrap(client);
    } else {
      if (!existsSync(WORKER_DB_PATH)) return null;
      g.__workerDb = wrap(createClient({ url: fileUrl(WORKER_DB_PATH) }));
    }
  }
  return g.__workerDb;
}
