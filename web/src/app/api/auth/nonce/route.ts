import { cookies } from "next/headers";
import { generateSiweNonce } from "viem/siwe";
import { NONCE_COOKIE } from "@/auth";

/** Issues a single-use SIWE nonce, bound to this browser via an httpOnly cookie. */
export async function GET() {
  const nonce = generateSiweNonce();
  (await cookies()).set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 5 * 60,
  });
  return Response.json({ nonce }, { headers: { "Cache-Control": "no-store" } });
}
