/**
 * The ONE bus subscriber that keeps what arrived, so a run has something to read.
 *
 * Two subscribers now watch the same two events, and merging them would be a
 * mistake: `routine-wake` (src/core/routines/wake-events.ts) counts events for
 * the generic threshold gate and must work for any future wake routine, while
 * this one KEEPS THE PAYLOADS and is triage-specific. Different jobs, different
 * lifetimes, distinct names — and each is exactly one global subscriber.
 *
 * Three rules this file exists to keep:
 *
 *  - `interest` is not optional. A global subscriber is consulted for every event
 *    on the hot path, so without the allowlist every streaming delta would wake
 *    this handler (event-bus.ts interest semantics). The set is FIXED (both
 *    source events, always) rather than derived from `triage.sources`: turning a
 *    source off mid-batch would otherwise silently discard items already on the
 *    wire, and the batch filters by `sources` anyway.
 *
 *  - Buffer, then flush. Ten mail accounts reporting in one tick must be ONE disk
 *    write, so arrivals accumulate in memory and a 5s TRAILING timer folds them
 *    into triage-state.json. Same discipline (and the same 5s) as the wake
 *    counter, for the same reason.
 *
 *  - NEVER on a replica. The buffer is machine-local and the run happens on the
 *    primary; a replica collecting would fill a file nothing reads and would
 *    double-count nothing useful. Guarded here as well as at the call site, so an
 *    accidental import can't start it.
 *
 * A flush when triage is DISABLED throws the buffer away rather than writing it:
 * an install that never turned triage on must not accumulate a file at all.
 */

import { bus, type BusEvent } from '../event-bus.js';
import { CLOUD_MODE } from '../../constants.js';
import { log } from '../../logging/index.js';
import { readTriageConfig, type TriageConfigHolder } from './config.js';
import { recordTriageArrivals, type TriagePendingMail, type TriagePendingSlack } from './state.js';
import { TRIAGE_WAKE_EVENTS } from './types.js';

/** The ONE subscriber name. Re-subscribing overwrites it; nothing else may use it. */
export const TRIAGE_COLLECT_SUBSCRIBER = 'triage-collect';

/** Trailing flush window — long enough to fold a burst, short enough to feel live. */
export const TRIAGE_COLLECT_FLUSH_MS = 5_000;

/** How many headlines one mail tick contributes (the emitter's own cap). */
const MAX_HEADLINES = 5;

/** Defensive ceiling on ONE flush, so a misbehaving emitter cannot wedge a write. */
const MAX_BUFFERED = 400;

export type TriageCollectDeps = {
  getConfig?: () => Promise<TriageConfigHolder>;
  record?: typeof recordTriageArrivals;
  flushMs?: number;
  /** Tests only: collect even under CLOUD_MODE. */
  allowReplica?: boolean;
};

export type TriageCollectHandle = {
  stop(): void;
  /** Flush now (tests; also called on shutdown so a pending burst is not lost). */
  flush(): Promise<void>;
  /** Diagnostics + tests: proof the interest allowlist is doing its job. */
  stats(): { handled: number; bufferedMail: number; bufferedSlack: number; droppedSlack: number; writes: number };
};

async function defaultGetConfig(): Promise<TriageConfigHolder> {
  const { getConfig } = await import('../config-manager.js');
  return await getConfig() as TriageConfigHolder;
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function count(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** `plugin:mail:messages-received` → one buffered row, or null when unusable. */
export function mailArrival(data: unknown, atMs: number): TriagePendingMail | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const accountId = str(d.accountId, 200);
  const n = count(d.count);
  if (!accountId || n <= 0) return null;
  const headlines = Array.isArray(d.headlines)
    ? d.headlines.slice(0, MAX_HEADLINES).map((h) => {
      const row = (h ?? {}) as Record<string, unknown>;
      return { from: str(row.from, 200), subject: str(row.subject, 300) };
    })
    : [];
  return { accountId, count: n, headlines, atMs };
}

/** `plugin:slack:messages-received` → buffered rows + what the plugin dropped. */
export function slackArrivals(
  data: unknown,
  atMs: number,
): { items: TriagePendingSlack[]; dropped: number } {
  if (!data || typeof data !== 'object') return { items: [], dropped: 0 };
  const d = data as Record<string, unknown>;
  const raw = Array.isArray(d.items) ? d.items : [];
  const items: TriagePendingSlack[] = [];
  for (const one of raw) {
    if (!one || typeof one !== 'object') continue;
    const r = one as Record<string, unknown>;
    const conversation = str(r.conversation, 200);
    const ts = str(r.ts, 64);
    if (!conversation && !ts) continue;
    items.push({
      conversation,
      isDm: r.isDm === true,
      isMention: r.isMention === true,
      alias: str(r.alias, 200),
      ts,
      permalink: str(r.permalink, 400),
      text: str(r.text, 400),
      atMs,
    });
  }
  // The event's own `dropped` is items the PLUGIN could not fit. They are part of
  // the true count and are reported as dropped here too, because they exist only
  // in Slack now.
  return { items, dropped: count(d.dropped) };
}

let active: TriageCollectHandle | null = null;

/**
 * Start collecting. Idempotent: starting again replaces the previous handle (the
 * subscriber name is overwritten anyway, so two alive would leak a buffer that
 * can never flush).
 */
export function startTriageCollect(deps: TriageCollectDeps = {}): TriageCollectHandle {
  active?.stop();

  const getConfig = deps.getConfig ?? defaultGetConfig;
  const record = deps.record ?? recordTriageArrivals;
  const flushMs = deps.flushMs ?? TRIAGE_COLLECT_FLUSH_MS;
  const interest = [TRIAGE_WAKE_EVENTS.mail, TRIAGE_WAKE_EVENTS.slack];

  let mail: TriagePendingMail[] = [];
  let slack: TriagePendingSlack[] = [];
  let droppedSlack = 0;
  let handled = 0;
  let writes = 0;
  let stopped = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleFlush(): void {
    if (stopped || flushTimer) return;
    flushTimer = setTimeout(() => { void flush(); }, flushMs);
  }

  async function flush(): Promise<void> {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (mail.length === 0 && slack.length === 0 && droppedSlack === 0) return;
    const batchMail = mail;
    const batchSlack = slack;
    const batchDropped = droppedSlack;
    mail = [];
    slack = [];
    droppedSlack = 0;
    try {
      const resolved = readTriageConfig(await getConfig());
      if (!resolved.enabled) {
        // Nothing to keep: a disabled triage has no run to feed, and a file that
        // grows while the feature is off is a file nobody asked for.
        log.cron.debug('triage: collector dropped a flush — triage is disabled', {
          mail: batchMail.length, slack: batchSlack.length,
        });
        return;
      }
      await record({ mail: batchMail, slack: batchSlack, droppedSlack: batchDropped });
      writes += 1;
    } catch (err) {
      // The items are gone from the buffer at this point. Re-queueing them would
      // risk an unbounded retry loop against a broken disk; the caps already make
      // this best-effort, and the WARN is what makes a real failure visible.
      log.cron.warn('triage: collector flush failed — these arrivals are lost', {
        mail: batchMail.length, slack: batchSlack.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handler(event: BusEvent): void {
    handled += 1;
    const atMs = event.timestamp || Date.now();
    if (event.name === TRIAGE_WAKE_EVENTS.mail) {
      const row = mailArrival(event.data, atMs);
      if (!row) return;
      if (mail.length >= MAX_BUFFERED) return;
      mail.push(row);
      scheduleFlush();
      return;
    }
    if (event.name === TRIAGE_WAKE_EVENTS.slack) {
      const { items, dropped } = slackArrivals(event.data, atMs);
      if (items.length === 0 && dropped === 0) return;
      const room = Math.max(0, MAX_BUFFERED - slack.length);
      slack.push(...items.slice(0, room));
      droppedSlack += dropped + Math.max(0, items.length - room);
      scheduleFlush();
    }
  }

  const handle: TriageCollectHandle = {
    stop() {
      stopped = true;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      mail = [];
      slack = [];
      droppedSlack = 0;
      bus.unsubscribe(TRIAGE_COLLECT_SUBSCRIBER);
      if (active === handle) active = null;
    },
    async flush() {
      await flush();
    },
    stats() {
      return { handled, bufferedMail: mail.length, bufferedSlack: slack.length, droppedSlack, writes };
    },
  };

  if (CLOUD_MODE && !deps.allowReplica) {
    log.cron.debug('triage: collector not started on a replica');
    stopped = true;
    return handle;
  }

  bus.subscribe(TRIAGE_COLLECT_SUBSCRIBER, handler, { global: true, interest });
  log.cron.debug('triage: collector armed', { interest, flushMs });
  active = handle;
  return handle;
}

/** Tests only: the live handle, so a spec can read its stats without holding it. */
export function getTriageCollectHandleForTesting(): TriageCollectHandle | null {
  return active;
}
