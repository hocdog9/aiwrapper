import "server-only";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import type { AuthenticatedContext } from "./auth";

export function guestNetworkKey(request: NextRequest): string {
  const secret = process.env.GUEST_LIMIT_SECRET;
  if (!secret || secret.length < 32) throw new Error("Guest protection is not configured.");
  // Trust only the deployment proxy, never arbitrary forwarding headers locally.
  const address = process.env.VERCEL === "1"
    ? request.headers.get("x-vercel-forwarded-for")?.trim()
    : process.env.NODE_ENV !== "production" ? "127.0.0.1" : null;
  if (!address || !isIP(address)) throw new Error("Guest network could not be verified.");
  // Canonicalize IPv6 spellings and group its /64 to limit address rotation.
  let network = address;
  if (isIP(address) === 6) {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const [left, right = ""] = canonical.split("::");
    const head = left ? left.split(":") : [];
    const tail = right ? right.split(":") : [];
    const parts = canonical.includes("::") ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
    network = parts.slice(0, 4).map((part) => part.padStart(4, "0")).join(":");
  }
  return createHmac("sha256", secret).update(network).digest("hex");
}

export async function enforceGuestLimits(request: NextRequest, context: AuthenticatedContext): Promise<"limited" | "unavailable" | null> {
  if (!context.user.is_anonymous) return null;
  try {
    const network = guestNetworkKey(request);
    if (!context.adminClient) return "unavailable";
    const { error } = await context.adminClient.rpc("consume_guest_attempt", { p_network: network });
    if (error) return error.message.includes("GUEST_LIMIT") ? "limited" : "unavailable";
    return null;
  } catch { return "unavailable"; }
}
