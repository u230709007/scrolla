"use client";

import { signIn, signOut } from "next-auth/react";
import type { Address } from "viem";
import { createSiweMessage } from "viem/siwe";
import { connect, disconnect, getConnection, signMessage, switchChain } from "wagmi/actions";
import { CHAIN } from "./chain";
import { preferredConnector, wagmiConfig } from "./wagmi";

type InjectedProvider = { isMetaMask?: boolean; providers?: InjectedProvider[] };

export const hasInjectedWallet = () => typeof window !== "undefined" && "ethereum" in window;

export function hasMetaMask() {
  if (typeof window === "undefined") return false;
  const eth = (window as { ethereum?: InjectedProvider }).ethereum;
  return !!eth && (!!eth.isMetaMask || !!eth.providers?.some((p) => p.isMetaMask));
}

/** Connect MetaMask (or another injected wallet) if needed and put it on CHAIN. */
export async function connectWallet(): Promise<Address> {
  let conn = getConnection(wagmiConfig);
  if (!conn.isConnected || !conn.address) {
    await connect(wagmiConfig, { connector: await preferredConnector(), chainId: CHAIN.id });
    conn = getConnection(wagmiConfig);
  }
  if (!conn.address) throw new Error("No wallet account available");
  await ensureChain();
  return conn.address;
}

/** Switch the wallet to CHAIN. MetaMask is asked to add the network first if it
 * doesn't know it yet (wagmi sends wallet_addEthereumChain on error 4902). */
export async function ensureChain() {
  if (getConnection(wagmiConfig).chainId === CHAIN.id) return;
  try {
    await switchChain(wagmiConfig, { chainId: CHAIN.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(/reject|denied/i.test(msg) ? `Switch your wallet to ${CHAIN.name} to continue` : msg);
  }
}

/** Connect the wallet, sign a SIWE message, and open a NextAuth session. */
export async function signInWithEthereum(): Promise<Address> {
  const address = await connectWallet();

  const { nonce } = (await fetch("/api/auth/nonce", { cache: "no-store" }).then((r) => r.json())) as { nonce: string };
  const now = new Date();
  const message = createSiweMessage({
    domain: window.location.host,
    address,
    statement: "Sign in to AlphaScroll. This request will not trigger a transaction or cost any gas.",
    uri: window.location.origin,
    version: "1",
    chainId: CHAIN.id,
    nonce,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 10 * 60 * 1000),
  });
  const signature = await signMessage(wagmiConfig, { account: address, message });

  const res = await signIn("siwe", { message, signature, redirect: false });
  if (!res || res.error) throw new Error("Signature could not be verified");
  return address;
}

export async function signOutEverywhere() {
  await disconnect(wagmiConfig).catch(() => undefined);
  await signOut({ redirect: false });
}
