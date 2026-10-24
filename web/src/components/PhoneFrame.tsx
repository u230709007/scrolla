import { BatteryFull, Signal, Wifi } from "lucide-react";
import { ToastOutlet } from "./Toast";

/**
 * iPhone-style mockup on desktop (max-w-[400px], h-[850px], rounded-[40px]).
 * On real phones it drops the bezel and fills the screen.
 */
export function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative h-dvh w-full overflow-hidden bg-black sm:h-[850px] sm:max-h-[calc(100dvh-2rem)] sm:max-w-[400px] sm:rounded-[40px] sm:shadow-2xl sm:ring-[10px] sm:ring-[#1b1626] sm:outline sm:outline-1 sm:outline-white/10">
      {/* Status bar + Dynamic Island (desktop mockup only) */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-50 hidden h-11 items-center justify-between px-7 text-[13px] font-semibold sm:flex">
        <span>9:41</span>
        <div className="absolute left-1/2 top-2.5 h-[26px] w-[104px] -translate-x-1/2 rounded-full bg-black" />
        <span className="flex items-center gap-1.5">
          <Signal className="size-3.5" strokeWidth={2.5} />
          <Wifi className="size-3.5" strokeWidth={2.5} />
          <BatteryFull className="size-4" strokeWidth={2} />
        </span>
      </div>

      <div className="relative h-full w-full">{children}</div>

      <ToastOutlet />

      {/* Home indicator */}
      <div className="pointer-events-none absolute bottom-2 left-1/2 z-50 hidden h-[5px] w-32 -translate-x-1/2 rounded-full bg-white/70 sm:block" />
    </div>
  );
}
