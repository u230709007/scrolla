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
          aria-label={v.narration || "Videoyu aç"}
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
              {v.likes} beğeni
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
        <p className="eyebrow">YENİ BİR ŞEY KEŞFET</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Keşfet<span className="text-dump">.</span>
        </h1>
        <label className="mt-5 flex items-center gap-2 rounded-xl bg-white/[0.07] px-3 py-3">
          <Search size={18} className="text-white/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Video, token veya içerik ara"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            aria-label="Video ara"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Aramayı temizle">
              <X size={16} />
            </button>
          )}
        </label>
        <p className="mt-5 text-xs text-white/40">
          {filtered.length} video · Sana yeni bir bakış açısı
        </p>
      </header>
      <VideoGrid videos={filtered} onSelect={onSelect} />
      {!filtered.length && (
        <p className="px-5 py-12 text-center text-sm text-white/50">
          Henüz eşleşen video yok.
        </p>
      )}
      {hasMore && (
        <button
          disabled={loading}
          onClick={onMore}
          className="secondary-button mx-auto my-5 block"
        >
          {loading ? "Yükleniyor…" : "Daha fazla keşfet"}
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
        <span className="text-sm font-semibold">Hesabım</span>
        <button
          onClick={onSettings}
          aria-label="Hesap ayarları"
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
            aria-label="Video yükle"
            className="absolute -bottom-1 -right-1 rounded-full border-4 border-[#101012] bg-dump p-1"
          >
            <Plus size={15} />
          </button>
        </div>
        <h1 className="mt-4 text-xl font-bold">
          {address ? shortAddr(address) : "Senin sahnen"}
        </h1>
        <p className="mt-1 text-xs text-white/40">
          {address
            ? "@" + address.slice(2, 10).toLowerCase()
            : "Hikâyeni paylaşmaya başla"}
        </p>
        <div className="mx-auto my-5 flex max-w-64 justify-around">
          <button onClick={() => (address ? onPeople("followers") : onLogin())}>
            <b className="text-lg">{stats.followers}</b>
            <p className="text-[11px] text-white/45">Takipçi</p>
          </button>
          <button onClick={() => (address ? onPeople("following") : onLogin())}>
            <b className="text-lg">{stats.following}</b>
            <p className="text-[11px] text-white/45">Takip</p>
          </button>
        </div>
        <div className="flex justify-center gap-2">
          <button
            onClick={onUpload}
            className="primary-button flex items-center gap-2"
          >
            <Plus size={17} /> Video yükle
          </button>
          <button
            onClick={address ? onSettings : onLogin}
            className="secondary-button"
          >
            {address ? "Hesabı yönet" : "Giriş yap"}
          </button>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-white/45">
          Bir fikir, bir video, yeni bir başlangıç.
        </p>
      </div>
      <button
        onClick={onUpload}
        className="mx-4 mb-5 flex w-[calc(100%-2rem)] items-center gap-3 rounded-2xl border border-white/10 bg-gradient-to-r from-monad/15 to-transparent p-4 text-left"
      >
        <Sparkles size={24} className="text-monad-soft" />
        <span className="flex-1">
          <b className="text-sm">İçerik stüdyosu</b>
          <span className="mt-1 block text-[11px] text-white/45">
            Videonu yükle · Yerel AI ile üret
          </span>
        </span>
        <Plus size={17} />
      </button>
      <div className="grid grid-cols-2 border-b border-white/10">
        {(
          [
            ["videos", Grid3X3, "Videolar"],
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
          Videolar yükleniyor…
        </p>
      ) : status === "error" && tab === "videos" ? (
        <p className="p-8 text-center text-sm text-dump">
          Videolar alınamadı. Profili yeniden açmayı dene.
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
              ? "İlk videon burada başlıyor"
              : "İlhamını burada biriktir"}
          </p>
          <p className="mt-2 text-xs leading-5 text-white/40">
            {tab === "videos"
              ? "Videonu yükle, açıklamanı ekle ve akışta paylaş."
              : "Akıştaki kaydet simgesine dokun. Kaydettiklerin bu tarayıcıda saklanır."}
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
      setError("En fazla 50 MB boyutunda bir MP4 video seç.");
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
        throw Error((await ticket.json()).error || "Yükleme başarısız.");
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
            throw Error("Video depolamaya yüklenemedi.");
          });
        } else {
          const put = await fetch(uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": "video/mp4" },
            body: file,
          });
          if (!put.ok) throw Error("Video depolamaya yüklenemedi.");
        }
        response = await json({ action: "complete", id, caption });
      } else {
        const body = new FormData();
        body.set("video", file);
        body.set("caption", caption);
        response = await fetch("/api/uploads", { method: "POST", body });
      }
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Yükleme başarısız.");
      onPublished(data.video);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bağlantı kurulamadı.");
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
        <h1 className="font-semibold">İçerik stüdyosu</h1>
        <span className="w-9" />
      </header>
      <div className="px-5">
        <p className="eyebrow">SIRA SENDE</p>
        <h2 className="mt-2 text-3xl font-bold tracking-tight">
          Fikrini akışa taşı.
        </h2>
        <div className="my-6 grid grid-cols-2 rounded-xl bg-white/5 p-1">
          <button
            onClick={() => setMode("upload")}
            className={`rounded-lg py-2.5 text-xs font-semibold ${mode === "upload" ? "bg-white text-black" : "text-white/50"}`}
          >
            Video yükle
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
              aria-label="Video dosyası"
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
                  Videoyu değiştir
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
                <b className="text-sm">Yüklemek için video seç</b>
                <span className="mt-2 text-xs text-white/40">
                  veya dosyanı buraya sürükle
                </span>
                <span className="mt-5 text-[10px] text-white/30">
                  MP4 · En fazla 50 MB · Dikey video önerilir
                </span>
              </button>
            )}
            <label className="mt-6 block text-xs font-semibold">
              Açıklama
              <textarea
                disabled={busy}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                maxLength={300}
                placeholder="Videonun hikâyesini anlat… #alphascroll"
                rows={3}
                className="mt-2 w-full resize-none rounded-xl border border-white/10 bg-white/5 p-3 text-sm font-normal outline-none focus:border-white/30"
              />
            </label>
            <p className="text-right text-[10px] text-white/35">
              {caption.length}/300
            </p>
            <p className="my-4 text-xs leading-5 text-white/40">
              Paylaştığın video profilinde ve herkesin görebildiği ana akışta
              görünür.
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
                ? "Yükleniyor…"
                : address
                  ? "Paylaş"
                  : "Paylaşmak için giriş yap"}
            </button>
          </>
        ) : (
          <div className="rounded-2xl border border-monad/25 bg-monad/5 p-5">
            <Sparkles className="mb-4 text-monad-soft" size={30} />
            <h3 className="text-lg font-bold">
              Yerel üretim, senin kontrolünde.
            </h3>
            <p className="mt-3 text-sm leading-6 text-white/55">
              Ollama senaryoyu ve görsel istemini yazar. Video işçisi bunları
              ses, görsel ve altyazıyla birleştirip MP4 oluşturur.
            </p>
            <div className="my-5 space-y-3 text-xs text-white/65">
              <p>01 / Ollama’da bir metin modeli çalıştır.</p>
              <p>02 / Video işçisinde modelini yapılandır.</p>
              <p>03 / Oluşturulan video otomatik olarak akışa gelir.</p>
            </div>
            <p className="rounded-xl bg-black/30 p-3 text-xs leading-5 text-white/45">
              Bu ekran üretim başlatmaz. Yerel işçi bağlantısı hazır; model
              kurulumu ve çalıştırma adımları proje README dosyasında. Ses ve
              görsel servisleri internet kullanabilir.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
