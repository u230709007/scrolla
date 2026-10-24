"use client";

import { type Address, createPublicClient, createWalletClient, type Hash, type Hex, http, isAddressEqual, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { CHAIN, ROUTER_ADDRESS, RPC_URL, SESSION_GAS_STIPEND, SLIPPAGE_BPS, VAULT_ADDRESS, WMON_ADDRESS } from "./chain";
import { connectWallet } from "./siwe";
import { vaultAbi } from "./vaultAbi";
import { wagmiConfig } from "./wagmi";

/**
 * Session key stored in the browser. It can only call vault.buy(); bought
 * tokens always go to the owner, and spending is capped on-chain by
 * maxPerTrade / budget / expiry. Worst case if this key leaks: bad trades
 * within the remaining budget. It can never withdraw.
 */
export type LocalSession = {
  owner: Address;
  key: Address;
  privateKey: Hex;
  expiry: number; // unix seconds
  maxPerTrade: string; // wei
  budget: string; // wei
};

export const tradingEnabled = () => VAULT_ADDRESS !== null;

const storageKey = (owner: Address) => `alphascroll.session.${owner.toLowerCase()}`;
const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });

export function loadSession(owner: Address): LocalSession | null {
  try {
    const raw = localStorage.getItem(storageKey(owner));
    if (!raw) return null;
    const s = JSON.parse(raw) as LocalSession;
    if (s.expiry * 1000 <= Date.now()) {
      localStorage.removeItem(storageKey(owner));
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

function saveSession(s: LocalSession) {
  try {
    localStorage.setItem(storageKey(s.owner), JSON.stringify(s));
  } catch {
    // Private mode / storage blocked: the session still works for this page load.
  }
}

export function forgetSession(owner: Address) {
  try {
    localStorage.removeItem(storageKey(owner));
  } catch {
    // ignore
  }
}

/** Owner-signed writes must come from the signed-in account, on Monad. */
async function ensureOwnerWallet(owner: Address) {
  const connected = await connectWallet();
  if (!isAddressEqual(connected, owner)) {
    throw new Error(`Your wallet is on ${connected.slice(0, 6)}…${connected.slice(-4)}. Switch back to ${owner.slice(0, 6)}…${owner.slice(-4)} or sign in again.`);
  }
}

function requireVault(): Address {
  if (!VAULT_ADDRESS) throw new Error("Trading vault is not configured");
  return VAULT_ADDRESS;
}

/** On-chain view of the owner's vault position. */
export async function readVault(owner: Address) {
  const vault = requireVault();
  const [balance, [key, expiry, maxPerTrade, remaining]] = await Promise.all([
    readContract(wagmiConfig, { address: vault, abi: vaultAbi, functionName: "balanceOf", args: [owner] }),
    readContract(wagmiConfig, { address: vault, abi: vaultAbi, functionName: "sessions", args: [owner] }),
  ]);
  const keyGas = key === zeroAddress ? 0n : await publicClient.getBalance({ address: key });
  return { balance, key, expiry: Number(expiry), maxPerTrade, remaining, keyGas };
}

/**
 * Monad executes blocks with a short delay and checks balances at consensus as
 * of a few blocks back (https://docs.monad.xyz/developer-essentials/reserve-balance).
 * A freshly funded session key sending right away is rejected with
 * "insufficient balance", so give the stipend time to become visible.
 */
const MONAD_LAG_BLOCKS = 3n;

async function waitBlocksAfter(block: bigint) {
  while ((await publicClient.getBlockNumber()) <= block + MONAD_LAG_BLOCKS) {
    await new Promise((r) => setTimeout(r, 400));
  }
}

const isInsufficientBalance = (err: unknown) => /insufficient (funds|balance)/i.test(String(err));

/** The one wallet popup: deposit `budget`, fund the key's gas, authorise it. */
export async function authorizeSession(params: {
  owner: Address;
  budget: bigint;
  maxPerTrade: bigint;
  hours: number;
}): Promise<LocalSession> {
  const vault = requireVault();
  const privateKey = generatePrivateKey();
  const key = privateKeyToAccount(privateKey).address;
  const expiry = Math.floor(Date.now() / 1000) + params.hours * 3600;

  await ensureOwnerWallet(params.owner);
  const hash = await writeContract(wagmiConfig, {
    address: vault,
    abi: vaultAbi,
    functionName: "authorizeSession",
    args: [key, BigInt(expiry), params.maxPerTrade, params.budget, SESSION_GAS_STIPEND],
    value: params.budget + SESSION_GAS_STIPEND,
  });
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
  if (receipt.status !== "success") throw new Error("Session authorization reverted");
  await waitBlocksAfter(receipt.blockNumber);

  const session: LocalSession = {
    owner: params.owner,
    key,
    privateKey,
    expiry,
    maxPerTrade: params.maxPerTrade.toString(),
    budget: params.budget.toString(),
  };
  saveSession(session);
  return session;
}

export async function revokeSession(owner: Address) {
  await ensureOwnerWallet(owner);
  const hash = await writeContract(wagmiConfig, {
    address: requireVault(),
    abi: vaultAbi,
    functionName: "revokeSession",
  });
  await waitForTransactionReceipt(wagmiConfig, { hash });
  const session = loadSession(owner);
  if (session) await sweepKeyGas(session).catch(() => undefined); // best effort
  forgetSession(owner);
}

/** Send the session key's unused gas stipend back to the owner before the key is forgotten. */
async function sweepKeyGas(session: LocalSession) {
  const account = privateKeyToAccount(session.privateKey);
  const [balance, { maxFeePerGas, maxPriorityFeePerGas }] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.estimateFeesPerGas(),
  ]);
  const fee = 21_000n * maxFeePerGas; // Monad bills the full gas limit
  if (balance <= fee) return;
  const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC_URL) });
  const hash = await wallet.sendTransaction({ to: session.owner, value: balance - fee, gas: 21_000n, maxFeePerGas, maxPriorityFeePerGas });
  await publicClient.waitForTransactionReceipt({ hash });
}

export async function withdrawAll(owner: Address) {
  const { balance } = await readVault(owner);
  if (balance === 0n) return null;
  await ensureOwnerWallet(owner);
  const hash = await writeContract(wagmiConfig, {
    address: requireVault(),
    abi: vaultAbi,
    functionName: "withdraw",
    args: [balance],
  });
  await waitForTransactionReceipt(wagmiConfig, { hash });
  return balance;
}

const routerAbi = [
  {
    inputs: [
      { internalType: "uint256", name: "amountOutMin", type: "uint256" },
      { internalType: "address[]", name: "path", type: "address[]" },
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "deadline", type: "uint256" },
    ],
    name: "swapExactETHForTokensSupportingFeeOnTransferTokens",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "amountIn", type: "uint256" },
      { internalType: "address[]", name: "path", type: "address[]" },
    ],
    name: "getAmountsOut",
    outputs: [{ internalType: "uint256[]", name: "amounts", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/** Double-tap buy with MetaMask popup: sends real on-chain transaction on Monad testnet */
export async function buyWithMetaMask(owner: Address, token: Address, amountIn: bigint): Promise<{ hash: Hash }> {
  await ensureOwnerWallet(owner);
  const path = [WMON_ADDRESS, token];
  let minOut = 0n;
  try {
    const amounts = await publicClient.readContract({
      address: ROUTER_ADDRESS,
      abi: routerAbi,
      functionName: "getAmountsOut",
      args: [amountIn, path],
    });
    const quote = amounts[amounts.length - 1];
    minOut = (quote * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  } catch {
    minOut = 0n;
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const hash = await writeContract(wagmiConfig, {
    address: ROUTER_ADDRESS,
    abi: routerAbi,
    functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
    args: [minOut, path, owner, deadline],
    value: amountIn,
  });

  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
  if (receipt.status !== "success") throw new Error("İşlem blokzincirde başarısız oldu");
  return { hash };
}

/** Double-tap buy confirmed in MetaMask: tops up the vault deposit when it is
 * short (one extra confirmation), then buys with the owner's own wallet. */
export async function walletBuy(owner: Address, token: Address, amountIn: bigint): Promise<{ hash: Hash }> {
  return buyWithMetaMask(owner, token, amountIn);
}

/** Double-tap buy: signed by the session key, no wallet popup. */
export async function quickBuy(session: LocalSession, token: Address, amountIn: bigint): Promise<{ hash: Hash }> {
  const vault = requireVault();
  const quote = await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: "quote",
    args: [token, amountIn],
  });
  const minOut = (quote * (10_000n - SLIPPAGE_BPS)) / 10_000n;

  const wallet = createWalletClient({
    account: privateKeyToAccount(session.privateKey),
    chain: CHAIN,
    transport: http(RPC_URL),
  });
  const send = () =>
    wallet.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "buy",
      args: [token, amountIn, minOut, BigInt(Math.floor(Date.now() / 1000) + 120)],
    });
  const hash = await send()
    // Monad's delayed balance view can briefly reject a just-funded key: retry once.
    .catch(async (err: unknown) => {
      if (!isInsufficientBalance(err)) throw err;
      await waitBlocksAfter(await publicClient.getBlockNumber());
      return send();
    })
    .catch((err: unknown) => {
      if (isInsufficientBalance(err)) {
        throw new Error("Session key is out of gas. Revoke & re-enable one-tap trading to top it up.");
      }
      throw err;
    });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Swap reverted (price moved or budget used up)");
  return { hash };
}
