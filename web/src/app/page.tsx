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

      <PhoneFrame>
        <AlphaScrollApp />
      </PhoneFrame>

      <p className="absolute bottom-3 hidden text-xs text-white/40 sm:block">
        AI-generated content · Not financial advice
      </p>
    </main>
  );
}
