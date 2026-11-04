/**
 * How old the Overview's cards are, in words (HostFleetGroup.tsx, HostFleetCard.tsx).
 * The page opens on what each host answered last (GET /api/v1/hosts?cached=1, server:
 * src/core/hosts/fleet-refresh.ts) and reads the hosts again only on a press, so every
 * card says when it was read, a read in flight says so on its own card, and a read that
 * failed says why while the older card stays. Pure, so each rule has a unit test
 * (tests/web/host-fleet-read-model.test.ts).
 */
import type { FleetHost } from '@/api/hosts-fleet';

/** "just now", "1 min ago", "12 min ago", "3 h ago", "2 d ago". */
export function readAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** A card with readings (a live read, or a server older than the cache, sends no readAt: read). */
export function isRead(h: FleetHost): boolean {
  return h.readAt !== null;
}

/** Never tried: no reading and no failed read either (a host whose reads only failed has its card). */
function neverTried(h: FleetHost): boolean {
  return h.readAt === null && !h.readError;
}

/**
 * The cards to draw: a host never tried is left out while its first read runs (it lands when
 * that ends). A card the person may be looking at (its Details open) never vanishes on a read.
 */
export function shownHosts(hosts: FleetHost[]): FleetHost[] {
  return hosts.filter((h) => !(neverTried(h) && h.refreshing));
}

/** Hosts never tried and not being read: the page reads each once, on its own. */
export function neverRead(hosts: FleetHost[]): string[] {
  return hosts.filter((h) => neverTried(h) && !h.refreshing).map((h) => h.host);
}

/** A reading older than this is not how the host is now (the server's READING_FRESH_MS). */
export const READ_OLD_MS = 5 * 60_000;

/**
 * A connected host whose last read ended before this link came up: it was read while it was
 * away, so its card holds nothing from now (2026-11-04: a Mac that joined while the Overview was
 * open read "not read yet" and "Not probed yet" until someone pressed Refresh).
 */
function readBeforeItConnected(h: FleetHost): boolean {
  const since = h.connection.connected ? h.connection.since : null;
  return typeof since === 'number' && typeof h.readAt === 'number' && h.readAt < since;
}

/**
 * Hosts to read on their own when the page opens or a host connects: one never tried, one read
 * only before its link came up, and this computer when its card is over READ_OLD_MS old
 * (2026-11-04: the Mac's own card sat 19 minutes old with its sessions as "?"). Reading this
 * computer asks no network, so the page still opens on the cards it has at once; every other host
 * is read on a press (2026-11-03: "fetch when user click").
 */
export function readOnOpen(hosts: FleetHost[], now: number): string[] {
  return hosts.filter((h) => !h.refreshing && (neverTried(h) || readBeforeItConnected(h)
    || (h.local && typeof h.readAt === 'number' && now - h.readAt > READ_OLD_MS))).map((h) => h.host);
}

/** What a read on its own is remembered by: once per host and per link it came up on. */
export function ownReadKey(h: FleetHost): string {
  return `${h.host}\u0000${h.connection.connected ? h.connection.since ?? '' : ''}`;
}

/** When the newest card was read; null with none read (or none that says). */
export function newestRead(hosts: FleetHost[]): number | null {
  let best: number | null = null;
  for (const h of hosts) if (typeof h.readAt === 'number' && (best === null || h.readAt > best)) best = h.readAt;
  return best;
}

/** The small line on a card: its read running, not read yet, or how old it is. */
export function readLabel(h: FleetHost, now: number): string | null {
  if (h.refreshing) return 'Refreshing...';
  if (h.readAt === null) return 'Not read yet';
  if (typeof h.readAt !== 'number') return null;
  return `Read ${readAgo(h.readAt, now)}`;
}

/** Why the last read of a host failed, and how old what the card shows is; null when it did not. */
export function readFailure(h: FleetHost, now: number): string | null {
  if (!h.readError) return null;
  const why = h.readError.replace(/[.\s]*$/, '');
  const shown = typeof h.readAt === 'number' ? ` Showing what it read ${readAgo(h.readAt, now)}.` : '';
  return `Could not read it: ${why}.${shown}`;
}

/** The server ends every host read within 25 s; a page follows one this long at most. */
export const FOLLOW_READ_MS = 60_000;

/**
 * Whether to keep asking while the server says a read runs. The window starts when this page
 * first saw it running (a press here starts it again), so a read another window started, seen
 * late, is followed too; past the window the page stops asking and shows no "Refreshing...",
 * so Refresh is never hidden behind a mark nothing updates any more.
 */
export function followRead(since: number | null, serverRefreshing: boolean, now: number): { since: number | null; poll: boolean } {
  if (!serverRefreshing) return { since: null, poll: false };
  const start = since ?? now;
  return { since: start, poll: now - start < FOLLOW_READ_MS };
}

/** Mark these hosts (every host with none named) as being read, before the server says so. */
export function markRefreshing(hosts: FleetHost[], names: string[] | null): FleetHost[] {
  return hosts.map((h) => (!names || names.includes(h.host) ? { ...h, refreshing: true } : h));
}

/**
 * A card a button answered (Set up answers a live card): it was read just now. Fields the
 * live card lacks (`readAt`, `refreshing`, `readError`) say so instead of going missing.
 */
export function replaceCard(hosts: FleetHost[], card: FleetHost, now: number): FleetHost[] {
  const live: FleetHost = card.readAt === undefined ? { ...card, readAt: now, refreshing: false, readError: null, readFailedAt: null } : card;
  return hosts.map((h) => (h.host === live.host ? live : h));
}
