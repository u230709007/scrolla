import { createPublicClient, getAddress, type Hash, http, isHash, parseEventLogs } from "viem";
import { currentAddress } from "@/auth";
import { appDb } from "@/lib/server/db";
import { getVideoToken } from "@/lib/server/feed";
import { CHAIN, isForeignToken, RPC_URL, tradableAddress, VAULT_ADDRESS } from "@/lib/web3/chain";
import { vaultAbi } from "@/lib/web3/vaultAbi";

const client = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });

type Body = { videoId?: string; mode?: "onchain" | "demo"; txHash?: string; amountInWei?: string };

/**
 * Records a double-tap buy.
 * - onchain: the receipt is fetched from the RPC and the vault's Bought event
 *   is checked against the signed-in owner; amounts come from the log, not
 *   from the client.
 * - demo: only allowed when the trade can't be on-chain (no vault deployed,
 *   a mock token without an address, or a token from another network).
 */
export async function POST(req: Request) {
  const address = await currentAddress();
  if (!address) return Response.json({ error: "Sign in to trade" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Body;
  const token = body.videoId ? await getVideoToken(body.videoId) : null;
  if (!body.videoId || !token) return Response.json({ error: "Video not found" }, { status: 404 });

  const db = await appDb();
  const insert = {
    run: (...args: (string | null)[]) =>
      db.run(
        `INSERT INTO trades (video_id, address, token_symbol, token_address, amount_in_wei, amount_out, tx_hash, mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tx_hash) DO NOTHING`,
        ...args,
      ),
  };

  if (body.mode === "demo") {
    if (tradableAddress(token)) {
      return Response.json({ error: "This token trades on-chain; demo trades are disabled" }, { status: 400 });
    }
    // fake buys of mainnet tokens would show up as live AlphaScroll activity
    if (isForeignToken(token)) {
      return Response.json({ error: "Only testnet tokens can be bought" }, { status: 400 });
    }
    const amount = /^\d{1,30}$/.test(body.amountInWei ?? "") ? body.amountInWei! : "0";
    await insert.run(body.videoId, address, token.symbol, token.tokenAddress, amount, null, null, "demo");
    return Response.json({ ok: true, mode: "demo" }, { status: 201 });
  }

  const vault = VAULT_ADDRESS;
  if (!vault) return Response.json({ error: "Vault not configured" }, { status: 400 });
  if (!body.txHash || !isHash(body.txHash)) return Response.json({ error: "Invalid tx hash" }, { status: 400 });

  const receipt = await client.getTransactionReceipt({ hash: body.txHash as Hash }).catch(() => null);
  if (!receipt || receipt.status !== "success") {
    return Response.json({ error: "Transaction not found or failed" }, { status: 400 });
  }
  const bought = parseEventLogs({ abi: vaultAbi, logs: receipt.logs, eventName: "Bought" }).find(
    (log) => getAddress(log.address) === getAddress(vault) && getAddress(log.args.owner) === address,
  );
  if (!bought) return Response.json({ error: "No matching Bought event for this wallet" }, { status: 400 });

  await insert.run(
    body.videoId,
    address,
    token.symbol,
    bought.args.token,
    bought.args.amountIn.toString(),
    bought.args.amountOut.toString(),
    body.txHash,
    "onchain",
  );
  return Response.json({ ok: true, mode: "onchain", amountOut: bought.args.amountOut.toString() }, { status: 201 });
}
