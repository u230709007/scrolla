import type { Chain } from "viem";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { CHAIN, RPC_URL } from "./chain";

/** Injected wallets only, MetaMask first (Rabby, Phantom, Backpack… also
 * work): no WalletConnect project id or other third-party key needed. */
export const wagmiConfig = createConfig({
  // Widen to Chain: CHAIN is picked at build time from NEXT_PUBLIC_CHAIN_ID.
  chains: [CHAIN as Chain],
  connectors: [injected({ target: "metaMask" }), injected()],
  transports: { [CHAIN.id]: http(RPC_URL) },
  ssr: true,
});

/** MetaMask if installed (EIP-6963 announcement or window.ethereum.isMetaMask), else any injected wallet. */
export async function preferredConnector() {
  const { connectors } = wagmiConfig;
  const announced = connectors.find((c) => c.id === "io.metamask");
  if (announced) return announced;
  const legacy = connectors.find((c) => c.id === "metaMask");
  if (legacy && (await legacy.getProvider().catch(() => null))) return legacy;
  return connectors.find((c) => c.id === "injected") ?? connectors[0];
}

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
