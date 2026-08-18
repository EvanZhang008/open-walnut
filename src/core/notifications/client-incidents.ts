/**
 * Mobile client incident detector — the server half of the iOS flight recorder.
 *
 * The phone uploads its whole structured log to `POST /api/v1/client-logs`,
 * which appends it to `/tmp/open-walnut/ios-client/<device>-<day>.log`. That
 * file is where every field forensic has come from — but only because somebody
 * knew to go grep it. A freeze or crash could sit there for days while the web
 * console showed a perfectly healthy Walnut.
 *
 * This module closes that loop: as lines are ingested, any line from the
 * `freeze` or `crash` subsystem raises a bus event AND a durable notification,
 * so the incident shows up on the bell without anyone grepping.
 *
 * DELIBERATELY NOT A TASK. An automatic task per freeze would flood the task
 * list (one bad afternoon on a phone produces dozens of `main thread recovered`
 * lines) and tasks are the user's own workspace. A notification is dismissible,
 * deduped, and already the channel for "something happened that you may want to
 * look at".
 *
 * Noise control:
 *  - one notification per device per SEVERITY CLASS per 10-minute window, so a
 *    freeze storm collapses into a single entry that names the count;
 *  - `main thread recovered` (a sub-threshold stall — ~10× more frequent, and
 *    by design the better statistical sample) is classed separately from a real
 *    unresponsive-main-thread freeze, so the common case can never bury the
 *    severe one;
 *  - the dedup window is in-memory: a server restart may produce one extra
 *    notification, which is the correct trade against persisting a cache.
 */

import { addNotification } from './store.js';
import { bus, EventNames } from '../event-bus.js';
import { log } from '../../logging/index.js';

/** One notification per device+class per window. */
export const INCIDENT_WINDOW_MS = 10 * 60 * 1000;

/** Subsystems whose lines are incidents. Everything else is just telemetry. */
const INCIDENT_SUBSYSTEMS = new Set(['freeze', 'crash']);

/**
 * Severity classes. A recovered stall must not dedup-suppress a hard freeze or
 * a crash — they are different questions, so they get different keys.
 */
type IncidentClass = 'crash' | 'freeze' | 'stall';

export interface ClientLogLine {
  ts?: unknown;
  level?: unknown;
  subsystem?: unknown;
  message?: unknown;
  /** Meta rides as `m_<key>` (AppLog's wire shape). */
  [key: string]: unknown;
}

/** Recent (device+class) → first-seen timestamp, for the dedup window. */
const recent = new Map<string, { firstAt: number; count: number }>();

function pruneRecent(now: number): void {
  if (recent.size < 200) return;
  for (const [key, entry] of recent) {
    if (now - entry.firstAt > INCIDENT_WINDOW_MS) recent.delete(key);
  }
}

function classify(subsystem: string, message: string): IncidentClass {
  if (subsystem === 'crash') return 'crash';
  // Only `main thread unresponsive` is a VERDICT of "froze". The other two
  // freeze-subsystem messages are sub-threshold evidence:
  //  - `main thread recovered` — a hang that ended,
  //  - `stall sample` — a stack captured while a stall is still BUILDING (past
  //    the 1.5s sampling line, not yet the 5s report line). It may never become
  //    a freeze at all.
  //
  // `stall sample` was added later (build 37 forensics) and fell through to the
  // severe default, so every sample rang the bell as an ERROR titled "iOS app
  // froze". That is how T41 stayed "open" for four rounds: 68 of 72 iOS
  // notifications were `iOS app froze — stall sample` while the device had
  // recorded ZERO `main thread unresponsive` lines. The bell was reporting
  // evidence as a verdict.
  //
  // The fail-loud default is kept for genuinely UNKNOWN freeze messages.
  if (/recovered|stall sample/i.test(message)) return 'stall';
  return 'freeze';
}

const TITLES: Record<IncidentClass, string> = {
  crash: 'iOS app crashed',
  freeze: 'iOS app froze',
  stall: 'iOS app stalled briefly',
};

const SEVERITIES: Record<IncidentClass, 'error' | 'warning'> = {
  crash: 'error',
  freeze: 'error',
  stall: 'warning',
};

/** Meta keys worth putting in the notification body, in display order. */
const BODY_KEYS = [
  'm_stalledSeconds', 'm_hangSeconds', 'm_duration',
  'm_signal', 'm_exceptionType', 'm_terminationReason',
  'm_ctxScreen', 'm_ctxKbFlips10s', 'm_ctxLiveChars', 'm_ctxHistoryRows',
  'm_ctxMemoryMB', 'm_build', 'm_ctxTrail',
] as const;

/** Human-readable label for a `m_`-prefixed meta key. */
function labelFor(key: string): string {
  return key.replace(/^m_/, '').replace(/^ctx/, '');
}

const MAX_BODY = 600;

function buildBody(line: ClientLogLine, device: string, count: number): string {
  const parts: string[] = [device];
  if (count > 1) parts.push(`${count}× in the last 10 min`);
  for (const key of BODY_KEYS) {
    const value = line[key];
    if (typeof value === 'string' && value && value !== '-') {
      parts.push(`${labelFor(key)}=${value}`);
    }
  }
  const body = parts.join(' · ');
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}…` : body;
}

/**
 * Inspect one ingested batch. Returns the notifications actually created (the
 * route logs the count; tests assert on it).
 *
 * Never throws: log ingest must succeed even if the notification store is
 * unwritable — losing the client's log to a bell failure would be strictly
 * worse than losing the bell.
 */
export async function flagClientIncidents(
  device: string,
  lines: ClientLogLine[],
  options: { now?: number; broadcast?: (name: string, data: unknown) => void } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  let created = 0;

  // Newest-relevant-wins per class: a batch can carry several freeze lines and
  // the LAST one has the most complete context (longest stall).
  const perClass = new Map<IncidentClass, ClientLogLine>();
  const counts = new Map<IncidentClass, number>();
  for (const line of lines) {
    const subsystem = typeof line.subsystem === 'string' ? line.subsystem : '';
    if (!INCIDENT_SUBSYSTEMS.has(subsystem)) continue;
    const message = typeof line.message === 'string' ? line.message : '';
    const kind = classify(subsystem, message);
    perClass.set(kind, line);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  if (perClass.size === 0) return 0;

  pruneRecent(now);

  for (const [kind, line] of perClass) {
    const batchCount = counts.get(kind) ?? 1;
    const key = `${device}:${kind}`;
    const seen = recent.get(key);
    // Inside the window: accumulate the count on the existing record's identity
    // (a later batch shouldn't create a second entry) and move on.
    if (seen && now - seen.firstAt < INCIDENT_WINDOW_MS) {
      seen.count += batchCount;
      continue;
    }
    const windowStart = now;
    recent.set(key, { firstAt: windowStart, count: batchCount });

    const message = typeof line.message === 'string' ? line.message : TITLES[kind];
    // dedupKey buckets by window start so a later, genuinely new incident on the
    // same device gets its own feed entry rather than being folded into an old one.
    const dedupKey = `ios-${kind}:${device}:${Math.floor(windowStart / INCIDENT_WINDOW_MS)}`;

    // Bus first: it is synchronous and cannot fail, so a subscriber (or a test)
    // sees the incident even if the durable write below throws.
    bus.emit(
      EventNames.CLIENT_INCIDENT,
      { device, kind, message, dedupKey, count: batchCount, timestamp: windowStart },
      ['web-ui'],
      { source: 'client-incidents' },
    );

    try {
      const record = await addNotification({
        kind: 'operation-error',
        severity: SEVERITIES[kind],
        title: `${TITLES[kind]} — ${message}`.slice(0, 160),
        body: buildBody(line, device, batchCount),
        timestamp: windowStart,
        dedupKey,
      });
      created += 1;
      // Live bell update; the durable write alone only shows after a refresh.
      if (record.timestamp === windowStart) options.broadcast?.('notification:new', record);
      log.notif.info('client incident flagged', { device, kind, dedupKey, count: batchCount });
    } catch (err) {
      // Un-arm the window so the next batch retries instead of being silently
      // suppressed for 10 minutes with nothing durable to show.
      if (recent.get(key)?.firstAt === windowStart) recent.delete(key);
      log.notif.warn('client incident: failed to persist notification', {
        device, kind, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return created;
}

/** Tests only — drop the in-memory dedup window. */
export function _resetClientIncidentsForTesting(): void {
  recent.clear();
}
