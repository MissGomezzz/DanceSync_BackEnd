import { isIP } from "node:net";

/**
 * The address of the client that opened a connection or sent a request.
 *
 * Behind a load balancer or the api-gateway the socket's address is the proxy's,
 * and the client's is in `X-Forwarded-For`: each proxy appends the address it
 * received the request from. A client can put anything in that header, so only
 * the entries added by proxies we trust are believed. With `trustedProxyHops`
 * proxies in front of the service, the client is the entry that many places
 * from the right of `X-Forwarded-For, <socket address>`; anything further left
 * was written by the client and is ignored. With 0 hops the header is ignored.
 *
 * Shared by SEG-3 (block by address) and available for the non-repudiation log.
 */
export function clientAddress(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedProxyHops: number,
): string {
  const socketAddress = normalize(remoteAddress) ?? "unknown";
  if (trustedProxyHops <= 0) return socketAddress;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : (forwardedFor ?? "");
  const chain = [...header.split(",").map((part) => part.trim()).filter(Boolean), socketAddress];
  const index = Math.max(0, chain.length - 1 - trustedProxyHops);
  return normalize(chain[index]) ?? socketAddress;
}

/** "::ffff:10.0.0.7" -> "10.0.0.7"; anything that is not an IP address -> undefined. */
function normalize(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const value = address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  return isIP(value) ? value : undefined;
}
