"use client";

import { AnimatePresence, motion } from "framer-motion";

import {
  ArrowUp,
  Home,
  Loader2,
  User,
  Volume2,
  VolumeX,
  Zap,
  Search,
} from "lucide-react";

import { useCallback, useEffect, useRef, useState } from "react";

import { type Address, formatEther, parseEther } from "viem";

import { CreatorProfile, Discover, UploadScreen } from "./CreatorScreens";

import type { FeedPage, FeedVideo } from "@/lib/types";

import { explorerTx, isForeignToken, tradableAddress } from "@/lib/web3/chain";

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

export function Feed({
  address,
  onRequestLogin,
}: {
  address: string | null;
  onRequestLogin: () => void;
}) {
  const toast = useToast();

  const { canvasRef, fire } = useConfetti();

  const scrollRef = useRef<HTMLDivElement>(null);

  const [screen, setScreen] = useState<
    "home" | "discover" | "upload" | "profile"
  >("home");

  const [saved, setSaved] = useState<FeedVideo[]>([]);

  const [profileRevision, setProfileRevision] = useState(0);

  useEffect(() => {

    try {
      const value = JSON.parse(
        localStorage.getItem("alphascroll.saved") || "[]",
      );
      if (Array.isArray(value))
        // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate browser-only saved collection
        setSaved(
          value.filter(
            (v) =>
              v &&
              typeof v.id === "string" &&
              typeof v.videoUrl === "string" &&
              v.token,
          ),
        );
    } catch {
      /* unavailable storage */
    }
  }, []);

  function toggleSave(video: FeedVideo) {
    setSaved((current) => {
      const next = current.some((v) => v.id === video.id)
        ? current.filter((v) => v.id !== video.id)
        : [...current, video];

      try {
        localStorage.setItem("alphascroll.saved", JSON.stringify(next));
      } catch {
        toast.show({
          kind: "error",
          title: "Kaydedilenler bu tarayıcıda saklanamadı",
        });
      }

      return next;
    });
  }

  function selectVideo(video: FeedVideo) {
    let index = videos.findIndex((v) => v.id === video.id);

    if (index < 0) {
      index = videos.length;
      setVideos((v) => [...v, video]);
    }

    setScreen("home");
    setActive(index);

    requestAnimationFrame(() =>
      scrollRef.current?.scrollTo({
        top: index * scrollRef.current.clientHeight,
      }),
    );
  }

  const [videos, setVideos] = useState<FeedVideo[]>([]);

  const [cursor, setCursor] = useState<string | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );

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

      // The first page is ranked by live trading, so the newest video isn't necessarily first.
      const newest = current.reduce((max, v) => (v.createdAt > max ? v.createdAt : max), "");

      setIncoming(
        latest.videos.filter((v) => !known.has(v.id) && v.createdAt > newest),
      );
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [status]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;

    setLoadingMore(true);

    try {
      const p = await fetchPage(cursor);

      setVideos((v) => [
        ...v,
        ...p.videos.filter((x) => !v.some((y) => y.id === x.id)),
      ]);

      setCursor(p.nextCursor);
    } catch {
      toast.show({ kind: "error", title: "Daha fazla video yüklenemedi" });
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, toast]);

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

    root
      .querySelectorAll("section[data-index]")
      .forEach((el) => io.observe(el));

    return () => io.disconnect();
  }, [videos]);

  // Keyboard navigation on desktop.

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const root = scrollRef.current;

      if (
        !root ||
        sheet ||
        screen !== "home" ||
        ["INPUT", "TEXTAREA", "BUTTON"].includes(
          (e.target as HTMLElement).tagName,
        )
      )
        return;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();

        root.scrollBy({
          top: (e.key === "ArrowDown" ? 1 : -1) * root.clientHeight,
          behavior: "smooth",
        });
      }

      if (e.key === "m") setMuted((m) => !m);
    }

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, screen]);

  // --------------------------------------------------------- mutations

  const patch = useCallback(
    (id: string, fn: (v: FeedVideo) => Partial<FeedVideo>) => {
      setVideos((vs) => vs.map((v) => (v.id === id ? { ...v, ...fn(v) } : v)));

      setSheetVideo((v) => (v && v.id === id ? { ...v, ...fn(v) } : v));
    },
    [],
  );

  const like = useCallback(
    async (video: FeedVideo, force?: boolean) => {
      if (!address) {
        toast.show({
          kind: "info",
          title: "Connect your wallet to like videos",
        });

        return;
      }

      const liked = force ?? !video.likedByMe;

      if (liked === video.likedByMe) return;

      patch(video.id, (v) => ({
        likedByMe: liked,
        likes: v.likes + (liked ? 1 : -1),
      }));

      const res = await fetch(`/api/videos/${video.id}/like`, {
        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({ liked }),
      }).catch(() => null);

      if (res?.ok) {
        const json = (await res.json()) as { liked: boolean; likes: number };

        patch(video.id, () => ({ likedByMe: json.liked, likes: json.likes }));
      } else {
        patch(video.id, (v) => ({
          likedByMe: !liked,
          likes: v.likes + (liked ? -1 : 1),
        }));
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

          const id = toast.show({
            kind: "loading",
            title: `Buying ${sym}…`,
            body: `${formatEther(amount)} MON · no popup`,
          });

          try {
            const { hash } = await quickBuy(session, token, amount);

            fire();

            toast.update(
              id,
              {
                kind: "success",
                title: `Aped into ${sym} 🚀`,
                body: `${formatEther(amount)} MON`,
                href: explorerTx(hash),
              },
              6000,
            );

            recordTrade(video, { mode: "onchain", txHash: hash });
          } catch (err) {
            const msg =
              err instanceof Error
                ? ((err as { shortMessage?: string }).shortMessage ??
                  err.message)
                : String(err);

            toast.update(id, {
              kind: "error",
              title: `${sym} buy failed`,
              body: msg.slice(0, 140),
            });
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

          recordTrade(video, {
            mode: "demo",
            amountInWei: DEMO_AMOUNT.toString(),
          });
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

      if (video.source === "upload") return;

      if (isForeignToken(video.token)) {
        toast.show({
          kind: "info",
          title: `$${video.token.symbol} mainnet'te`,
          body: "Çift tıklayınca alım şimdilik sadece TESTNET videolarında yapılıyor.",
        });

        return;
      }

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

  const onComments = useCallback(
    (v: FeedVideo) => openSheet("comments", v),
    [openSheet],
  );

  const onStats = useCallback(
    (v: FeedVideo) => openSheet("stats", v),
    [openSheet],
  );

  const onLike = useCallback((v: FeedVideo) => like(v), [like]);

  const onShare = useCallback(
    async (v: FeedVideo) => {
      const url = new URL(v.videoUrl, window.location.origin).href;

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
      <div
        ref={scrollRef}
        className={`no-scrollbar h-full w-full snap-y snap-mandatory overflow-y-scroll overscroll-contain ${screen !== "home" ? "invisible" : ""}`}
      >
        {status === "loading" && (
          <div className="grid h-full place-items-center">
            <Loader2 className="size-8 animate-spin text-monad" />
          </div>
        )}

        {status === "error" && (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <p className="font-bold">Akış yüklenemedi</p>
            <button
              className="secondary-button mt-4"
              onClick={() => {
                setStatus("loading");
                fetchPage()
                  .then((p) => {
                    setVideos(p.videos);
                    setCursor(p.nextCursor);
                    setStatus("ready");
                  })
                  .catch(() => setStatus("error"));
              }}
            >
              Tekrar dene
            </button>
          </div>
        )}

        {status === "ready" && videos.length === 0 && (
          <EmptyState
            title="Akışın burada başlıyor"

            body="İlk videonu paylaşmak için aşağıdaki + düğmesine dokun."
          />
        )}

        {videos.map((v, i) => (
          <VideoCard
            key={v.id}

            video={v}

            index={i}

            isActive={i === active && screen === "home" && !sheet}

            mounted={Math.abs(i - active) <= 2}

            preload={i === active || i === active + 1}

            muted={muted}

            onDoubleTap={onDoubleTap}

            onLike={onLike}

            onComments={onComments}

            onStats={onStats}

            onShare={onShare}

            saved={saved.some((item) => item.id === v.id)}

            onSave={toggleSave}
          />
        ))}

        {loadingMore && (
          <div className="grid h-24 place-items-center">
            <Loader2 className="size-6 animate-spin text-white/40" />
          </div>
        )}
      </div>

      {/* Top bar */}

      {screen === "home" && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4 pt-3 sm:pt-12">
          <span className="pointer-events-auto flex items-center gap-1 rounded-full bg-dump px-2 py-0.5 text-[10px] font-black">
            <span className="size-1.5 animate-pulse rounded-full bg-white" />{" "}
            LIVE
          </span>

          <div className="flex gap-4 text-[15px] font-bold text-shadow">
            <button
              onClick={() => setScreen("discover")}
              className="pointer-events-auto text-white/60"
            >
              Keşfet
            </button>

            <span className="border-b-2 border-white pb-0.5">Senin İçin</span>
          </div>

          <button
            onClick={() => setMuted((m) => !m)}

            aria-label={muted ? "Unmute" : "Mute"}

            className="pointer-events-auto rounded-full bg-black/30 p-1.5 backdrop-blur"
          >
            {muted ? (
              <VolumeX className="size-5" />
            ) : (
              <Volume2 className="size-5" />
            )}
          </button>
        </div>
      )}

      <AnimatePresence>
        {screen === "home" && incoming.length > 0 && (
          <motion.button
            initial={{ y: -20, opacity: 0 }}

            animate={{ y: 0, opacity: 1 }}

            exit={{ y: -20, opacity: 0 }}

            onClick={showIncoming}

            className="absolute left-1/2 top-14 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-monad px-3.5 py-1.5 text-xs font-bold shadow-lg sm:top-[5.5rem]"
          >
            <ArrowUp className="size-3.5" /> {incoming.length} new{" "}
            {incoming.length === 1 ? "reel" : "reels"}
          </motion.button>
        )}
      </AnimatePresence>

      <WalletGuard address={address} />

      {screen === "discover" && (
        <Discover
          videos={videos}
          onSelect={selectVideo}
          onMore={loadMore}
          hasMore={!!cursor}
          loading={loadingMore}
        />
      )}

      {screen === "profile" && (
        <CreatorProfile
          key={address ?? "guest"}
          address={address}
          saved={saved}
          onSelect={selectVideo}
          onUpload={() => setScreen("upload")}
          onSettings={() => setSheet("profile")}
          onLogin={onRequestLogin}
          revision={profileRevision}
        />
      )}

      {screen === "upload" && (
        <UploadScreen
          address={address}
          onLogin={onRequestLogin}
          onClose={() => setScreen("profile")}
          onPublished={(video) => {
            setVideos((current) => [video, ...current]);
            setIncoming((current) => current.filter((v) => v.id !== video.id));
            setProfileRevision((n) => n + 1);
            setScreen("profile");
            toast.show({ kind: "success", title: "Videon paylaşıldı" });
          }}
        />
      )}

      <nav
        aria-label="Ana gezinme"
        className="absolute inset-x-0 bottom-0 z-30 flex h-16 items-start justify-around border-t border-white/10 bg-[#080809] pt-2 text-[9px] font-semibold"
      >
        <button
          aria-current={screen === "home" ? "page" : undefined}
          onClick={() => {
            setScreen("home");
            scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
          }}
          className={`flex w-14 flex-col items-center gap-1 ${screen === "home" ? "text-white" : "text-white/45"}`}
        >
          <Home size={22} fill={screen === "home" ? "currentColor" : "none"} />
          Ana Sayfa
        </button>

        <button
          aria-current={screen === "discover" ? "page" : undefined}
          onClick={() => setScreen("discover")}
          className={`flex w-14 flex-col items-center gap-1 ${screen === "discover" ? "text-white" : "text-white/45"}`}
        >
          <Search size={22} />
          Keşfet
        </button>

        <button
          onClick={() => setScreen("upload")}
          aria-label="Video oluştur"
          title="Video oluştur"
          className="relative mt-1 grid h-8 w-11 place-items-center rounded-lg bg-monad text-white transition-colors hover:bg-monad-soft"
        >
          {/* Official Monad logomark geometry: https://monad.xyz/ */}
          <svg width="23" height="23" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M11.782 0C8.37963 0 0 8.53443 0 11.9999C0 15.4654 8.37963 24 11.782 24C15.1844 24 23.5642 15.4653 23.5642 11.9999C23.5642 8.53458 15.1845 0 11.782 0ZM9.94598 18.8619C8.51124 18.4637 4.65378 11.5912 5.04481 10.1299C5.43584 8.66856 12.1834 4.73984 13.6181 5.1381C15.0529 5.5363 18.9104 12.4087 18.5194 13.87C18.1283 15.3314 11.3807 19.2602 9.94598 18.8619Z" />
          </svg>
        </button>

        <button
          onClick={() => (address ? setSheet("session") : onRequestLogin())}
          className="flex w-14 flex-col items-center gap-1 text-white/45"
        >
          <Zap size={22} />
          İşlem
        </button>

        <button
          aria-current={screen === "profile" ? "page" : undefined}
          onClick={() => setScreen("profile")}
          className={`flex w-14 flex-col items-center gap-1 ${screen === "profile" ? "text-white" : "text-white/45"}`}
        >
          <User size={22} />
          Profil
        </button>
      </nav>

      {/* Confetti stays inside the phone screen */}

      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 z-[70] h-full w-full"
      />

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

function EmptyState({
  title,
  body,
  code,
}: {
  title: string;
  body: string;
  code?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <p className="text-lg font-bold">{title}</p>

      <p className="mt-2 text-sm text-white/60">{body}</p>

      {code && (
        <code className="mt-3 rounded-lg bg-white/10 px-3 py-2 text-xs text-monad-soft">
          {code}
        </code>
      )}
    </div>
  );
}
