"use client";

import { Copy, Droplets, LogOut, Wallet, Zap } from "lucide-react";
import { type Address, formatEther } from "viem";
import { useBalance } from "wagmi";
import { shortAddr } from "@/lib/format";
import { CHAIN, FAUCET_URL } from "@/lib/web3/chain";
import { signOutEverywhere } from "@/lib/web3/siwe";
import { useToast } from "../Toast";
import { Sheet } from "./Sheet";

export function ProfileSheet({
  open,
  address,
  onClose,
  onOpenSession,
  onRequestLogin,
}: {
  open: boolean;
  address: string | null;
  onClose: () => void;
  onOpenSession: () => void;
  onRequestLogin: () => void;
}) {
  const toast = useToast();
  const balance = useBalance({ address: (address ?? undefined) as Address | undefined, chainId: CHAIN.id, query: { enabled: open && !!address } });
  return (
    <Sheet open={open} onClose={onClose} height="55%" title="Profile">
      {address ? (
        <div className="space-y-3">
          <button
            onClick={() => navigator.clipboard?.writeText(address).then(() => toast.show({ kind: "info", title: "Address copied" }))}
            className="flex w-full items-center gap-3 rounded-2xl bg-white/5 p-4 text-left"
          >
            <div
              className="size-11 rounded-full"
              style={{ background: `linear-gradient(135deg, #${address.slice(2, 8)}, #${address.slice(-6)})` }}
            />
            <div className="min-w-0 flex-1">
              <p className="font-mono font-bold">{shortAddr(address)}</p>
              <p className="text-xs text-white/50">
                {CHAIN.name}
                {balance.data && ` · ${Number(formatEther(balance.data.value)).toLocaleString(undefined, { maximumFractionDigits: 4 })} MON`}
              </p>
            </div>
            <Copy className="size-4 text-white/50" />
          </button>
          {FAUCET_URL && (
            <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="flex w-full items-center gap-3 rounded-2xl bg-white/5 p-4 text-sm font-semibold">
              <Droplets className="size-5 text-monad-soft" /> Get testnet MON
            </a>
          )}
          <button onClick={onOpenSession} className="flex w-full items-center gap-3 rounded-2xl bg-white/5 p-4 text-sm font-semibold">
            <Zap className="size-5 text-gold" /> One-tap trading
          </button>
          <button
            onClick={async () => {
              await signOutEverywhere();
              onClose();
            }}
            className="flex w-full items-center gap-3 rounded-2xl bg-white/5 p-4 text-sm font-semibold text-dump"
          >
            <LogOut className="size-5" /> Sign out
          </button>
        </div>
      ) : (
        <button onClick={onRequestLogin} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-monad py-4 font-bold">
          <Wallet className="size-5" /> Connect wallet
        </button>
      )}
    </Sheet>
  );
}
