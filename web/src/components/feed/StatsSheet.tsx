"use client";

import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Copy, ExternalLink, Zap } from "lucide-react";
import { fmtPct, fmtPrice, fmtUsd, shortAddr } from "@/lib/format";
import type { FeedVideo, LiveStats } from "@/lib/types";
import { tradingEnabled } from "@/lib/web3/trading";
import { useToast } from "../Toast";
import { Sheet } from "./Sheet";

export function StatsSheet({
  open,
  video,
  onClose,
  onBuy,
  onOpenSession,
}: {
  open: boolean;
  video: FeedVideo | null;
  onClose: () => void;
  onBuy: (video: FeedVideo) => void;
  onOpenSession: () => void;
}) {
  const toast = useToast();
  const { data } = useQuery({
    queryKey: ["stats", video?.id],
    enabled: open && !!video,
    refetchInterval: 15_000,
    queryFn: async () => (await fetch(`/api/videos/${video!.id}/stats`)).json() as Promise<LiveStats>,
  });

  if (!video) return null;
  const t = video.token;
  const s = data ?? { ...t, live: false, updatedAt: video.createdAt };
  const up = s.change24h >= 0;
  const onchain = tradingEnabled() && !!t.tokenAddress;

  return (
    <Sheet open={open} onClose={onClose} height="62%" title={<span>${t.symbol} · {t.name}</span>}>
      <div className="flex items-end justify-between">
        <div>
          <p className="text-3xl font-black">{fmtPrice(s.priceUsd)}</p>
          <p className={`text-sm font-bold ${up ? "text-pump" : "text-dump"}`}>{fmtPct(s.change24h)} · 24h</p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
            s.live ? "bg-pump/15 text-pump" : "bg-white/10 text-white/60"
          }`}
        >
          {s.live ? "● LIVE" : "Snapshot at render"}
        </span>
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-2 text-center">
        {[
          ["Volume 24h", fmtUsd(s.volume24h)],
          ["Liquidity", fmtUsd(s.liquidityUsd)],
          ["Market cap", fmtUsd(s.marketCap)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-2xl bg-white/5 p-3">
            <dt className="text-[11px] text-white/50">{k}</dt>
            <dd className="mt-1 font-bold">{v}</dd>
          </div>
        ))}
      </dl>

      {t.chain === "monad-testnet" && (
        <p className="mt-2 text-[11px] text-white/40">
          Testnet pool price × real MON/USD · volume = AlphaScroll buys
        </p>
      )}

      <div className="mt-4 space-y-2 text-sm">
        {t.tokenAddress && (
          <button
            onClick={() => navigator.clipboard?.writeText(t.tokenAddress!).then(() => toast.show({ kind: "info", title: "Address copied" }))}
            className="flex w-full items-center justify-between rounded-xl bg-white/5 px-3 py-2.5"
          >
            <span className="text-white/60">Contract</span>
            <span className="flex items-center gap-1.5 font-mono">
              {shortAddr(t.tokenAddress)} <Copy className="size-3.5" />
            </span>
          </button>
        )}
        {t.dexUrl && (
          <a href={t.dexUrl} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2.5">
            <span className="text-white/60">Chart</span>
            <span className="flex items-center gap-1.5">
              DexScreener <ExternalLink className="size-3.5" />
            </span>
          </a>
        )}
        {!onchain && (
          <p className="rounded-xl bg-gold/10 px-3 py-2.5 text-xs text-gold">
            {tradingEnabled()
              ? "Mock token from the AI worker: buys are simulated."
              : "Demo mode: no trading vault is configured, so buys are simulated."}
          </p>
        )}
      </div>

      <div className="mt-5 flex gap-2">
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={() => onBuy(video)}
          className="flex-1 rounded-2xl bg-pump py-3.5 font-black text-ink"
        >
          Buy ${t.symbol}
        </motion.button>
        {onchain && (
          <button onClick={onOpenSession} aria-label="One-tap trading settings" className="grid w-14 place-items-center rounded-2xl bg-white/10">
            <Zap className="size-5 text-gold" />
          </button>
        )}
      </div>
      <p className="mt-2 text-center text-[11px] text-white/40">Tip: double-tap the video to buy instantly</p>
    </Sheet>
  );
}
