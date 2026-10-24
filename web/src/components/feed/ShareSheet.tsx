"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Link2, Loader2, Search, Send, UserCheck, UserPlus } from "lucide-react";
import { useState } from "react";
import { shortAddr, timeAgo } from "@/lib/format";
import type { FeedVideo } from "@/lib/types";
import { useToast } from "../Toast";
import { Sheet } from "./Sheet";

type AppUser = { address: string; following: boolean; followsMe: boolean };
export type InboxItem = {
  kind: "share" | "follow" | "join";
  id: string;
  videoId: string | null;
  from: string;
  seen: boolean;
  following: boolean;
  createdAt: string;
};

const avatar = (a: string) => ({ background: `linear-gradient(135deg, #${a.slice(2, 8)}, #${a.slice(-6)})` });

/** Follow / unfollow a user, then refresh every list that shows follow state. */
function useFollow() {
  const toast = useToast();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ address, follow }: { address: string; follow: boolean }) => {
      const res = await fetch("/api/users/follow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, follow }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't follow");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["follow-stats"] });
    },
    onError: (e) => toast.show({ kind: "error", title: e.message }),
  });
}

function FollowButton({ address, following }: { address: string; following: boolean }) {
  const follow = useFollow();
  return (
    <button
      onClick={() => follow.mutate({ address, follow: !following })}
      disabled={follow.isPending}
      className={`flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold ${following ? "bg-white/10 text-white/80" : "bg-monad"}`}
    >
      {following ? <UserCheck className="size-3.5" /> : <UserPlus className="size-3.5" />}
      {following ? "Following" : "Follow"}
    </button>
  );
}

const relation = (u: AppUser) =>
  u.followsMe ? (u.following ? "Mutual" : "Follows you") : u.following ? "Following" : "Suggested";

/** Share a reel: suggested registered users (follow them, tick, send) + link sharing. */
export function ShareSheet({
  open,
  video,
  address,
  onClose,
  onRequestLogin,
  onCopyLink,
}: {
  open: boolean;
  video: FeedVideo | null;
  address: string | null;
  onClose: () => void;
  onRequestLogin: () => void;
  onCopyLink: (video: FeedVideo) => void;
}) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ["users", q, address],
    enabled: open && !!address,
    queryFn: async () => {
      const res = await fetch(`/api/users?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Couldn't load people");
      return ((await res.json()) as { users: AppUser[] }).users;
    },
  });

  const send = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/videos/${video!.id}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: [...picked] }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; sent?: number };
      if (!res.ok) throw new Error(json.error ?? "Couldn't send");
      return json.sent ?? 0;
    },
    onSuccess: (n) => {
      toast.show({ kind: "success", title: `Sent to ${n} ${n === 1 ? "person" : "people"}` });
      setPicked(new Set());
      onClose();
    },
    onError: (e) => toast.show({ kind: "error", title: e.message }),
  });

  const toggle = (a: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (!next.delete(a)) next.add(a);
      return next;
    });

  return (
    <Sheet open={open && !!video} onClose={onClose} title="Share" height="75%">
      <div className="flex h-full flex-col">
        <button
          onClick={() => video && onCopyLink(video)}
          className="mb-3 flex w-full items-center gap-3 rounded-2xl bg-white/5 p-3 text-sm font-semibold"
        >
          <Link2 className="size-5 text-monad-soft" /> Share or copy link
        </button>

        {!address ? (
          <button onClick={onRequestLogin} className="w-full rounded-2xl bg-monad py-3.5 text-sm font-bold">
            Connect your wallet to send this to friends
          </button>
        ) : (
          <>
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/40" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search address…"
                className="w-full rounded-full bg-white/10 py-2.5 pl-9 pr-4 text-sm outline-none placeholder:text-white/40 focus:ring-2 focus:ring-monad"
              />
            </div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/45">Suggested</p>
            <ul className="flex-1 space-y-1 overflow-y-auto pb-2">
              {isLoading && <Loader2 className="mx-auto mt-6 size-6 animate-spin text-white/40" />}
              {data?.length === 0 && (
                <li className="mt-8 text-center text-sm text-white/50">No other accounts yet.</li>
              )}
              {data?.map((u) => {
                const on = picked.has(u.address);
                return (
                  <li key={u.address} className="flex items-center gap-3 rounded-2xl p-2">
                    <button onClick={() => toggle(u.address)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-pressed={on}>
                      <span className="relative">
                        <span className="block size-10 rounded-full" style={avatar(u.address)} />
                        {on && (
                          <span className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-monad">
                            <Check className="size-3" />
                          </span>
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-sm font-bold">{shortAddr(u.address)}</span>
                        <span className="block text-xs text-white/50">{relation(u)}</span>
                      </span>
                    </button>
                    <FollowButton address={u.address} following={u.following} />
                  </li>
                );
              })}
            </ul>
            <button
              onClick={() => send.mutate()}
              disabled={!picked.size || send.isPending}
              className="sticky bottom-0 flex w-full items-center justify-center gap-2 rounded-full bg-monad py-3 text-sm font-bold disabled:opacity-40"
            >
              {send.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {picked.size ? `Send to ${picked.size}` : "Pick people"}
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** My followers or the people I follow, with follow-back buttons. */
export function PeopleSheet({
  list,
  onClose,
}: {
  list: "followers" | "following" | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["users", "list", list],
    enabled: !!list,
    queryFn: async () => {
      const res = await fetch(`/api/users?list=${list}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Couldn't load people");
      return ((await res.json()) as { users: AppUser[] }).users;
    },
  });
  return (
    <Sheet open={!!list} onClose={onClose} title={list === "following" ? "Following" : "Followers"} height="65%">
      <ul className="space-y-1">
        {isLoading && <Loader2 className="mx-auto mt-6 size-6 animate-spin text-white/40" />}
        {data?.length === 0 && (
          <li className="mt-10 text-center text-sm text-white/50">
            {list === "following" ? "You aren't following anyone yet." : "No followers yet."}
          </li>
        )}
        {data?.map((u) => (
          <li key={u.address} className="flex items-center gap-3 rounded-2xl p-2">
            <span className="size-10 shrink-0 rounded-full" style={avatar(u.address)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-sm font-bold">{shortAddr(u.address)}</span>
              <span className="block text-xs text-white/50">{relation(u)}</span>
            </span>
            <FollowButton address={u.address} following={u.following} />
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

const NOTICE: Record<InboxItem["kind"], string> = {
  share: "sent you a video",
  follow: "started following you",
  join: "joined Scrolla",
};

/** Notifications: reels other users sent me, new followers, newly joined users. */
export function InboxSheet({
  open,
  onClose,
  onOpenVideo,
}: {
  open: boolean;
  onClose: () => void;
  onOpenVideo: (video: FeedVideo) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["inbox"],
    enabled: open,
    queryFn: async () => {
      const res = await fetch("/api/inbox", { cache: "no-store" });
      const json = (await res.json()) as { items: InboxItem[] };
      if (json.items.some((i) => !i.seen)) {
        fetch("/api/inbox", { method: "POST" }).then(() => qc.invalidateQueries({ queryKey: ["inbox-count"] }));
      }
      return json.items;
    },
  });

  async function openItem(item: InboxItem) {
    if (!item.videoId) return;
    const res = await fetch(`/api/videos/${item.videoId}`, { cache: "no-store" });
    if (!res.ok) return toast.show({ kind: "error", title: "This video is gone" });
    onOpenVideo(((await res.json()) as { video: FeedVideo }).video);
  }

  return (
    <Sheet open={open} onClose={onClose} title="Bildirimler" height="65%">
      <ul className="space-y-1">
        {isLoading && <Loader2 className="mx-auto mt-6 size-6 animate-spin text-white/40" />}
        {data?.length === 0 && <li className="mt-10 text-center text-sm text-white/50">No notifications yet.</li>}
        {data?.map((i) => (
          <li key={i.id} className="flex items-center gap-2 rounded-2xl p-2 hover:bg-white/5">
            <button
              onClick={() => openItem(i)}
              disabled={!i.videoId}
              className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
            >
              <span className="size-10 shrink-0 rounded-full" style={avatar(i.from)} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">
                  <span className="font-mono font-bold">{shortAddr(i.from)}</span> {NOTICE[i.kind]}
                </span>
                <span className="block text-xs text-white/50">{timeAgo(i.createdAt)} ago</span>
              </span>
              {!i.seen && <span className="size-2 shrink-0 rounded-full bg-monad" />}
            </button>
            {i.kind !== "share" && <FollowButton address={i.from} following={i.following} />}
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
