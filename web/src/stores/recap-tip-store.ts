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
 * shows a recap (the "+" menu's Latest update, the Todo detail row) reads the
 * same merge: per field, the newer of record and event by its `*At` stamp.
 * (It was a card above the composer with a × until 2026-10-26; the card and its
 * dismissals are gone, the store keeps its name.)
 */
import { useMemo, useSyncExternalStore } from 'react';
import { wsClient } from '@/api/ws';

export interface RecapTipFields {
  recap?: string;
  recapAt?: string;
  overview?: string;
  overviewAt?: string;
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

  /** Test seam: forget everything in memory. */
  reset(): void {
    this.live.clear();
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
  // The card's dismissals (gone 2026-10-26) left a device-local map behind.
  try { localStorage.removeItem('walnut.recap-dismissed'); } catch { /* storage unavailable */ }
}

/** The recap for a session record, live. */
export function useRecapTip(sessionId: string, record: RecapTipFields | null | undefined): RecapTipFields {
  useSyncExternalStore(recapTipStore.subscribe, recapTipStore.getRevision, recapTipStore.getRevision);
  const fields = recapTipStore.resolve(sessionId, record);
  return useMemo(
    () => fields,
    // fields is rebuilt per render; its parts are the real inputs.
    [fields.recap, fields.recapAt, fields.overview, fields.overviewAt],
  );
}
