/**
 * The Grouped / All mail switch: ONE global preference, default on.
 *
 * In `localStorage` like `mail-unread-filter.ts`, and for the same reasons: it is how a person reads
 * their own mail, it must survive a reload, and it has to be readable from outside React (the actions
 * layer, the badge source). Every access is guarded: `localStorage` throws in some private windows.
 *
 * The server keeps a mirror (`PUT /groups/pref`), because the digest and Inbox Triage run with no
 * browser open and have to know whether grouping is on. The mirror is fire and forget: the switch on
 * screen never waits on it. A failed write is retried on the next change, or on a read a minute
 * later: every render reads the switch, so retrying on every read was a request per render for as long
 * as the server kept refusing.
 *
 * `v2` because the v1 key stored a bare string and defaulted OFF; it is deleted once, on first read.
 */
import { useSyncExternalStore } from 'react';
import { setMailGroupedPref } from '@/api/mail-groups';
import { log } from '@/utils/log';

export const GROUPED_PREF_KEY = 'walnut.mail.grouped.v2';
const LEGACY_KEY = 'walnut.mail.grouped.v1';

let version = 0;
const listeners = new Set<() => void>();
let legacyCleared = false;
/** The value last sent to the server, so a re-read does not re-send it. */
let mirrored: boolean | null = null;
/** The value and time of the last failed mirror write. */
let failed: { on: boolean; at: number } | null = null;
const MIRROR_RETRY_MS = 60_000;

function clearLegacyOnce(): void {
  if (legacyCleared) return;
  legacyCleared = true;
  try { window.localStorage.removeItem(LEGACY_KEY); } catch { /* nothing to clear */ }
}

function mirror(on: boolean): void {
  if (mirrored === on) return;
  if (failed && failed.on === on && Date.now() - failed.at < MIRROR_RETRY_MS) return;
  mirrored = on;
  void setMailGroupedPref(on).then(
    () => { failed = null; },
    (error: unknown) => {
      mirrored = null;
      failed = { on, at: Date.now() };
      log.warn('mail', 'grouped preference mirror failed', { error: String(error) });
    },
  );
}

/** Default true; anything unreadable reads as the default. */
export function readGroupedPref(): boolean {
  clearLegacyOnce();
  let on = true;
  try {
    const raw = window.localStorage.getItem(GROUPED_PREF_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof (parsed as { on?: unknown }).on === 'boolean') {
        on = (parsed as { on: boolean }).on;
      }
    }
  } catch {
    on = true;
  }
  mirror(on);
  return on;
}

export function writeGroupedPref(on: boolean): void {
  clearLegacyOnce();
  try {
    window.localStorage.setItem(GROUPED_PREF_KEY, JSON.stringify({ on }));
  } catch {
    // A preference the browser refuses to keep is still applied to the pane on screen.
  }
  mirror(on);
  version += 1;
  for (const one of listeners) one();
}

export function subscribeGroupedPref(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function groupedPrefVersion(): number {
  return version;
}

/** The switch value for a component; re-renders on every write in this tab. */
export function useGroupedPref(): boolean {
  useSyncExternalStore(subscribeGroupedPref, groupedPrefVersion, groupedPrefVersion);
  return readGroupedPref();
}

/** Test seam: forget what was mirrored and whether the legacy key was cleared. */
export function resetGroupedPrefForTests(): void {
  legacyCleared = false;
  mirrored = null;
  failed = null;
}
