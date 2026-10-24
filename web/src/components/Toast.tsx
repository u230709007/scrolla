"use client";

import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

type Kind = "success" | "error" | "info" | "loading";
type Toast = { id: number; kind: Kind; title: string; body?: string; href?: string };
type Api = {
  show: (t: Omit<Toast, "id">, ms?: number) => number;
  update: (id: number, t: Omit<Toast, "id">, ms?: number) => void;
  dismiss: (id: number) => void;
};

// Split so useToast() callers get a stable API and don't re-render on every toast.
const ApiCtx = createContext<Api | null>(null);
const ListCtx = createContext<{ toasts: Toast[]; dismiss: (id: number) => void } | null>(null);
const ICONS = { success: CheckCircle2, error: XCircle, info: Info, loading: Loader2 };
const COLORS = { success: "text-pump", error: "text-dump", info: "text-monad-soft", loading: "text-monad-soft" };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const schedule = useCallback(
    (id: number, kind: Kind, ms?: number) => {
      clearTimeout(timers.current.get(id));
      if (kind !== "loading") timers.current.set(id, setTimeout(() => dismiss(id), ms ?? 3800));
    },
    [dismiss],
  );

  const api = useMemo<Api>(
    () => ({
      show(t, ms) {
        const id = nextId.current++;
        setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
        schedule(id, t.kind, ms);
        return id;
      },
      update(id, t, ms) {
        setToasts((ts) => ts.map((x) => (x.id === id ? { ...t, id } : x)));
        schedule(id, t.kind, ms);
      },
      dismiss,
    }),
    [dismiss, schedule],
  );
  const list = useMemo(() => ({ toasts, dismiss }), [toasts, dismiss]);

  return (
    <ApiCtx.Provider value={api}>
      <ListCtx.Provider value={list}>{children}</ListCtx.Provider>
    </ApiCtx.Provider>
  );
}

/** Renders the toasts. Placed inside the phone screen (PhoneFrame) so they
 * stay within the device; plain markup, so SSR and hydration match. */
export function ToastOutlet() {
  const ctx = useContext(ListCtx);
  if (!ctx) return null;
  const { toasts, dismiss } = ctx;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-12 z-[100] flex flex-col items-center gap-2 px-3">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = ICONS[t.kind];
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: -16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12, scale: 0.96 }}
              onClick={() => dismiss(t.id)}
              className="pointer-events-auto flex w-full max-w-[360px] items-start gap-3 rounded-2xl border border-white/10 bg-panel/90 px-4 py-3 shadow-2xl backdrop-blur-xl"
              role="status"
            >
              <Icon className={`mt-0.5 size-5 shrink-0 ${COLORS[t.kind]} ${t.kind === "loading" ? "animate-spin" : ""}`} />
              <div className="min-w-0 text-sm">
                <p className="font-semibold">{t.title}</p>
                {t.body && <p className="mt-0.5 text-white/70">{t.body}</p>}
                {t.href && (
                  <a href={t.href} target="_blank" rel="noreferrer" className="mt-1 inline-block text-monad-soft underline">
                    View on explorer
                  </a>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

export function useToast(): Api {
  const api = useContext(ApiCtx);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}
