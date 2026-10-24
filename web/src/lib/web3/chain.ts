import { type Address, type Hash, parseEther, zeroAddress } from "viem";
import { monad, monadTestnet } from "viem/chains";
import deployment from "./deployment.json";

/** Monad testnet (10143) by default; set NEXT_PUBLIC_CHAIN_ID=143 for mainnet. */
export const CHAIN = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? monadTestnet.id) === monad.id ? monad : monadTestnet;

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || CHAIN.rpcUrls.default.http[0];

export const IS_TESTNET = CHAIN.id === monadTestnet.id;

/** Free testnet MON for gas and trades. */
export const FAUCET_URL = IS_TESTNET ? "https://faucet.monad.xyz" : null;

/** `chain` value the worker writes for tokens on this network (see video_worker.py). */
const TOKEN_CHAIN = IS_TESTNET ? "monad-testnet" : "monad";

/** Deployed AlphaScrollSessionVault. Unset -> double-tap runs in demo mode. */
export const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS || null) as Address | null;

/** MON forwarded to the session key so it can pay its own gas. */
export const SESSION_GAS_STIPEND = parseEther(process.env.NEXT_PUBLIC_SESSION_GAS_STIPEND || "0.1");

/** Max slippage applied to the vault quote, in basis points. */
export const SLIPPAGE_BPS = BigInt(process.env.NEXT_PUBLIC_SLIPPAGE_BPS || "800");

/** Test DEX from `npm run setup:testnet`, which rewrites deployment.json. */
const TESTNET = IS_TESTNET ? (deployment as { router: Address; tokens: { symbol: string; address: Address }[] }) : null;

export const ROUTER_ADDRESS = (process.env.NEXT_PUBLIC_ROUTER_ADDRESS || TESTNET?.router || zeroAddress) as Address;

/** Testnet pools by symbol, so reels rendered before the setup still map onto them. */
export const KNOWN_TESTNET_TOKENS: Record<string, Address> = Object.fromEntries(
  (TESTNET?.tokens ?? []).map((t) => [t.symbol, t.address]),
);

/** Token address to buy on-chain, or null when the reel's token lives on another
 * network (e.g. a mainnet DexScreener token while the app runs on testnet). */
export function tradableAddress(token: { chain?: string; tokenAddress?: string | null; symbol?: string }): Address | null {
  if (token.tokenAddress && /^0x[a-fA-F0-9]{40}$/.test(token.tokenAddress)) {
    // An address on another network has no pool here, whatever its symbol.
    return token.chain === TOKEN_CHAIN ? (token.tokenAddress as Address) : null;
  }
  const sym = (token.symbol ?? "").toUpperCase().replace("$", "");
  if (sym && KNOWN_TESTNET_TOKENS[sym]) {
    return KNOWN_TESTNET_TOKENS[sym];
  }
  return null;
}

/** A reel about a real token on another network (mainnet reels while the app
 * runs on testnet): shown for its market data, never bought, not even as a demo. */
export function isForeignToken(token: { chain?: string; tokenAddress?: string | null; symbol?: string }): boolean {
  if (tradableAddress(token)) return false;
  return !!token.tokenAddress && token.chain !== TOKEN_CHAIN;
}

export const explorerTx =(hash: Hash) => `${CHAIN.blockExplorers.default.url}/tx/${hash}`;
