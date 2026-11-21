/**
 * The lifecycle of the errors a host's journal drain logs while a record waits for its retry
 * (offline-handover.ts: "record failed", "the conflict log could not be written").
 *
 * 2026-11-21: right after the Mac came back, `POST /routines/trigger` took over 10 s on a busy
 * server, so a queued trigger_create timed out once and applied on its retry 10 s later. Its error
 * was keyed to the session that made the write, and that session had parked on the trigger it made,
 * so no clean turn came to retire it: the card stayed open and Walnut Health raised "Background
 * errors keep happening" for an error that had already healed.
 *
 * Such an error is the drain's own condition, so the drain retires it: every one carries the host's
 * key, and a drain of that host that ends with no record waiting (nothing left for a retry) is the
 * recovery. A record that was given up is not retried, so its own error keeps its session key and
 * stays (its letter tells the user).
 */
import { log } from '../../logging/index.js';

/** The condition of every error a drain of `host` logs while a record waits for a retry. */
export function drainRecoveryKey(host: string): string {
  return `host:${host}:offline-drain`;
}

/** Hosts whose drain logged a retrying error in this process, with when it last did. */
const raised = new Map<string, number>();
/** Hosts already checked once since boot (a card an earlier process wrote is retired once). */
const checked = new Set<string>();
/**
 * How long after an error line its card may still be on its way to the store: the bridge writes
 * it in the background (a lookup, the store's lock), and a retry can succeed sooner than that.
 */
let cardSettleMs = 15_000;

/** A retrying error was just logged for `host`: its next clean drain retires it. */
export function noteDrainErrorRaised(host: string): void {
  raised.set(host, Date.now());
}

/**
 * A drain of `host` ended with no record waiting: retire its retrying errors raised before now
 * (a card a later drain raises again is not touched). Costs nothing on a host that never failed
 * here once it was checked after boot. Never throws; never awaited by the drain.
 */
export function noteDrainSettled(host: string): Promise<void> {
  const at = raised.get(host);
  if (at === undefined && checked.has(host)) return Promise.resolve();
  raised.delete(host);
  checked.add(host);
  const asOf = Date.now();
  const wait = at === undefined ? 0 : Math.max(0, at + cardSettleMs - asOf);
  if (wait === 0) return retire(host, asOf);
  return new Promise((resolve) => {
    const t = setTimeout(() => { void retire(host, asOf).then(resolve); }, wait);
    t.unref?.();
  });
}

async function retire(host: string, asOf: number): Promise<void> {
  const keys = [drainRecoveryKey(host)];
  try {
    const [{ recoverNotifications }, { releaseAbsorbedKeys }, { bus }] = await Promise.all([
      import('../notifications/store.js'),
      import('../notifications/log-error-bridge.js'),
      import('../event-bus.js'),
    ]);
    // A re-failure right after this must show again, not be folded into the retired card.
    releaseAbsorbedKeys(keys);
    const { recovered } = await recoverNotifications(keys, { asOf });
    for (const record of recovered) bus.emit('notification:updated', record, ['web-ui'], { source: 'offline-handover' });
    if (recovered.length > 0) log.session.info('offline handover: the drain caught up; its retry errors are retired', { host, count: recovered.length });
  } catch (err) {
    // Tried again at the host's next clean drain.
    if (!raised.has(host)) raised.set(host, 0);
    log.session.warn('offline handover: the drain\'s retry errors could not be retired', { host, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Tests only. */
export function _resetDrainRecoveryForTesting(settleMs?: number): void {
  raised.clear();
  checked.clear();
  cardSettleMs = settleMs ?? 15_000;
}
