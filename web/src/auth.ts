import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { cookies } from "next/headers";
import { createPublicClient, getAddress, type Hex, http, verifyMessage } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { registerUser } from "@/lib/server/social";
import { CHAIN, RPC_URL } from "@/lib/web3/chain";

export const NONCE_COOKIE = "alphascroll.siwe-nonce";

declare module "next-auth" {
  interface Session {
    address?: string;
  }
}

const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });

async function verifySignature(address: Hex, message: string, signature: Hex): Promise<boolean> {
  // EOAs verify locally (pure ecrecover, no RPC). Smart-contract wallets
  // (ERC-1271 / ERC-6492) need an on-chain call, so they fall through to it.
  if (await verifyMessage({ address, message, signature }).catch(() => false)) return true;
  return publicClient.verifyMessage({ address, message, signature }).catch(() => false);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: { signIn: "/" },
  providers: [
    Credentials({
      id: "siwe",
      name: "Sign-In with Ethereum",
      credentials: { message: {}, signature: {} },
      async authorize(credentials, request) {
        const message = typeof credentials?.message === "string" ? credentials.message : "";
        const signature = typeof credentials?.signature === "string" ? (credentials.signature as Hex) : null;
        if (!message || !signature) return null;

        const jar = await cookies();
        const nonce = jar.get(NONCE_COOKIE)?.value;
        jar.delete(NONCE_COOKIE); // single use, whatever the outcome

        const fields = parseSiweMessage(message);
        const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? undefined;
        if (!nonce || !fields.address || fields.chainId !== CHAIN.id) return null;
        if (!validateSiweMessage({ message: fields, domain: host, nonce })) return null;
        if (!(await verifySignature(fields.address, message, signature))) return null;

        const address = getAddress(fields.address);
        await registerUser(address).catch(() => undefined); // never block sign-in on this
        return { id: address };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    session({ session, token }) {
      session.address = token.sub;
      return session;
    },
  },
});

// Wallets already upserted into `users` by this server instance.
const seen = new Set<string>();

/** Checksummed address of the signed-in wallet, or null. Also makes sure the
 * wallet is in `users`, so sessions that predate the table still show up. */
export async function currentAddress(): Promise<string | null> {
  const address = (await auth())?.address ?? null;
  if (address && !seen.has(address)) {
    await registerUser(address)
      .then(() => seen.add(address))
      .catch(() => undefined);
  }
  return address;
}
