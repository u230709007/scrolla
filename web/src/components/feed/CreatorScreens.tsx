"use client";
/* eslint-disable @next/next/no-img-element -- worker and uploaded media are already local */

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Bookmark,
  Grid3X3,
  Loader2,
  Play,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Upload,
  User,
  X,
} from "lucide-react";
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

export function CreatorProfile({
  address,
  saved,
  onSelect,
  onUpload,
  onSettings,
  onLogin,
  onPeople,
  revision,
}: {
  address: string | null;
  saved: FeedVideo[];
  onSelect: (v: FeedVideo) => void;
  onUpload: () => void;
  onSettings: () => void;
  onLogin: () => void;
  onPeople: (list: "followers" | "following") => void;
  revision: number;
}) {
  const [videos, setVideos] = useState<FeedVideo[]>([]);
  const [tab, setTab] = useState<"videos" | "saved">("videos");
  const [status, setStatus] = useState("loading");
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
  useEffect(() => {
    let live = true;
    fetch("/api/uploads", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw Error();
        return r.json();
      })
      .then((data) => {
        if (live) {
          setVideos(data.videos);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (live) setStatus("error");
      });
    return () => {
      live = false;
    };
  }, [address, revision]);
  const shown = tab === "videos" ? videos : saved;
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
        <div className="relative mx-auto grid size-21 place-items-center rounded-full bg-gradient-to-br from-[#ff6a8a] via-[#a18bff] to-[#70e7e0]">
          <User size={38} />
          <button
            onClick={onUpload}
            aria-label="Upload a video"
            className="absolute -bottom-1 -right-1 rounded-full border-4 border-[#101012] bg-dump p-1"
          >
            <Plus size={15} />
          </button>
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
            onClick={onUpload}
            className="primary-button flex items-center gap-2"
          >
            <Plus size={17} /> Upload video
          </button>
          <button
            onClick={address ? onSettings : onLogin}
            className="secondary-button"
          >
            {address ? "Manage account" : "Sign in"}
          </button>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-white/45">
          One idea, one video, one new start.
        </p>
      </div>
      <button
        onClick={onUpload}
        className="mx-4 mb-5 flex w-[calc(100%-2rem)] items-center gap-3 rounded-2xl border border-white/10 bg-gradient-to-r from-monad/15 to-transparent p-4 text-left"
      >
        <Sparkles size={24} className="text-monad-soft" />
        <span className="flex-1">
          <b className="text-sm">Creator studio</b>
          <span className="mt-1 block text-[11px] text-white/45">
            Upload a video · Generate with local AI
          </span>
        </span>
        <Plus size={17} />
      </button>
      <div className="grid grid-cols-2 border-b border-white/10">
        {(
          [
            ["videos", Grid3X3, "Videos"],
            ["saved", Bookmark, "Kaydedilenler"],
          ] as const
        ).map(([key, Icon, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            aria-label={label}
            aria-pressed={tab === key}
            className={`flex justify-center border-b-2 py-3 ${tab === key ? "border-white text-white" : "border-transparent text-white/35"}`}
          >
            <Icon size={21} />
          </button>
        ))}
      </div>
      {status === "loading" && tab === "videos" ? (
        <p className="p-8 text-center text-sm text-white/40">
          Loading videos…
        </p>
      ) : status === "error" && tab === "videos" ? (
        <p className="p-8 text-center text-sm text-dump">
          Couldn&apos;t load videos. Try reopening your profile.
        </p>
      ) : shown.length ? (
        <VideoGrid videos={shown} onSelect={onSelect} />
      ) : (
        <div className="px-8 py-10 text-center">
          <div className="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-white/5">
            {tab === "videos" ? <Play size={20} /> : <Bookmark size={20} />}
          </div>
          <p className="text-sm font-semibold">
            {tab === "videos"
              ? "Your first video starts here"
              : "Collect what inspires you"}
          </p>
          <p className="mt-2 text-xs leading-5 text-white/40">
            {tab === "videos"
              ? "Upload a video, add a caption and post it to the feed."
              : "Tap the save icon on a reel to keep it here."}
          </p>
        </div>
      )}
    </div>
  );
}

export function UploadScreen({
  address,
  onLogin,
  onClose,
  onPublished,
}: {
  address: string | null;
  onLogin: () => void;
  onClose: () => void;
  onPublished: (v: FeedVideo) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [caption, setCaption] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"upload" | "ai">("upload");
  const input = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  function select(value?: File) {
    if (!value) return;
    setError("");
    if (
      value.type !== "video/mp4" ||
      value.size > 50 * 1024 * 1024 ||
      !value.size
    ) {
      setError("Choose an MP4 video of up to 50 MB.");
      return;
    }
    setFile(value);
    setPreview(URL.createObjectURL(value));
  }
  async function publish() {
    if (!address) {
      onLogin();
      return;
    }
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      const json = (payload: object) =>
        fetch("/api/uploads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      // Production: the file goes straight to Vercel Blob / R2 (serverless
      // functions cap request bodies at a few MB); locally the server stores it on disk.
      const ticket = await json({ action: "presign", size: file.size, type: file.type });
      let response: Response;
      if (!ticket.ok && ticket.status !== 404) {
        throw Error((await ticket.json()).error || "Upload failed.");
      }
      if (ticket.ok) {
        const { id, provider, pathname, uploadUrl } = await ticket.json();
        if (provider === "blob") {
          const { upload } = await import("@vercel/blob/client");
          await upload(pathname, file, {
            access: "public",
            contentType: "video/mp4",
            handleUploadUrl: "/api/uploads/blob",
          }).catch(() => {
            throw Error("Couldn't upload the video to storage.");
          });
        } else {
          const put = await fetch(uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": "video/mp4" },
            body: file,
          });
          if (!put.ok) throw Error("Couldn't upload the video to storage.");
        }
        response = await json({ action: "complete", id, caption });
      } else {
        const body = new FormData();
        body.set("video", file);
        body.set("caption", caption);
        response = await fetch("/api/uploads", { method: "POST", body });
      }
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Upload failed.");
      onPublished(data.video);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't connect.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="app-screen">
      <header className="flex items-center justify-between px-4 pb-5">
        <button
          onClick={onClose}
          disabled={busy}
          aria-label="Geri"
          className="p-2"
        >
          <ArrowLeft size={22} />
        </button>
        <h1 className="font-semibold">Creator studio</h1>
        <span className="w-9" />
      </header>
      <div className="px-5">
        <p className="eyebrow">SIRA SENDE</p>
        <h2 className="mt-2 text-3xl font-bold tracking-tight">
          Bring your idea to the feed.
        </h2>
        <div className="my-6 grid grid-cols-2 rounded-xl bg-white/5 p-1">
          <button
            onClick={() => setMode("upload")}
            className={`rounded-lg py-2.5 text-xs font-semibold ${mode === "upload" ? "bg-white text-black" : "text-white/50"}`}
          >
            Upload video
          </button>
          <button
            onClick={() => setMode("ai")}
            className={`rounded-lg py-2.5 text-xs font-semibold ${mode === "ai" ? "bg-white text-black" : "text-white/50"}`}
          >
            Yerel AI
          </button>
        </div>
        {mode === "upload" ? (
          <>
            <input
              ref={input}
              type="file"
              accept="video/mp4,.mp4"
              className="hidden"
              aria-label="Video file"
              onChange={(e) => select(e.target.files?.[0])}
              disabled={busy}
            />
            {preview ? (
              <div className="relative">
                <video
                  src={preview}
                  controls
                  playsInline
                  className="mx-auto max-h-64 w-full rounded-2xl bg-black"
                />
                <button
                  disabled={busy}
                  onClick={() => input.current?.click()}
                  className="secondary-button mt-3 w-full"
                >
                  Change video
                </button>
              </div>
            ) : (
              <button
                disabled={busy}
                onClick={() => input.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  select(e.dataTransfer.files[0]);
                }}
                className="flex min-h-52 w-full flex-col items-center justify-center rounded-2xl border border-dashed border-white/25 bg-white/[0.025]"
              >
                <span className="mb-4 rounded-2xl bg-dump/10 p-4 text-dump">
                  <Upload size={27} />
                </span>
                <b className="text-sm">Choose a video to upload</b>
                <span className="mt-2 text-xs text-white/40">
                  or drag your file here
                </span>
                <span className="mt-5 text-[10px] text-white/30">
                  MP4 · Up to 50 MB · Vertical works best
                </span>
              </button>
            )}
            <label className="mt-6 block text-xs font-semibold">
              Caption
              <textarea
                disabled={busy}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                maxLength={300}
                placeholder="Tell the story behind your video… #scrolla"
                rows={3}
                className="mt-2 w-full resize-none rounded-xl border border-white/10 bg-white/5 p-3 text-sm font-normal outline-none focus:border-white/30"
              />
            </label>
            <p className="text-right text-[10px] text-white/35">
              {caption.length}/300
            </p>
            <p className="my-4 text-xs leading-5 text-white/40">
              Your video appears on your profile and in the public feed.
            </p>
            {error && (
              <p role="alert" className="mb-4 text-sm text-dump">
                {error}
              </p>
            )}
            <button
              disabled={busy || (!!address && !file)}
              onClick={publish}
              className="primary-button flex w-full items-center justify-center gap-2 disabled:opacity-40"
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              {busy
                ? "Uploading…"
                : address
                  ? "Post"
                  : "Sign in to post"}
            </button>
          </>
        ) : (
          <div className="rounded-2xl border border-monad/25 bg-monad/5 p-5">
            <Sparkles className="mb-4 text-monad-soft" size={30} />
            <h3 className="text-lg font-bold">
              Local generation, under your control.
            </h3>
            <p className="mt-3 text-sm leading-6 text-white/55">
              Ollama writes the script and the image prompt. The video worker
              turns them into an MP4 with voice, visuals and captions.
            </p>
            <div className="my-5 space-y-3 text-xs text-white/65">
              <p>01 / Run a text model in Ollama.</p>
              <p>02 / Set that model in the video worker.</p>
              <p>03 / The finished video shows up in the feed.</p>
            </div>
            <p className="rounded-xl bg-black/30 p-3 text-xs leading-5 text-white/45">
              This screen doesn&apos;t start a job. Model setup and run steps are in
              the project README. Voice and image services may use the
              internet.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
