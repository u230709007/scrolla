"use client";

import confetti from "canvas-confetti";
import { useCallback, useEffect, useRef } from "react";

const COLORS = ["#836ef9", "#39ff88", "#ffd84d", "#ff3b6b", "#ffffff"];
// canvas-confetti counts frames, not time: on a slow device (e.g. 7 fps while
// decoding video) 220 ticks would hang on screen for half a minute.
const MAX_DURATION_MS = 4500;

/** Big multi-burst confetti on a canvas confined to the phone screen. */
export function useConfetti() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fireRef = useRef<confetti.CreateTypes | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!canvasRef.current) return;
    // useWorker: false — transferring the canvas twice (React strict mode) throws.
    const instance = confetti.create(canvasRef.current, { resize: true, useWorker: false });
    fireRef.current = instance;
    return () => {
      clearTimeout(clearTimer.current);
      instance.reset();
      fireRef.current = null;
    };
  }, []);

  const fire = useCallback(() => {
    const shoot = fireRef.current;
    if (!shoot) return;
    const base = { colors: COLORS, ticks: 220, gravity: 0.9, scalar: 1.1, disableForReducedMotion: true };
    shoot({ ...base, particleCount: 160, spread: 100, startVelocity: 55, origin: { x: 0.5, y: 0.6 } });
    shoot({ ...base, particleCount: 80, angle: 60, spread: 70, startVelocity: 65, origin: { x: 0, y: 0.8 } });
    shoot({ ...base, particleCount: 80, angle: 120, spread: 70, startVelocity: 65, origin: { x: 1, y: 0.8 } });
    setTimeout(() => shoot({ ...base, particleCount: 120, spread: 160, startVelocity: 35, origin: { x: 0.5, y: 0.35 }, shapes: ["star"] }), 250);
    clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => shoot.reset(), MAX_DURATION_MS);
  }, []);

  return { canvasRef, fire };
}
