"use client";

import { motion } from "framer-motion";
import { Bot, Hand, Loader2, Wallet, Zap } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { CHAIN, FAUCET_URL } from "@/lib/web3/chain";
import { hasInjectedWallet, hasMetaMask, signInWithEthereum } from "@/lib/web3/siwe";
import type { FeedPage } from "@/lib/types";
import { useToast } from "./Toast";

const FEATURES = [
  { icon: Bot, text: "An AI agent turns trending Monad tokens into reels every 15 min" },
  { icon: Hand, text: "Double-tap a video to buy the token" },
  { icon: Zap, text: "Session keys: one approval, then no wallet popups" },
];

const noopSubscribe = () => () => {};

export function LoginScreen({ onGuest }: { onGuest: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // Server render assumes a wallet; the client checks window.ethereum.
  const walletFound = useSyncExternalStore(noopSubscribe, hasInjectedWallet, () => true);
  const metaMask = useSyncExternalStore(noopSubscribe, hasMetaMask, () => true);
  const [posters, setPosters] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/feed?limit=3")
      .then((r) => r.json() as Promise<FeedPage>)
      .then((p) => setPosters(p.videos.map((v) => v.posterUrl)))
      .catch(() => undefined);
  }, []);

  async function connect() {
    if (!walletFound) {
      window.open("https://metamask.io/download/", "_blank", "noopener");
      return;
    }
    setBusy(true);
    try {
      await signInWithEthereum();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const rejected = /reject|denied|cancel/i.test(msg);
      toast.show({ kind: "error", title: rejected ? "Request cancelled" : "Sign-in failed", body: rejected ? undefined : msg.slice(0, 140) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-ink px-6 pb-10 pt-16">
      {/* Floating previews of the latest AI reels */}
      <div aria-hidden className="absolute inset-x-0 top-14 flex h-[300px] justify-center">
        {(posters.length ? posters : [null, null, null]).map((src, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 40, rotate: 0 }}
            animate={{ opacity: 1, y: [0, -8, 0], rotate: (i - 1) * 9 }}
            transition={{ delay: i * 0.12, y: { repeat: Infinity, duration: 4 + i, ease: "easeInOut" } }}
            className="absolute top-6 h-[250px] w-[140px] overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-monad/50 to-panel shadow-2xl"
            style={{ left: `calc(50% - 70px + ${(i - 1) * 96}px)`, zIndex: i === 1 ? 2 : 1 }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- local worker thumbnails */}
            {src && <img src={src} alt="" className="h-full w-full object-cover" />}
          </motion.div>
        ))}
        <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-ink to-transparent" />
      </div>

      <div className="relative mt-auto">
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-4xl font-black tracking-tight"
        >
          Alpha<span className="text-monad">Scroll</span>
        </motion.h1>
        <p className="mt-2 text-white/60">Scroll the alpha. Double-tap to ape in.</p>

        <ul className="mt-6 space-y-3">
          {FEATURES.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-3 text-sm text-white/80">
              <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-monad/15 text-monad-soft">
                <Icon className="size-4" />
              </span>
              <span className="pt-1.5">{text}</span>
            </li>
          ))}
        </ul>

        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={connect}
          disabled={busy}
          className="mt-8 flex w-full items-center justify-center gap-2 rounded-2xl bg-monad py-4 font-bold shadow-[0_10px_40px_-10px] shadow-monad transition disabled:opacity-60"
        >
          {busy ? <Loader2 className="size-5 animate-spin" /> : <Wallet className="size-5" />}
          {busy ? "Check MetaMask…" : metaMask ? "Connect MetaMask" : walletFound ? "Connect wallet" : "Install MetaMask"}
        </motion.button>
        {!walletFound && (
          <p className="mt-2 text-center text-xs text-white/50">
            AlphaScroll uses the MetaMask browser extension. Install it, then reload this page.
          </p>
        )}
        {walletFound && (
          <p className="mt-2 text-center text-xs text-white/50">
            MetaMask will ask to add and switch to {CHAIN.name}.
          </p>
        )}
        <button onClick={onGuest} className="mt-3 w-full py-2 text-sm font-medium text-white/60 hover:text-white">
          Browse as guest
        </button>
        <p className="mt-4 text-center text-[11px] text-white/35">
          {CHAIN.name} · Sign-In with Ethereum, no gas · Not financial advice
          {FAUCET_URL && (
            <>
              {" · "}
              <a className="underline" href={FAUCET_URL} target="_blank" rel="noreferrer">
                Testnet faucet
              </a>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
