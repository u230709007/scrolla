"use client";

import { AnimatePresence, type HTMLMotionProps, motion } from "framer-motion";
import {
  Bookmark,
  BarChart3,
  Heart,
  MessageCircle,
  Play,
  Share2,
  Sparkles,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  fmtCount,
  fmtPct,
  fmtPrice,
  fmtUsd,
  PERSONA_NAMES,
  timeAgo,
} from "@/lib/format";
import type { FeedVideo, LiveActivity } from "@/lib/types";
import { isForeignToken, tradableAddress } from "@/lib/web3/chain";

/** Which network the reel is about: double-tap buys only on the testnet ones. */
function NetworkTag({ video }: { video: FeedVideo }) {
  if (isForeignToken(video.token)) {
    return (
      <span className="rounded bg-white/15 px-1.5 py-0.5 text-[9px] font-extrabold tracking-wider text-white/80">
        MAINNET
      </span>
    );
  }
  if (tradableAddress(video.token)) {
    return (
      <span className="rounded bg-monad px-1.5 py-0.5 text-[9px] font-extrabold tracking-wider text-white">
        TESTNET · 2× BUY
      </span>
    );
  }
  return null; // mock tokens: demo buys
}

/** Why this video sits in the live section, freshest signal first. */
function liveLabel(live: LiveActivity): string | null {
  if (live.lastTradeAt) return `Bought on AlphaScroll ${timeAgo(live.lastTradeAt)} ago`;
  if (live.lastMarketTradeAt) {
    const big = live.largestBuyUsd15m >= 50 ? ` · ${fmtUsd(live.largestBuyUsd15m)} buy` : "";
    return `Last trade ${timeAgo(live.lastMarketTradeAt)} ago${big}`;
  }
  if (live.txns5m > 0) return `${fmtCount(live.txns5m)} trades in 5 min`;
  if (live.txns1h > 0) return `${fmtCount(live.txns1h)} trades in 1 h`;
  return null;
}

const DOUBLE_TAP_MS = 280;

type Burst = { id: number; x: number; y: number; rotate: number };

export type VideoCardProps = {
  video: FeedVideo;
  index: number;
  isActive: boolean;
  /** Mount a <video> element at all (only near the viewport, to save memory). */
  mounted: boolean;
  /** Fetch the file ahead of time (active + next), for zero-latency swipes. */
  preload: boolean;
  muted: boolean;
  onDoubleTap: (video: FeedVideo) => void;
  onLike: (video: FeedVideo) => void;
  onComments: (video: FeedVideo) => void;
  onStats: (video: FeedVideo) => void;
  onShare: (video: FeedVideo) => void;
  saved: boolean;
  onSave: (video: FeedVideo) => void;
};

export const VideoCard = memo(function VideoCard({
  video,
  index,
  isActive,
  mounted,
  preload,
  muted,
  onDoubleTap,
  onLike,
  onComments,
  onStats,
  onShare,
  saved,
  onSave,
}: VideoCardProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const lastTap = useRef(0);
  const singleTap = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Play only the card in view; rewind the others like TikTok does.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (isActive) {
      el.play()
        .then(() => setPaused(false))
        .catch(() => setPaused(true)); // autoplay blocked -> show play button
    } else {
      el.pause();
      el.currentTime = 0; // fires timeupdate, which resets the progress bar
    }
  }, [isActive, mounted]);

  useEffect(() => () => clearTimeout(singleTap.current), []);

  const togglePlay = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) {
      el.play()
        .then(() => setPaused(false))
        .catch(() => undefined);
    } else {
      el.pause();
      setPaused(true);
    }
  }, []);

  // Single tap = pause/play, double tap = heart burst + buy. Handled via click
  // timing so it behaves the same with a mouse (dblclick) and on touch screens.
  function handleTap(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const now = performance.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      clearTimeout(singleTap.current);
      lastTap.current = 0;
      const burst = {
        id: now,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        rotate: Math.random() * 40 - 20,
      };
      setBursts((b) => [...b, burst]);
      setTimeout(
        () => setBursts((b) => b.filter((x) => x.id !== burst.id)),
        900,
      );
      onDoubleTap(video);
      return;
    }
    lastTap.current = now;
    singleTap.current = setTimeout(togglePlay, DOUBLE_TAP_MS);
  }

  const handle = video.creator
    ? video.creator.slice(0, 10)
    : video.persona
      ? (PERSONA_NAMES[video.persona] ?? video.persona)
      : "alphascroll.ai";
  const up = video.token.change24h >= 0;

  return (
    <section
      data-index={index}
      className="relative h-full w-full shrink-0 snap-start snap-always overflow-hidden bg-black"
    >
      {mounted ? (
        <video
          ref={ref}
          src={video.videoUrl}
          poster={video.posterUrl || undefined}
          className="absolute inset-0 h-full w-full object-cover"
          playsInline
          loop
          muted={muted}
          preload={preload ? "auto" : "metadata"}
          onTimeUpdate={(e) =>
            setProgress(
              e.currentTarget.currentTime / (e.currentTarget.duration || 1),
            )
          }
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- local worker thumbnail
        <img
          src={video.posterUrl || undefined}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}

      {/* Legibility gradients */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/50 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/80 via-black/30 to-transparent" />

      {/* Tap surface */}
      <div
        className="absolute inset-0"
        onClick={handleTap}
        data-testid="tap-surface"
      />

      <AnimatePresence>
        {paused && isActive && (
          <motion.div
            className="pointer-events-none absolute inset-0 grid place-items-center"
            initial={{ opacity: 0, scale: 1.3 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
          >
            <Play className="size-20 fill-white/80 text-white/80 drop-shadow-xl" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Double-tap hearts */}
      <AnimatePresence>
        {bursts.map((b) => (
          <motion.div
            key={b.id}
            className="pointer-events-none absolute z-20"
            style={{ left: b.x - 48, top: b.y - 48 }}
            initial={{ scale: 0.2, opacity: 0, rotate: b.rotate }}
            animate={{ scale: [0.2, 1.25, 1], opacity: 1, rotate: b.rotate }}
            exit={{ y: -140, scale: 1.6, opacity: 0 }}
            transition={{ duration: 0.35 }}
          >
            <Heart className="size-24 fill-dump text-dump drop-shadow-[0_6px_24px_rgba(255,59,107,0.7)]" />
          </motion.div>
        ))}
      </AnimatePresence>

      {/* Right action rail */}
      <div className="absolute bottom-28 right-2 z-10 flex flex-col items-center gap-4">
        <div className="relative mb-1">
          <div
            className={`grid size-12 place-items-center rounded-full border-2 border-white text-lg font-black ${
              video.format === "avatar"
                ? "bg-gradient-to-br from-pump to-monad"
                : "bg-gradient-to-br from-monad to-dump"
            }`}
          >
            {video.format === "avatar" ? <Sparkles className="size-5" /> : "A"}
          </div>
        </div>
        <RailButton
          label={fmtCount(video.likes)}
          onClick={() => onLike(video)}
          aria-label="Like"
        >
          <motion.span
            key={String(video.likedByMe)}
            initial={{ scale: 0.6 }}
            animate={{ scale: 1 }}
          >
            <Heart
              className={`size-8 drop-shadow ${video.likedByMe ? "fill-dump text-dump" : "fill-white/10"}`}
            />
          </motion.span>
        </RailButton>
        <RailButton
          label={fmtCount(video.comments)}
          onClick={() => onComments(video)}
          aria-label="Comments"
        >
          <MessageCircle className="size-8 fill-white/10 drop-shadow" />
        </RailButton>
        <RailButton
          label={saved ? "Saved" : "Save"}
          onClick={() => onSave(video)}
          aria-label="Save video"
          aria-pressed={saved}
        >
          <Bookmark
            className={`size-7 ${saved ? "fill-gold text-gold" : "fill-white/10"}`}
          />
        </RailButton>
        {video.source !== "upload" && (
          <RailButton
            label="Stats"
            onClick={() => onStats(video)}
            aria-label="Token stats"
          >
            <BarChart3 className="size-8 drop-shadow" />
          </RailButton>
        )}
        <RailButton
          label="Share"
          onClick={() => onShare(video)}
          aria-label="Share"
        >
          <Share2 className="size-7 drop-shadow" />
        </RailButton>
        {video.source !== "upload" && (
          <button
            onClick={() => onStats(video)}
            aria-label={`${video.token.symbol} details`}
            className="mt-1 grid size-11 animate-spin-slow place-items-center rounded-full border-[6px] border-neutral-800 bg-gradient-to-br from-monad to-pump text-[9px] font-black"
          >
            ${video.token.symbol.slice(0, 4)}
          </button>
        )}
      </div>

      {/* Caption block */}
      <div className="pointer-events-none absolute inset-x-0 bottom-20 z-10 pl-3 pr-20 text-shadow">
        <p className="text-[15px] font-bold">
          @{handle}{" "}
          <span className="font-normal text-white/60">
            · {timeAgo(video.createdAt)}
          </span>
        </p>
        {video.hook && (
          <p className="mt-1 text-sm font-extrabold uppercase tracking-wide text-gold">
            {video.hook}
          </p>
        )}
        <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-white/90">
          {video.narration}
        </p>
        {video.live && liveLabel(video.live) && (
          <p className="mt-2 flex w-fit items-center gap-1.5 rounded-full bg-pump/15 px-2.5 py-1 text-[11px] font-bold text-pump">
            <span className="size-1.5 animate-pulse rounded-full bg-pump" />
            {liveLabel(video.live)}
          </p>
        )}
        {video.source !== "upload" && (
          <button
            onClick={() => onStats(video)}
            className="pointer-events-auto mt-2 inline-flex items-center gap-2 rounded-full bg-black/45 px-3 py-1.5 text-xs font-semibold backdrop-blur"
          >
            <NetworkTag video={video} />
            <span>${video.token.symbol}</span>
            <span className="text-white/70">
              {fmtPrice(video.token.priceUsd)}
            </span>
            <span className={up ? "text-pump" : "text-dump"}>
              {fmtPct(video.token.change24h)}
            </span>
          </button>
        )}
        {video.source !== "upload" && (
          <p className="mt-1.5 text-[10px] uppercase tracking-wider text-white/45">
            AI-generated · Not financial advice
          </p>
        )}
      </div>

      {/* Progress */}
      <div className="pointer-events-none absolute inset-x-0 bottom-16 z-10 h-0.5 bg-white/15">
        <div
          className="h-full bg-white/80"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </section>
  );
});

function RailButton({
  label,
  children,
  ...props
}: { label: string; children: React.ReactNode } & HTMLMotionProps<"button">) {
  return (
    <motion.button
      whileTap={{ scale: 0.82 }}
      className="flex flex-col items-center gap-0.5"
      {...props}
    >
      {children}
      <span className="text-xs font-semibold text-shadow">{label}</span>
    </motion.button>
  );
}
