import "server-only";
import { appDb } from "./db";

/** Record a wallet as a registered user (idempotent; refreshes last_seen). */
export async function registerUser(address: string): Promise<void> {
  await (await appDb()).run(
    `INSERT INTO users (address) VALUES (?)
     ON CONFLICT(address) DO UPDATE SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    address,
  );
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (v: unknown): v is string => typeof v === "string" && ADDRESS_RE.test(v);
