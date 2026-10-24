"use client";

import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";

/** TikTok-style bottom sheet: slides up, drag down or tap outside to close. */
export function Sheet({
  open,
  onClose,
  title,
  height = "70%",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  height?: string;
  children: React.ReactNode;
}) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            className="absolute inset-0 z-[60] bg-black/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            key="sheet"
            role="dialog"
            aria-label={typeof title === "string" ? title : undefined}
            className="absolute inset-x-0 bottom-0 z-[61] flex flex-col rounded-t-3xl border-t border-white/10 bg-panel shadow-2xl"
            style={{ height }}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 320 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 120 || info.velocity.y > 600) onClose();
            }}
          >
            <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-white/25" />
            <div className="flex items-center justify-between px-5 pb-2 pt-3">
              <h2 className="text-base font-bold">{title}</h2>
              <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-white/60 hover:bg-white/10">
                <X className="size-5" />
              </button>
            </div>
            {/* Stop drag from hijacking scroll inside the body */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8" onPointerDownCapture={(e) => e.stopPropagation()}>
              {children}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
