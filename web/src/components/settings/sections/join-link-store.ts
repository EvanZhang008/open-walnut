/**
 * Settings > Remote Hosts, Join with a link: the link that still waits, kept for the browser
 * session so it outlives the pane (review: after leaving Remote Hosts and coming back, "Link still
 * works for N min" and its Cancel link were gone, the live link could no longer be called back, and
 * Join with a link made a second one). Only its id and end are kept, never the link itself: the
 * pane reads the link back from the server (`fetchNetInvite`) when it opens. Pure on a storage, so
 * it is tested without a DOM.
 */
export const JOIN_LINK_KEY = 'walnut.remote-hosts.join-link';

interface StoreLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

function store(): StoreLike | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

/** The link to keep (one that still waits), or none: a link that ended, joined or was called back is put away. */
export function keepJoinLink(link: { id: string; expiresAt: number } | null, s: StoreLike | null = store()): void {
  if (!s) return;
  try {
    if (link) s.setItem(JOIN_LINK_KEY, JSON.stringify({ id: link.id, expiresAt: link.expiresAt }));
    else s.removeItem(JOIN_LINK_KEY);
  } catch { /* a full or blocked storage keeps nothing; the link on screen is unchanged */ }
}

/** The kept link still within its time, else none (and an ended one is dropped). */
export function keptJoinLink(now = Date.now(), s: StoreLike | null = store()): { id: string; expiresAt: number } | null {
  if (!s) return null;
  let raw: unknown;
  try { raw = JSON.parse(s.getItem(JOIN_LINK_KEY) ?? 'null'); } catch { raw = null; }
  const k = raw as { id?: unknown; expiresAt?: unknown } | null;
  if (!k || typeof k.id !== 'string' || !k.id || typeof k.expiresAt !== 'number') {
    if (raw !== null) keepJoinLink(null, s);
    return null;
  }
  if (now > k.expiresAt) { keepJoinLink(null, s); return null; }
  return { id: k.id, expiresAt: k.expiresAt };
}
