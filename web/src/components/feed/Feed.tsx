"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, Home, Loader2, User, Volume2, VolumeX, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Address, formatEther, parseEther } from "viem";
import { shortAddr } from "@/lib/format";
import type { FeedPage, FeedVideo } from "@/lib/types";
import { explorerTx, tradableAddress } from "@/lib/web3/chain";
import { type LocalSession, loadSession, quickBuy } from "@/lib/web3/trading";
import { useToast } from "../Toast";
import { CommentsSheet } from "./CommentsSheet";
import { ProfileSheet } from "./ProfileSheet";
import { SessionSheet } from "./SessionSheet";
import { StatsSheet } from "./StatsSheet";
import { useConfetti } from "./useConfetti";
import { VideoCard } from "./VideoCard";
import { WalletGuard } from "./WalletGuard";

const PAGE_SIZE = 8;
const POLL_MS = 20_000;
const DEMO_AMOUNT = parseEther("0.1");
type SheetKind = "comments" | "stats" | "session" | "profile";

async function fetchPage(cursor?: string | null): Promise<FeedPage> {
  const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) qs.set("cursor", cursor);
  const res = await fetch(`/api/feed?${qs}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Feed unavailable");
  return res.json();
}

export function Feed({ address, onRequestLogin }: { address: string | null; onRequestLogin: () => void }) {
  const toast = useToast();
  const { canvasRef, fire } = useConfetti();
  const scrollRef = useRef<HTMLDivElement>(null);

  const [videos, setVideos] = useState<FeedVideo[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [incoming, setIncoming] = useState<FeedVideo[]>([]);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(true);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [sheetVideo, setSheetVideo] = useState<FeedVideo | null>(null);
  const pendingBuy = useRef<FeedVideo | null>(null);
  const videosRef = useRef(videos);
  useEffect(() => {
    videosRef.current = videos;
  }, [videos]);
  const buying = useRef(new Set<string>());

  // ---------------------------------------------------------------- data
  useEffect(() => {
    fetchPage()
      .then((p) => {
        setVideos(p.videos);
        setCursor(p.nextCursor);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, [address]);

  // The worker renders new reels in the background: surface them as a pill
  // instead of shifting the video the user is watching.
  useEffect(() => {
    if (status !== "ready") return;
    const timer = setInterval(async () => {
      const latest = await fetchPage().catch(() => null);
      if (!latest) return;
      const current = videosRef.current;
      const known = new Set(current.map((v) => v.id));
      const newest = current[0]?.createdAt ?? "";
      setIncoming(latest.videos.filter((v) => !known.has(v.id) && v.createdAt > newest));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [status]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const p = await fetchPage(cursor);
      setVideos((v) => [...v, ...p.videos.filter((x) => !v.some((y) => y.id === x.id))]);
      setCursor(p.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  function showIncoming() {
    setVideos((v) => [...incoming, ...v]);
    setIncoming([]);
    setActive(0);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ------------------------------------------------------- active video
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const index = Number((e.target as HTMLElement).dataset.index);
          setActive(index);
          if (index >= videos.length - 3) loadMoreRef.current(); // prefetch the next page early
        }
      },
      { root, threshold: 0.6 },
    );
    root.querySelectorAll("section[data-index]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [videos]);

  // Keyboard navigation on desktop.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const root = scrollRef.current;
      if (!root || sheet || (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        root.scrollBy({ top: (e.key === "ArrowDown" ? 1 : -1) * root.clientHeight, behavior: "smooth" });
      }
      if (e.key === "m") setMuted((m) => !m);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet]);

  // --------------------------------------------------------- mutations
  const patch = useCallback((id: string, fn: (v: FeedVideo) => Partial<FeedVideo>) => {
    setVideos((vs) => vs.map((v) => (v.id === id ? { ...v, ...fn(v) } : v)));
    setSheetVideo((v) => (v && v.id === id ? { ...v, ...fn(v) } : v));
  }, []);

  const like = useCallback(
    async (video: FeedVideo, force?: boolean) => {
      if (!address) {
        toast.show({ kind: "info", title: "Connect your wallet to like videos" });
        return;
      }
      const liked = force ?? !video.likedByMe;
      if (liked === video.likedByMe) return;
      patch(video.id, (v) => ({ likedByMe: liked, likes: v.likes + (liked ? 1 : -1) }));
      const res = await fetch(`/api/videos/${video.id}/like`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liked }),
      }).catch(() => null);
      if (res?.ok) {
        const json = (await res.json()) as { liked: boolean; likes: number };
        patch(video.id, () => ({ likedByMe: json.liked, likes: json.likes }));
      } else {
        patch(video.id, (v) => ({ likedByMe: !liked, likes: v.likes + (liked ? -1 : 1) }));
      }
    },
    [address, patch, toast],
  );

  const recordTrade = useCallback(
    async (video: FeedVideo, body: Record<string, string>) => {
      const res = await fetch("/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: video.id, ...body }),
      }).catch(() => null);
      if (res?.ok) patch(video.id, (v) => ({ trades: v.trades + 1 }));
    },
    [patch],
  );

  const executeBuy = useCallback(
    async (video: FeedVideo, session: LocalSession | null) => {
      if (buying.current.has(video.id)) return;
      buying.current.add(video.id);
      const sym = `$${video.token.symbol}`;
      const token = tradableAddress(video.token);
      try {
        if (token && session) {
          const amount = BigInt(session.maxPerTrade);
          const id = toast.show({ kind: "loading", title: `Buying ${sym}…`, body: `${formatEther(amount)} MON · no popup` });
          try {
            const { hash } = await quickBuy(session, token, amount);
            fire();
            toast.update(id, { kind: "success", title: `Aped into ${sym} 🚀`, body: `${formatEther(amount)} MON`, href: explorerTx(hash) }, 6000);
            recordTrade(video, { mode: "onchain", txHash: hash });
          } catch (err) {
            const msg = err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err);
            toast.update(id, { kind: "error", title: `${sym} buy failed`, body: msg.slice(0, 140) });
          }
        } else {
          const id = toast.show({ kind: "loading", title: `Buying ${sym}…` });
          await new Promise((r) => setTimeout(r, 450));
          fire();
          toast.update(id, {
            kind: "success",
            title: `Demo buy: ${formatEther(DEMO_AMOUNT)} MON of ${sym}`,
            body: "Simulated: no on-chain trade was made.",
          });
          recordTrade(video, { mode: "demo", amountInWei: DEMO_AMOUNT.toString() });
        }
      } finally {
        buying.current.delete(video.id);
      }
    },
    [fire, recordTrade, toast],
  );

  /** Double-tap: like + buy. Needs sign-in; on-chain buys need a session key once. */
  const onDoubleTap = useCallback(
    (video: FeedVideo) => {
      if (!address) {
        toast.show({ kind: "info", title: "Connect your wallet to ape in" });
        onRequestLogin();
        return;
      }
      like(video, true);
      if (tradableAddress(video.token)) {
        const session = loadSession(address as Address);
        if (!session) {
          pendingBuy.current = video;
          setSheet("session");
          return;
        }
        executeBuy(video, session);
      } else {
        executeBuy(video, null);
      }
    },
    [address, executeBuy, like, onRequestLogin, toast],
  );

  const openSheet = useCallback((kind: SheetKind, video?: FeedVideo) => {
    if (video) setSheetVideo(video);
    setSheet(kind);
  }, []);
  const onComments = useCallback((v: FeedVideo) => openSheet("comments", v), [openSheet]);
  const onStats = useCallback((v: FeedVideo) => openSheet("stats", v), [openSheet]);
  const onLike = useCallback((v: FeedVideo) => like(v), [like]);
  const onShare = useCallback(
    async (v: FeedVideo) => {
      const url = `${window.location.origin}/api/media/${v.videoUrl.split("/api/media/")[1]}`;
      const text = `$${v.token.symbol} on AlphaScroll`;
      try {
        if (navigator.share) await navigator.share({ title: text, url });
        else {
          await navigator.clipboard.writeText(url);
          toast.show({ kind: "info", title: "Link copied" });
        }
      } catch {
        // share sheet dismissed
      }
    },
    [toast],
  );

  // ------------------------------------------------------------- render
  return (
    <div className="relative h-full w-full bg-black">
      <div ref={scrollRef} className="no-scrollbar h-full w-full snap-y snap-mandatory overflow-y-scroll overscroll-contain">
        {status === "loading" && (
          <div className="grid h-full place-items-center">
            <Loader2 className="size-8 animate-spin text-monad" />
          </div>
        )}
        {status === "error" && <EmptyState title="Feed unavailable" body="Could not reach the API. Is the server running?" />}
        {status === "ready" && videos.length === 0 && (
          <EmptyState
            title="No reels yet"
            body="The AI worker hasn't rendered anything. Start it with:"
            code="cd worker && python video_worker.py --loop"
          />
        )}
        {videos.map((v, i) => (
          <VideoCard
            key={v.id}
            video={v}
            index={i}
            isActive={i === active}
            mounted={Math.abs(i - active) <= 2}
            preload={i === active || i === active + 1}
            muted={muted}
            onDoubleTap={onDoubleTap}
            onLike={onLike}
            onComments={onComments}
            onStats={onStats}
            onShare={onShare}
          />
        ))}
        {loadingMore && (
          <div className="grid h-24 place-items-center">
            <Loader2 className="size-6 animate-spin text-white/40" />
          </div>
        )}
      </div>

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4 pt-3 sm:pt-12">
        <span className="pointer-events-auto flex items-center gap-1 rounded-full bg-dump px-2 py-0.5 text-[10px] font-black">
          <span className="size-1.5 animate-pulse rounded-full bg-white" /> LIVE
        </span>
        <div className="flex gap-4 text-[15px] font-bold text-shadow">
          <span className="text-white/60">Following</span>
          <span className="border-b-2 border-white pb-0.5">For You</span>
        </div>
        <button
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? "Unmute" : "Mute"}
          className="pointer-events-auto rounded-full bg-black/30 p-1.5 backdrop-blur"
        >
          {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
        </button>
      </div>

      <AnimatePresence>
        {incoming.length > 0 && (
          <motion.button
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -20, opacity: 0 }}
            onClick={showIncoming}
            className="absolute left-1/2 top-14 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-monad px-3.5 py-1.5 text-xs font-bold shadow-lg sm:top-[5.5rem]"
          >
            <ArrowUp className="size-3.5" /> {incoming.length} new {incoming.length === 1 ? "reel" : "reels"}
          </motion.button>
        )}
      </AnimatePresence>

      <WalletGuard address={address} />

      {/* Bottom nav */}
      <nav className="absolute inset-x-0 bottom-0 z-30 flex h-[3.25rem] items-center justify-around border-t border-white/10 bg-black pb-1 text-[10px] font-semibold sm:h-14 sm:pb-3">
        <span className="flex flex-col items-center gap-0.5">
          <Home className="size-5" /> Home
        </span>
        <button onClick={() => (address ? setSheet("session") : onRequestLogin())} className="flex flex-col items-center gap-0.5 text-white/70">
          <span className="grid h-7 w-11 place-items-center rounded-lg bg-gradient-to-r from-pump via-white to-dump text-ink">
            <Zap className="size-4" />
          </span>
          Trade
        </button>
        <button onClick={() => setSheet("profile")} className="flex flex-col items-center gap-0.5 text-white/70">
          <User className="size-5" /> {address ? shortAddr(address) : "Guest"}
        </button>
      </nav>

      {/* Confetti stays inside the phone screen */}
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-[70] h-full w-full" />

      <CommentsSheet
        open={sheet === "comments"}
        video={sheetVideo}
        address={address}
        onClose={() => setSheet(null)}
        onRequestLogin={onRequestLogin}
        onPosted={(id) => patch(id, (v) => ({ comments: v.comments + 1 }))}
      />
      <StatsSheet
        open={sheet === "stats"}
        video={sheetVideo}
        onClose={() => setSheet(null)}
        onBuy={(v) => {
          setSheet(null);
          onDoubleTap(v);
        }}
        onOpenSession={() => setSheet("session")}
      />
      <SessionSheet
        open={sheet === "session"}
        owner={address as Address | null}
        onClose={() => {
          pendingBuy.current = null;
          setSheet(null);
        }}
        onReady={(session) => {
          setSheet(null);
          const video = pendingBuy.current;
          pendingBuy.current = null;
          if (video) executeBuy(video, session);
        }}
      />
      <ProfileSheet
        open={sheet === "profile"}
        address={address}
        onClose={() => setSheet(null)}
        onOpenSession={() => setSheet("session")}
        onRequestLogin={onRequestLogin}
      />
    </div>
  );
}

function EmptyState({ title, body, code }: { title: string; body: string; code?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <p className="text-lg font-bold">{title}</p>
      <p className="mt-2 text-sm text-white/60">{body}</p>
      {code && <code className="mt-3 rounded-lg bg-white/10 px-3 py-2 text-xs text-monad-soft">{code}</code>}
    </div>
  );
}
