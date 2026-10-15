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
 * as the server kept refusing. The value last mirrored is kept in `localStorage` too, so a page load
 * does not re-send what the server already has (a load wrote it every time); it is re-sent once a day
 * all the same, in case the server lost its copy.
 *
 * `v2` because the v1 key stored a bare string and defaulted OFF; it is deleted once, on first read.
 */
import { afterFirstScreen } from '@/utils/after-first-screen';
import { useSyncExternalStore } from 'react';
import { setMailGroupedPref } from '@/api/mail-groups';
import { log } from '@/utils/log';

export const GROUPED_PREF_KEY = 'walnut.mail.grouped.v2';
const LEGACY_KEY = 'walnut.mail.grouped.v1';

let version = 0;
const listeners = new Set<() => void>();
let legacyCleared = false;
/** The value last sent to the server, so a re-read does not re-send it (undefined: not read yet). */
let mirrored: boolean | null | undefined;
/** Where this browser keeps what it last told the server, and when. Not a synced UI pref. */
export const GROUPED_MIRRORED_KEY = 'walnut.mail.grouped.mirrored';
const MIRROR_REFRESH_MS = 24 * 60 * 60_000;

function readMirrored(): boolean | null {
  try {
    const raw = window.localStorage.getItem(GROUPED_MIRRORED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { on?: unknown; at?: unknown };
    if (typeof parsed.on !== 'boolean' || typeof parsed.at !== 'number') return null;
    return Date.now() - parsed.at < MIRROR_REFRESH_MS ? parsed.on : null;
  } catch {
    return null;
  }
}

function rememberMirrored(on: boolean): void {
  try { window.localStorage.setItem(GROUPED_MIRRORED_KEY, JSON.stringify({ on, at: Date.now() })); } catch { /* kept in memory */ }
}
/** The value and time of the last failed mirror write. */
let failed: { on: boolean; at: number } | null = null;
const MIRROR_RETRY_MS = 60_000;

function clearLegacyOnce(): void {
  if (legacyCleared) return;
  legacyCleared = true;
  try { window.localStorage.removeItem(LEGACY_KEY); } catch { /* nothing to clear */ }
}

function mirror(on: boolean): void {
  if (mirrored === undefined) mirrored = readMirrored();
  if (mirrored === on) return;
  if (failed && failed.on === on && Date.now() - failed.at < MIRROR_RETRY_MS) return;
  mirrored = on;
  // A phone sends it after its first screen, never from behind the sign-in page (N2-35).
  afterFirstScreen(() => sendMirror(on));
}

function sendMirror(on: boolean): void {
  if (mirrored !== on) return;
  void setMailGroupedPref(on).then(
    () => { failed = null; rememberMirrored(on); },
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

/**
 * Test seam: forget what was mirrored and whether the legacy key was cleared. `fromStorage` starts
 * like a fresh page load, which reads what this browser last mirrored.
 */
export function resetGroupedPrefForTests(opts: { fromStorage?: boolean } = {}): void {
  legacyCleared = false;
  mirrored = opts.fromStorage ? undefined : null;
  failed = null;
}
