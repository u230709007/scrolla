"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Send } from "lucide-react";
import { useState } from "react";
import { shortAddr, timeAgo } from "@/lib/format";
import type { Comment, FeedVideo } from "@/lib/types";
import { useToast } from "../Toast";
import { Sheet } from "./Sheet";

export function CommentsSheet({
  open,
  video,
  address,
  onClose,
  onRequestLogin,
  onPosted,
}: {
  open: boolean;
  video: FeedVideo | null;
  address: string | null;
  onClose: () => void;
  onRequestLogin: () => void;
  onPosted: (videoId: string) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const key = ["comments", video?.id];

  const { data, isLoading } = useQuery({
    queryKey: key,
    enabled: open && !!video,
    queryFn: async () => {
      const res = await fetch(`/api/videos/${video!.id}/comments`);
      return ((await res.json()) as { comments: Comment[] }).comments;
    },
  });

  const post = useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch(`/api/videos/${video!.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not post comment");
      return json.comment as Comment;
    },
    onSuccess: (comment) => {
      qc.setQueryData<Comment[]>(key, (old) => [comment, ...(old ?? [])]);
      setText("");
      onPosted(video!.id);
    },
    onError: (err) => toast.show({ kind: "error", title: err.message }),
  });

  return (
    <Sheet open={open && !!video} onClose={onClose} title={commentsTitle(data?.length ?? video?.comments ?? 0)}>
      <div className="flex h-full flex-col">
        <ul className="flex-1 space-y-4 pb-4">
          {isLoading && <Loader2 className="mx-auto mt-8 size-6 animate-spin text-white/40" />}
          {data?.length === 0 && <p className="mt-10 text-center text-sm text-white/50">No comments yet. Drop your alpha 👇</p>}
          {data?.map((c) => (
            <li key={c.id} className="flex gap-3">
              <div
                className="size-8 shrink-0 rounded-full"
                style={{ background: `linear-gradient(135deg, #${c.address.slice(2, 8)}, #${c.address.slice(-6)})` }}
              />
              <div className="min-w-0">
                <p className="text-xs text-white/50">
                  {shortAddr(c.address)} · {timeAgo(c.createdAt)}
                </p>
                <p className="break-words text-sm">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="sticky bottom-0 -mx-5 border-t border-white/10 bg-panel px-5 pt-3">
          {address ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) post.mutate(text);
              }}
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={280}
                placeholder="Add a comment…"
                className="min-w-0 flex-1 rounded-full bg-white/10 px-4 py-2.5 text-sm outline-none placeholder:text-white/40 focus:ring-2 focus:ring-monad"
              />
              <button
                type="submit"
                disabled={!text.trim() || post.isPending}
                aria-label="Post comment"
                className="grid size-10 place-items-center rounded-full bg-monad disabled:opacity-40"
              >
                {post.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              </button>
            </form>
          ) : (
            <button onClick={onRequestLogin} className="w-full rounded-full bg-white/10 py-2.5 text-sm font-semibold">
              Connect wallet to comment
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

const commentsTitle = (n: number) => `${n} ${n === 1 ? "comment" : "comments"}`;
