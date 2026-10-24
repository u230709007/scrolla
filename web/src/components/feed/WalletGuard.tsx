"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useState } from "react";
import { isAddressEqual, type Address } from "viem";
import { useConnection } from "wagmi";
import { shortAddr } from "@/lib/format";
import { CHAIN } from "@/lib/web3/chain";
import { ensureChain, signOutEverywhere } from "@/lib/web3/siwe";
import { useToast } from "../Toast";

/** Banner when the connected wallet is on the wrong network, or MetaMask has
 * switched to a different account than the one signed in. */
export function WalletGuard({ address }: { address: string | null }) {
  const toast = useToast();
  const conn = useConnection();
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (dismissed || !address || !conn.isConnected || !conn.address) return null;

  const otherAccount = !isAddressEqual(conn.address, address as Address);
  const wrongChain = conn.chainId !== CHAIN.id;
  if (!otherAccount && !wrongChain) return null;

  async function fix() {
    setBusy(true);
    try {
      if (otherAccount) await signOutEverywhere();
      else await ensureChain();
    } catch (err) {
      toast.show({ kind: "error", title: "Ağ değiştirilemedi", body: err instanceof Error ? err.message.slice(0, 140) : undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-x-3 top-12 z-40 flex items-center gap-3 rounded-2xl bg-gold/95 p-3 text-ink shadow-lg sm:top-[5.25rem]">
      <AlertTriangle className="size-5 shrink-0" />
      <p className="min-w-0 flex-1 text-xs font-semibold leading-snug">
        {otherAccount
          ? `Cüzdan ${shortAddr(conn.address)} hesabına geçti.`
          : `İşlemler için ${CHAIN.name} ağı gerekiyor.`}
      </p>
      <button onClick={fix} disabled={busy} className="flex shrink-0 items-center gap-1 rounded-xl bg-ink px-3 py-2 text-xs font-bold text-white disabled:opacity-60">
        {busy && <Loader2 className="size-3 animate-spin" />}
        {otherAccount ? "Yeniden bağlan" : "Ağı değiştir"}
      </button>
      <button onClick={() => setDismissed(true)} className="p-1 text-ink/70 hover:text-ink text-sm">
        ✕
      </button>
    </div>
  );
}
