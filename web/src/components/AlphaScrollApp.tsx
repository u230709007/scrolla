"use client";

import { Loader2 } from "lucide-react";
import { useSession } from "next-auth/react";
import { useState } from "react";
import { Feed } from "./feed/Feed";
import { LoginScreen } from "./LoginScreen";

export function AlphaScrollApp() {
  const { data: session, status } = useSession();
  const [guest, setGuest] = useState(false);
  const address = session?.address ?? null;

  if (status === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-ink">
        <Loader2 className="size-8 animate-spin text-monad" />
      </div>
    );
  }
  if (!address && !guest) return <LoginScreen onGuest={() => setGuest(true)} />;
  return <Feed address={address} onRequestLogin={() => setGuest(false)} />;
}
