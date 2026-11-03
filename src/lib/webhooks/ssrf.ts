// ============================================================
// SSRF guard for outbound webhook delivery.
//
// A webhook URL is attacker-influenced (any account admin with
// `webhooks:manage` can register one) and our server makes the request,
// so an unguarded fetch is a Server-Side Request Forgery primitive: a
// URL pointing at `127.0.0.1`, a cloud metadata IP (`169.254.169.254`),
// or an RFC1918 host would let a caller probe / POST to internal
// services from the app's network.
//
// `isDeliverableUrl` resolves the host and rejects any address that is
// loopback, private, link-local, ULA, or otherwise non-publicly-
// routable. Combined with `redirect: 'manual'` at the call site (so a
// public URL can't 3xx-bounce to an internal one), this blocks the
// common SSRF vectors. It is NOT a defense against DNS rebinding (a
// host that resolves public here but flips to private before connect) —
// that needs pinning the resolved IP into the socket, which fetch
// doesn't expose; documented as a residual risk.
// ============================================================

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * The eight 16-bit groups of an IPv6 address, or null if it does not
 * parse. Accepts `::` compression and a dotted IPv4 tail
 * (`::ffff:127.0.0.1`). A zone id (`fe80::1%eth0`) is dropped.
 */
function ipv6Groups(input: string): number[] | null {
  let ip = input
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '');
  const dotted = ip.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const o = dotted.slice(2).map(Number);
    if (o.some((n) => n > 255)) return null;
    ip = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [
    ...head,
    ...Array(halves.length === 2 ? missing : 0).fill('0'),
    ...tail,
  ];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** The IPv4 address carried in the last 32 bits of IPv6 groups. */
function embeddedV4(g: number[]): string {
  return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
}

/** True for loopback / private / link-local / reserved IPv4 or IPv6. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0) return true; // "this" network
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  const g = ipv6Groups(ip);
  // Not an address we can read: treat as reserved rather than routable.
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // :: unspecified
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  const zero5 = g.slice(0, 5).every((x) => x === 0);
  // IPv4-mapped `::ffff:a.b.c.d` — the URL parser writes it in hex
  // (`[::ffff:7f00:1]`), so the dotted form alone is not enough.
  if (zero5 && g[5] === 0xffff) return isPrivateOrReservedIp(embeddedV4(g));
  // IPv4-compatible `::a.b.c.d` (deprecated, still routed by some stacks;
  // also covers ::1).
  if (zero5 && g[5] === 0) return isPrivateOrReservedIp(embeddedV4(g));
  // NAT64 well-known prefix 64:ff9b::/96 reaches the embedded IPv4.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPrivateOrReservedIp(embeddedV4(g));
  }
  // 64:ff9b:1::/48, local-use NAT64 (RFC 8215): never a public endpoint.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
  return false;
}

/**
 * True if `rawUrl`'s host resolves only to publicly-routable
 * address(es). Returns false for a malformed URL, an obvious internal
 * name (`localhost`, `*.local`, `*.internal`), a literal private IP, or
 * a hostname that resolves to any private/reserved address.
 */
export async function isDeliverableUrl(rawUrl: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  if (isIP(host)) return !isPrivateOrReservedIp(host);

  const lower = host.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return false;
  }

  try {
    const results = await lookup(host, { all: true });
    if (results.length === 0) return false;
    return results.every((r) => !isPrivateOrReservedIp(r.address));
  } catch {
    return false; // unresolvable → not deliverable
  }
}
