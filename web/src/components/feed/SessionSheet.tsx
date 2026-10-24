"use client";

import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Loader2, ShieldCheck, Zap } from "lucide-react";
import { useState } from "react";
import { type Address, formatEther, parseEther } from "viem";
import { CHAIN, FAUCET_URL, IS_TESTNET, SESSION_GAS_STIPEND, VAULT_ADDRESS } from "@/lib/web3/chain";
import {
  authorizeSession,
  type LocalSession,
  loadSession,
  readVault,
  revokeSession,
  tradingEnabled,
  withdrawAll,
} from "@/lib/web3/trading";
import { useToast } from "../Toast";
import { Sheet } from "./Sheet";

// Faucet MON is scarce, and setup:testnet pools are small: keep testnet amounts low.
const BUDGETS = IS_TESTNET ? ["0.1", "0.25", "0.5"] : ["0.5", "1", "5"];
const TAPS = IS_TESTNET ? ["0.01", "0.025", "0.05"] : ["0.05", "0.1", "0.25"];
const DURATIONS = [
  { label: "1 hour", hours: 1 },
  { label: "24 hours", hours: 24 },
  { label: "7 days", hours: 168 },
];

function Choice<T extends string | number>({ options, value, onChange, render }: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
  render: (v: T) => string;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {options.map((o) => (
        <button
          key={String(o)}
          onClick={() => onChange(o)}
          className={`rounded-xl py-2.5 text-sm font-semibold transition ${o === value ? "bg-monad text-white" : "bg-white/5 text-white/70"}`}
        >
          {render(o)}
        </button>
      ))}
    </div>
  );
}

/** One-time setup for double-tap trading (and status / revoke once active). */
export function SessionSheet({
  open,
  owner,
  onClose,
  onReady,
}: {
  open: boolean;
  owner: Address | null;
  onClose: () => void;
  onReady: (session: LocalSession) => void;
}) {
  const toast = useToast();
  const [budget, setBudget] = useState(BUDGETS[1]);
  const [tap, setTap] = useState(TAPS[1]);
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState<null | "authorize" | "revoke">(null);
  const local = owner ? loadSession(owner) : null;

  const vault = useQuery({
    queryKey: ["vault", owner],
    enabled: open && !!owner && tradingEnabled(),
    queryFn: () => readVault(owner!),
  });

  async function enable() {
    if (!owner) return;
    setBusy("authorize");
    const id = toast.show({ kind: "loading", title: "Confirm in your wallet", body: "This is the only popup you'll see." });
    try {
      const session = await authorizeSession({
        owner,
        budget: parseEther(budget),
        maxPerTrade: parseEther(tap),
        hours,
      });
      toast.update(id, { kind: "success", title: "One-tap trading is live", body: `${tap} MON per double-tap` });
      vault.refetch();
      onReady(session);
    } catch (err) {
      toast.update(id, { kind: "error", title: "Setup failed", body: errText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    if (!owner) return;
    setBusy("revoke");
    const id = toast.show({ kind: "loading", title: "Revoking session & withdrawing…" });
    try {
      await revokeSession(owner);
      const amount = await withdrawAll(owner);
      toast.update(id, {
        kind: "success",
        title: "Session revoked",
        body: amount ? `${formatEther(amount)} MON returned to your wallet` : undefined,
      });
      vault.refetch();
    } catch (err) {
      toast.update(id, { kind: "error", title: "Revoke failed", body: errText(err) });
    } finally {
      setBusy(null);
    }
  }

  const active = local && vault.data && vault.data.key.toLowerCase() === local.key.toLowerCase();
  const total = Number(budget) + Number(formatEther(SESSION_GAS_STIPEND));

  return (
    <Sheet open={open} onClose={onClose} height="74%" title="One-tap trading">
      {!tradingEnabled() ? (
        <div className="space-y-3 text-sm text-white/70">
          <p>
            Trading runs in <b className="text-gold">demo mode</b>: no session vault is deployed for {CHAIN.name} yet, so
            double-taps are simulated.
          </p>
          <p>
            Run <code className="text-monad-soft">npm run setup:testnet</code> in <code className="text-monad-soft">contracts/</code>{" "}
            (it sets <code className="text-monad-soft">NEXT_PUBLIC_VAULT_ADDRESS</code>) and restart the app to enable real on-chain buys.
          </p>
        </div>
      ) : active ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-2xl bg-pump/10 p-4">
            <ShieldCheck className="size-6 text-pump" />
            <div className="text-sm">
              <p className="font-bold text-pump">Session active</p>
              <p className="text-white/70">Expires {new Date(local.expiry * 1000).toLocaleString()}</p>
            </div>
          </div>
          <dl className="grid grid-cols-3 gap-2 text-center text-sm">
            {[
              ["Per tap", formatEther(vault.data!.maxPerTrade)],
              ["Left", formatEther(vault.data!.remaining)],
              ["In vault", formatEther(vault.data!.balance)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-2xl bg-white/5 p-3">
                <dt className="text-[11px] text-white/50">{k}</dt>
                <dd className="mt-1 font-bold">{Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 })} MON</dd>
              </div>
            ))}
          </dl>
          <p className="text-center text-xs text-white/50">
            Session key gas: {Number(formatEther(vault.data!.keyGas)).toLocaleString(undefined, { maximumFractionDigits: 4 })} MON
          </p>
          <button
            onClick={revoke}
            disabled={!!busy}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-dump/15 py-3 font-bold text-dump disabled:opacity-50"
          >
            {busy === "revoke" && <Loader2 className="size-4 animate-spin" />} Revoke & withdraw
          </button>
        </div>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-white/70">
            Approve once and every double-tap buys instantly, signed by a temporary key in this browser. The key can
            only buy — tokens go straight to your wallet and it can never withdraw your funds.
          </p>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">Budget</p>
            <Choice options={BUDGETS} value={budget} onChange={setBudget} render={(v) => `${v} MON`} />
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">Per double-tap</p>
            <Choice options={TAPS} value={tap} onChange={setTap} render={(v) => `${v} MON`} />
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">Expires after</p>
            <Choice options={DURATIONS.map((d) => d.hours)} value={hours} onChange={setHours} render={(h) => DURATIONS.find((d) => d.hours === h)!.label} />
          </div>
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={enable}
            disabled={!!busy || !owner || Number(tap) > Number(budget)}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-monad py-4 font-bold disabled:opacity-50"
          >
            {busy === "authorize" ? <Loader2 className="size-5 animate-spin" /> : <Zap className="size-5" />}
            Enable · {total} MON
          </motion.button>
          <p className="text-center text-[11px] text-white/40">
            Includes {formatEther(SESSION_GAS_STIPEND)} MON gas for the session key · Vault{" "}
            {VAULT_ADDRESS?.slice(0, 8)}…
            {FAUCET_URL && (
              <>
                {" · "}
                <a className="underline" href={FAUCET_URL} target="_blank" rel="noreferrer">
                  Need MON?
                </a>
              </>
            )}
          </p>
        </div>
      )}
    </Sheet>
  );
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err);
  return /reject|denied/i.test(msg) ? "Request cancelled in wallet" : msg.slice(0, 140);
}
