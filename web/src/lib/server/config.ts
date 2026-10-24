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
