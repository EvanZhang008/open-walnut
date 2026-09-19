/**
 * One browser, one copy of every session's recap tip.
 *
 * The tip (Overall / Latest above the composer) is read from the session record,
 * but the record is a snapshot: the turn-complete self-report writes new text
 * minutes after the turn and announces it with `session:recap-updated`. That
 * event used to be applied by the one panel that happened to hold the record,
 * and it was lost twice over: an event arriving before the record's first fetch
 * had nowhere to land, and a fetch already in flight when the event arrived
 * replaced the record afterwards with the older copy. So the live text lives
 * here, fed by ONE subscription (initRecapTipStore), and every surface that
 * shows a recap (the session column's tip, the plan popover's composer, the
 * Todo detail row) reads the same merge: per field, the newer of record and
 * event by its `*At` stamp.
 *
 * Dismissals live here too. A dismissal is of a TEXT, not of a moment: the
 * self-report re-stamps `recapAt` on every turn even when it repeats the same
 * wording, and a tip that came back with nothing new to read would make the ×
 * mean "hide until the next turn". The version is a hash of the two texts, kept
 * per session in this browser only.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { wsClient } from '@/api/ws';

export interface RecapTipFields {
  recap?: string;
  recapAt?: string;
  overview?: string;
  overviewAt?: string;
}

/** Device-local by design: a growing map of session ids has no business in the
 *  synced config/share/ui-prefs.json. tests/web/recap-tip-store.test.ts pins the
 *  key against the ui-prefs-sync `syncable` predicate, so a widened allowlist
 *  fails a test instead of quietly mirroring it. */
export const RECAP_DISMISSED_KEY = 'walnut.recap-dismissed';
/** Insertion-ordered; the oldest entries fall off past this. */
const DISMISSED_MAX = 200;

type DismissedMap = Record<string, string>;

/** The tip's identity for dismissal: the two texts, nothing else. */
export function recapTipVersion(fields: Pick<RecapTipFields, 'recap' | 'overview'>): string {
  const text = `${fields.overview ?? ''}\n${fields.recap ?? ''}`;
  // FNV-1a over UTF-16 code units: short, stable, good enough to tell two tips apart.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}:${hash.toString(16)}`;
}

/** Per field, the newer of the record's copy and the live event's copy. A live
 *  copy without a comparable stamp wins: the event is emitted after the write. */
function newer(
  recordText: string | undefined, recordAt: string | undefined,
  liveText: string | undefined, liveAt: string | undefined,
): { text?: string; at?: string } {
  if (!liveText) return { text: recordText, at: recordAt };
  if (!recordText || !recordAt || !liveAt) return { text: liveText, at: liveAt };
  return Date.parse(liveAt) >= Date.parse(recordAt)
    ? { text: liveText, at: liveAt }
    : { text: recordText, at: recordAt };
}

class RecapTipStore {
  private live = new Map<string, RecapTipFields>();
  private dismissedCache: DismissedMap | null = null;
  private listeners = new Set<() => void>();
  /** Bumped on every change; the value useSyncExternalStore compares. */
  private revision = 0;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  getRevision = (): number => this.revision;

  private bump(): void {
    this.revision++;
    for (const fn of this.listeners) fn();
  }

  /** `session:recap-updated` payload → live copy. Fields absent from the event
   *  keep whatever the previous event carried. */
  ingestEvent(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as { sessionId?: unknown } & Record<string, unknown>;
    if (typeof d.sessionId !== 'string' || !d.sessionId) return;
    const str = (k: string): string | undefined => (typeof d[k] === 'string' && d[k] ? d[k] as string : undefined);
    const next: RecapTipFields = { ...this.live.get(d.sessionId) };
    const recap = str('recap');
    const overview = str('overview');
    if (recap) { next.recap = recap; next.recapAt = str('recapAt'); }
    if (overview) { next.overview = overview; next.overviewAt = str('overviewAt'); }
    if (!recap && !overview) return;
    this.live.set(d.sessionId, next);
    this.bump();
  }

  /** The tip to show for a record: record fields merged with the live copy. */
  resolve(sessionId: string, record: RecapTipFields | null | undefined): RecapTipFields {
    const live = this.live.get(sessionId);
    const r = newer(record?.recap, record?.recapAt, live?.recap, live?.recapAt);
    const o = newer(record?.overview, record?.overviewAt, live?.overview, live?.overviewAt);
    return {
      ...(r.text ? { recap: r.text, recapAt: r.at } : {}),
      ...(o.text ? { overview: o.text, overviewAt: o.at } : {}),
    };
  }

  private readDismissed(): DismissedMap {
    if (this.dismissedCache) return this.dismissedCache;
    try {
      const raw = localStorage.getItem(RECAP_DISMISSED_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      this.dismissedCache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as DismissedMap : {};
    } catch {
      this.dismissedCache = {};
    }
    return this.dismissedCache;
  }

  isDismissed(sessionId: string, version: string): boolean {
    return this.readDismissed()[sessionId] === version;
  }

  dismiss(sessionId: string, version: string): void {
    const current = this.readDismissed();
    const next: DismissedMap = {};
    // Rebuild so this session is the newest entry (object key order is insertion
    // order for string keys, and session ids are never integer-like).
    for (const [k, v] of Object.entries(current)) if (k !== sessionId) next[k] = v;
    next[sessionId] = version;
    const keys = Object.keys(next);
    for (const stale of keys.slice(0, Math.max(0, keys.length - DISMISSED_MAX))) delete next[stale];
    this.dismissedCache = next;
    try { localStorage.setItem(RECAP_DISMISSED_KEY, JSON.stringify(next)); } catch { /* storage unavailable: the choice holds for this page */ }
    this.bump();
  }

  /** Test seam: forget everything in memory (the next read consults storage). */
  reset(): void {
    this.live.clear();
    this.dismissedCache = null;
    this.bump();
  }
}

export const recapTipStore = new RecapTipStore();

let initialized = false;
/** Wire the ONE WS subscription. Called from main.tsx at boot. */
export function initRecapTipStore(): void {
  if (initialized) return;
  initialized = true;
  wsClient.onEvent('session:recap-updated', (data) => recapTipStore.ingestEvent(data));
}

export interface ResolvedRecapTip extends RecapTipFields {
  /** True when the user hid exactly this text. */
  dismissed: boolean;
  /** Hide this text (until the self-report writes different text). */
  dismiss: () => void;
}

/** The tip for a session record, live and with its dismissal state. */
export function useRecapTip(sessionId: string, record: RecapTipFields | null | undefined): ResolvedRecapTip {
  useSyncExternalStore(recapTipStore.subscribe, recapTipStore.getRevision, recapTipStore.getRevision);
  const fields = recapTipStore.resolve(sessionId, record);
  const version = recapTipVersion(fields);
  const dismissed = recapTipStore.isDismissed(sessionId, version);
  const dismiss = useCallback(() => recapTipStore.dismiss(sessionId, version), [sessionId, version]);
  return useMemo(
    () => ({ ...fields, dismissed, dismiss }),
    // fields is rebuilt per render; its parts are the real inputs.
    [fields.recap, fields.recapAt, fields.overview, fields.overviewAt, dismissed, dismiss],
  );
}
