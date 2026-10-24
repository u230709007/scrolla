"use client";
/* eslint-disable @next/next/no-img-element -- worker and uploaded media are already local */

import { useEffect, useState } from "react";
import { Bookmark, Play, Search, Settings2, User, X } from "lucide-react";
import type { FeedVideo } from "@/lib/types";
import { shortAddr } from "@/lib/format";

export function VideoGrid({
  videos,
  onSelect,
}: {
  videos: FeedVideo[];
  onSelect: (v: FeedVideo) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-0.5">
      {videos.map((v) => (
        <button
          key={v.id}
          onClick={() => onSelect(v)}
          className="relative aspect-[3/4] overflow-hidden bg-white/5 text-left"
          aria-label={v.narration || "Open video"}
        >
          {v.posterUrl ? (
            <img
              src={v.posterUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <video
              src={v.videoUrl + "#t=0.1"}
              muted
              preload="metadata"
              className="h-full w-full object-cover"
            />
          )}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-8">
            <p className="line-clamp-2 text-[10px]">{v.narration || v.hook}</p>
            <span className="mt-1 flex items-center gap-1 text-[10px]">
              <Play size={11} />
              {v.likes} likes
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

export function Discover({
  videos,
  onSelect,
  onMore,
  hasMore,
  loading,
}: {
  videos: FeedVideo[];
  onSelect: (v: FeedVideo) => void;
  onMore: () => void;
  hasMore: boolean;
  loading: boolean;
}) {
  const [query, setQuery] = useState("");
  const filtered = videos.filter((v) =>
    `${v.narration} ${v.hook} ${v.token.symbol} ${v.persona ?? ""}`
      .toLocaleLowerCase("tr")
      .includes(query.toLocaleLowerCase("tr")),
  );
  return (
    <div className="app-screen">
      <header className="px-5 pb-5">
        <p className="eyebrow">FIND SOMETHING NEW</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Discover<span className="text-dump">.</span>
        </h1>
        <label className="mt-5 flex items-center gap-2 rounded-xl bg-white/[0.07] px-3 py-3">
          <Search size={18} className="text-white/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search videos, tokens or captions"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            aria-label="Search videos"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Clear search">
              <X size={16} />
            </button>
          )}
        </label>
        <p className="mt-5 text-xs text-white/40">
          {filtered.length} videos
        </p>
      </header>
      <VideoGrid videos={filtered} onSelect={onSelect} />
      {!filtered.length && (
        <p className="px-5 py-12 text-center text-sm text-white/50">
          No matching videos yet.
        </p>
      )}
      {hasMore && (
        <button
          disabled={loading}
          onClick={onMore}
          className="secondary-button mx-auto my-5 block"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

/** Account page. Every reel comes from the AI worker (users can't upload, so
 * no one can attach a token to their own content), so it shows saved reels. */
export function CreatorProfile({
  address,
  saved,
  onSelect,
  onSettings,
  onLogin,
  onPeople,
  revision,
}: {
  address: string | null;
  saved: FeedVideo[];
  onSelect: (v: FeedVideo) => void;
  onSettings: () => void;
  onLogin: () => void;
  onPeople: (list: "followers" | "following") => void;
  revision: number;
}) {
  const [stats, setStats] = useState({ followers: 0, following: 0 });
  useEffect(() => {
    if (!address) return;
    let live = true;
    fetch("/api/users/stats", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) setStats(d);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [address, revision]);
  return (
    <div className="app-screen">
      <header className="flex items-center justify-between px-5">
        <span className="text-sm font-semibold">My account</span>
        <button
          onClick={onSettings}
          aria-label="Account settings"
          className="p-2"
        >
          <Settings2 size={21} />
        </button>
      </header>
      <div className="px-5 pb-6 pt-5 text-center">
        <div className="mx-auto grid size-21 place-items-center rounded-full bg-gradient-to-br from-[#ff6a8a] via-[#a18bff] to-[#70e7e0]">
          <User size={38} />
        </div>
        <h1 className="mt-4 text-xl font-bold">
          {address ? shortAddr(address) : "Your stage"}
        </h1>
        <p className="mt-1 text-xs text-white/40">
          {address
            ? "@" + address.slice(2, 10).toLowerCase()
            : "Start sharing your story"}
        </p>
        <div className="mx-auto my-5 flex max-w-64 justify-around">
          <button onClick={() => (address ? onPeople("followers") : onLogin())}>
            <b className="text-lg">{stats.followers}</b>
            <p className="text-[11px] text-white/45">Followers</p>
          </button>
          <button onClick={() => (address ? onPeople("following") : onLogin())}>
            <b className="text-lg">{stats.following}</b>
            <p className="text-[11px] text-white/45">Following</p>
          </button>
        </div>
        <div className="flex justify-center gap-2">
          <button
            onClick={address ? onSettings : onLogin}
            className="secondary-button"
          >
            {address ? "Manage account" : "Sign in"}
          </button>
        </div>
      </div>
      <div className="flex items-center justify-center gap-2 border-b border-white/10 py-3 text-sm font-semibold">
        <Bookmark size={18} /> Saved
      </div>
      {saved.length ? (
        <VideoGrid videos={saved} onSelect={onSelect} />
      ) : (
        <div className="px-8 py-10 text-center">
          <div className="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-white/5">
            <Bookmark size={20} />
          </div>
          <p className="text-sm font-semibold">Collect what inspires you</p>
          <p className="mt-2 text-xs leading-5 text-white/40">
            Tap the save icon on a reel to keep it here.
          </p>
        </div>
      )}
    </div>
  );
}
