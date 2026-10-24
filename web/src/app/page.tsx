import { AlphaScrollApp } from "@/components/AlphaScrollApp";
import { PhoneFrame } from "@/components/PhoneFrame";

export default function Home() {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden sm:p-4">
      {/* Ambient glow behind the device (desktop) */}
      <div aria-hidden className="pointer-events-none absolute inset-0 hidden sm:block">
        <div className="absolute left-1/2 top-1/2 size-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-monad/25 blur-[140px]" />
        <div className="absolute -left-32 bottom-0 size-[420px] rounded-full bg-pump/10 blur-[120px]" />
        <div className="absolute -right-24 top-0 size-[380px] rounded-full bg-dump/10 blur-[120px]" />
      </div>

      <aside className="absolute left-10 top-1/2 hidden max-w-xs -translate-y-1/2 xl:block">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-monad-soft">AlphaScroll</p>
        <h1 className="mt-3 text-4xl font-black leading-tight">
          AI reels for <span className="text-pump">Monad</span> degens.
        </h1>
        <p className="mt-4 text-white/60">
          An autonomous agent watches the market and turns the hottest tokens into short videos. Scroll the alpha,
          double-tap to ape in.
        </p>
      </aside>

      <PhoneFrame>
        <AlphaScrollApp />
      </PhoneFrame>

      <p className="absolute bottom-3 hidden text-xs text-white/40 sm:block">
        AI-generated content · Not financial advice
      </p>
    </main>
  );
}
