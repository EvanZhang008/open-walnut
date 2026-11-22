/**
 * Where a mail account's password may go, and which addresses a calendar server may send
 * Walnut to.
 *
 * - The password goes only to the origin a request started at, or to another host of the same
 *   registrable domain (caldav.icloud.com hands every account to its own pNN-caldav.icloud.com).
 * - A redirect never leads to this machine or the local network (loopback, link-local, private
 *   and carrier ranges) unless the request itself started there: a server must not be able to
 *   point Walnut's own requests at Walnut's API or at a router.
 */
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { getDomain } from 'tldts';

export type LookupAll = (hostname: string) => Promise<Array<{ address: string }>>;

const LOOKUP_TIMEOUT_MS = 3_000;

function bare(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

function v4Private(bytes: number[]): boolean {
  const [a, b] = bytes;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function v4Bytes(ip: string): number[] {
  return ip.split('.').map(Number);
}

/** The 16 bytes of an IPv6 literal (net.isIP already said it is one), a trailing dotted quad included. */
function v6Bytes(ip: string): number[] {
  let text = ip;
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  let tail: number[] = [];
  if (quad) {
    tail = v4Bytes(quad[1]);
    text = text.slice(0, -quad[1].length).replace(/:$/, ':0');
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined];
  const groups = (g: string | undefined) => (g ? g.split(':').filter(Boolean).map((x) => parseInt(x, 16)) : []);
  const front = groups(head);
  const back = groups(rest);
  const want = (quad ? 7 : 8) - front.length - back.length;
  const all = [...front, ...(rest !== undefined ? new Array(Math.max(0, want)).fill(0) : []), ...back];
  const bytes = all.flatMap((g) => [(g >> 8) & 0xff, g & 0xff]);
  if (quad) bytes.splice(bytes.length - 2, 2, ...tail);
  return bytes.slice(0, 16);
}

/**
 * An address of this machine or the local network. IP literals are parsed (node:net) and the
 * address itself is judged, so every spelling of one address answers the same: IPv4-mapped
 * (::ffff:7f00:1), IPv4-compatible (::127.0.0.1), NAT64 (64:ff9b::/96), dotted or hex.
 */
export function isPrivateAddress(hostname: string): boolean {
  const h = bare(hostname);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const kind = isIP(h);
  if (kind === 4) return v4Private(v4Bytes(h));
  if (kind !== 6) return false;
  const b = v6Bytes(h);
  const zeros = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (zeros(16) || (zeros(15) && b[15] === 1)) return true; // :: and ::1
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return v4Private(b.slice(12)); // IPv4-mapped
  if (zeros(12)) return true; // IPv4-compatible (::a.b.c.d, deprecated): no public host is reached that way
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return v4Private(b.slice(12)); // NAT64
  return (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) || (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0); // ULA, link-local, site-local
}

export function isLoopbackHost(hostname: string): boolean {
  const h = bare(hostname);
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

/**
 * The registrable domain of a host (icloud.com for p34-caldav.icloud.com); the host itself for an
 * address. Shared hosting suffixes count as public ones (allowPrivateDomains): two tenants of
 * duckdns.org or github.io are two sites.
 */
export function registrableDomain(hostname: string): string {
  const h = bare(hostname);
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

export function sameSite(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && registrableDomain(a.hostname) === registrableDomain(b.hostname);
}

/**
 * Whether a host name resolves to an address of this machine or the local network. A lookup
 * that fails or takes too long answers false: the request that follows fails on its own.
 */
export async function resolvesPrivate(hostname: string, lookup?: LookupAll): Promise<boolean> {
  if (isPrivateAddress(hostname)) return true;
  if (isIP(bare(hostname))) return false;
  const find = lookup ?? ((name: string) => dns.lookup(name, { all: true }));
  let timer: NodeJS.Timeout | undefined;
  try {
    const found = await Promise.race([
      find(bare(hostname)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('lookup timeout')), LOOKUP_TIMEOUT_MS); timer.unref?.(); }),
    ]);
    return found.some((a) => isPrivateAddress(a.address));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
