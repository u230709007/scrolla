import { type Address, type Hash, parseEther } from "viem";
import { monad, monadTestnet } from "viem/chains";

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

export const ROUTER_ADDRESS: Address = "0x10e3cEa0162bc69F646aCC6284a02512059E1F8F";
export const WMON_ADDRESS: Address = "0x4dD6528f745cFe5C0fc8A5939b674d75b1Ff529C";

export const KNOWN_TESTNET_TOKENS: Record<string, Address> = {
  MOLANDAK: "0xe0aEcaB1DA28F9838e56F046711909ab505f963C",
  CHOG: "0x0D7cb0d8fe78e4849816426DedF1F9fDC9F3Ec3f",
  MOYAKI: "0x64A15558ed7fAD5BCc7cf71548945A21ce19B1bB",
  PURPLE: "0xD71AEeB309b3b4c5bE0Cbb753a70eA521DF41284",
  GMONAD: "0xbB560830F3DE49c45cfB9DE23227d9F027F09A1F",
  NADS: "0xF9436d33611656094f3FE0919A6D30E4dc544cda",
};

/** Token address to buy on-chain, or null when the reel's token lives on another
 * network (e.g. a mainnet DexScreener token while the app runs on testnet). */
export function tradableAddress(token: { chain?: string; tokenAddress?: string | null; symbol?: string }): Address | null {
  if (token.tokenAddress && /^0x[a-fA-F0-9]{40}$/.test(token.tokenAddress)) {
    return token.tokenAddress as Address;
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
