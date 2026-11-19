/**
 * How full a host's journal for this Walnut got while this Mac was away, from the `fill`
 * a drain reply carries (`offline.drain`: `{records, max, peak, refused}`, peak and refused
 * counted since the host's last report; absent from an older daemon).
 *
 * A host that refused writes because its journal was full, or held 80% of what it may hold,
 * raises ONE Walnut Health item per host (`offline-journal:<host>`): what happened, and that
 * while the journal is full a session's or a plugin job's writes there wait for the Mac. It is
 * Walnut's to look into, never the person's (no needsYou: notifications/audience.ts sends it
 * to Walnut Health). A later drain that finds the journal below the mark with nothing refused
 * recovers it.
 *
 * Never blocks the drain: offline-handover.ts calls this without waiting, and nothing here
 * throws. The handover hands over the fill of all its rounds at once (mergeJournalFill).
 */

import { log } from '../../logging/index.js';

export interface JournalFill { records: number; max: number; peak: number; refused: number }

/** Share of the journal's room at which the host's peak is worth a look. */
export const JOURNAL_FILL_WARN = 0.8;

/** Last condition told per host this process ('raised' or 'clear'); unknown after a restart. */
const told = new Map<string, 'raised' | 'clear'>();

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** The fill a drain reply carries, or null (an older daemon, a malformed answer). */
export function readJournalFill(raw: unknown): JournalFill | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const records = num(r.records), max = num(r.max), peak = num(r.peak), refused = num(r.refused);
  if (records === null || max === null || peak === null || refused === null || max <= 0) return null;
  return { records, max, peak, refused };
}

/** The fill of one handover's rounds together: the highest peak, every refusal, the newest count. */
export function mergeJournalFill(a: JournalFill | null, b: JournalFill | null): JournalFill | null {
  if (!a || !b) return a ?? b;
  return { records: b.records, max: b.max, peak: Math.max(a.peak, b.peak), refused: a.refused + b.refused };
}

export function journalFillKey(hostKey: string): string {
  return `offline-journal:${hostKey}`;
}

/** Whether this fill is worth the item. */
export function journalFillHigh(f: JournalFill): boolean {
  return f.refused > 0 || f.peak >= JOURNAL_FILL_WARN * f.max;
}

/** The item for a host whose journal came near full or refused writes. */
export function journalFillCard(hostKey: string, f: JournalFill): import('../notifications/store.js').NewNotification {
  const host = hostKey === '__local__' ? 'This computer' : hostKey;
  const pct = Math.min(100, Math.round((f.peak / f.max) * 100));
  const refusedText = f.refused > 0 ? ` and refused ${f.refused} write${f.refused === 1 ? '' : 's'} because it was full` : '';
  return {
    kind: 'operation-error',
    severity: 'warning',
    title: f.refused > 0
      ? `${host} refused ${f.refused} write${f.refused === 1 ? '' : 's'} while the Mac was away: its journal was full`
      : `${host}'s journal for this Walnut came near full while the Mac was away`,
    body: `While the Mac was away, ${host} kept up to ${f.peak} of the ${f.max} records its journal holds for this Walnut (${pct}%)${refusedText}. `
      + 'While the journal is full, a session\'s or a plugin job\'s writes there wait for the Mac. '
      + 'The Mac has taken the journal now; this clears after a drain that finds it below 80% with nothing refused.',
    detail: `offline.drain fill: ${JSON.stringify(f)}`,
    dedupKey: journalFillKey(hostKey),
    recoveryKey: journalFillKey(hostKey),
    category: 'Sessions',
    host: hostKey,
  };
}

/** Raise or recover the host's item for this fill. Never throws; never awaited by the drain. */
export async function noteJournalFill(hostKey: string, fill: JournalFill | null): Promise<void> {
  if (!fill) return;
  try {
    const [{ upsertNotification, recoverNotifications }, { bus }] = await Promise.all([
      import('../notifications/store.js'), import('../event-bus.js'),
    ]);
    const source = { source: 'offline-handover' };
    if (journalFillHigh(fill)) {
      const { record, outcome } = await upsertNotification(journalFillCard(hostKey, fill));
      told.set(hostKey, 'raised');
      if (outcome !== 'suppressed') bus.emit(outcome === 'inserted' ? 'notification:new' : 'notification:updated', record, ['web-ui'], source);
      log.session.warn('offline handover: a host journal came near full or refused writes while this Mac was away', { host: hostKey, ...fill });
      return;
    }
    // A clear report after one already told clear costs nothing (recoverNotifications reads the store).
    if (told.get(hostKey) === 'clear') return;
    const { recovered } = await recoverNotifications([journalFillKey(hostKey)]);
    told.set(hostKey, 'clear');
    for (const record of recovered) bus.emit('notification:updated', record, ['web-ui'], source);
  } catch (err) {
    log.session.warn('offline handover: the journal fill item could not be written', { host: hostKey, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Tests only. */
export function _resetJournalFillForTesting(): void {
  told.clear();
}
