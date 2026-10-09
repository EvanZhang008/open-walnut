/**
 * Cloud REPLICA: when held phone sends (send-queue.ts) are drained.
 *
 * One pass per host (send-queue-sweep.ts does what a pass does with a row), so
 * a host whose relay is stuck for 45 s never holds back a host whose link just
 * came back, and every event that makes a held row deliverable drains its host
 * at once (startSendQueueFlush). A pass that leaves rows waiting on a hop
 * expected back within seconds drains again on a short ladder, and a 60 s sweep
 * is the floor.
 */

import { CLOUD_MODE } from '../constants.js';
import { log } from '../logging/index.js';
import { listBankedSends } from './send-queue.js';
import { flushOnce } from './send-queue-sweep.js';

const FLUSH_INTERVAL_MS = 60_000;

/**
 * One drain per host, each with its own "again": a host whose relay is stuck
 * for 45s must not hold back a host whose link just came back. Before, one
 * pass served every host, so a reconnect trigger waited behind another host's
 * timeout (or, earlier still, was dropped while a pass ran).
 */
const hostFlushes = new Map<string, { running: Promise<number>; again: boolean }>();
/** Pending quick re-drains, by host (see scheduleSoonFlush). */
const soonFlushes = new Map<string, { timer?: NodeJS.Timeout; step: number }>();
/** Quick re-drains after a pass that left rows waiting on a hop expected back in seconds. */
const SOON_FLUSH_DELAYS_MS = [2_000, 5_000, 10_000, 20_000];

/**
 * Sweep the queue oldest-first (opIds sort chronologically). ORDER is per
 * session, unlike the LWW task/patch queues: a row that cannot go now holds
 * every later row of ITS session, and a host that cannot be reached holds every
 * later row for that host. Rows for other hosts still go. (This used to stop at
 * the first failure of any row, so one host's stuck send held every banked send
 * behind it, whatever host it was for.)
 *
 * Per row: relay it, delete on success OR on a domain rejection (the primary
 * ran it and refused; an identical retry refuses identically), keep on a
 * transport failure. When the host's daemon answers that no primary is behind
 * it (it forwarded nothing), a row nothing ever carried toward the primary
 * (`provablyUnsent`) goes by the host's direct path instead; any other row
 * waits for the primary, whose queue dedupes it. Rows past SEND_HORIZON_MS
 * are settled as not sent, and the phone is told (send-queue-sweep.ts).
 */
export async function flushSendQueue(host?: string): Promise<number> {
  if (!CLOUD_MODE) return 0;
  if (host) return flushHost(host);
  // Every host with a row, side by side, never two passes for one host. A row
  // that cannot be read names no host: any pass settles it, and when no host
  // has a row, a pass for none ('') still does.
  const hosts = [...new Set((await listBankedSends()).map((op) => op.host))];
  if (hosts.length === 0) return flushHost('');
  return (await Promise.all(hosts.map(flushHost))).reduce((a, b) => a + b, 0);
}

function flushHost(host: string): Promise<number> {
  // A flush asked for while this host's runs gets a pass that STARTS after the
  // ask (the running one goes round once more), and waits for it: a caller that
  // just learned the link is back must not be answered by a pass that began before.
  const current = hostFlushes.get(host);
  if (current) {
    current.again = true;
    return current.running;
  }
  const state = { running: Promise.resolve(0), again: false };
  state.running = (async () => {
    let sent = 0;
    let waiting = false;
    try {
      do {
        state.again = false;
        const pass = await flushOnce(host);
        sent += pass.sent;
        waiting = pass.waitingSoon;
      } while (state.again);
      return sent;
    } finally {
      hostFlushes.delete(host);
      if (host) scheduleSoonFlush(host, waiting);
    }
  })();
  hostFlushes.set(host, state);
  return state.running;
}

/**
 * A pass that left this host's rows waiting on a hop expected back within
 * seconds (no primary behind the host yet, a relay that timed out) drains again
 * soon, on a short ladder, rather than waiting for the 60s sweep. The events
 * that make delivery possible drain at once (startSendQueueFlush); this covers
 * a Mac too old to announce its links, or an announcement that was lost.
 */
function scheduleSoonFlush(host: string, waiting: boolean): void {
  const pending = soonFlushes.get(host);
  if (!waiting || !quickRedrains) {
    if (pending?.timer) clearTimeout(pending.timer);
    soonFlushes.delete(host);
    return;
  }
  // One timer at a time; a pass some other trigger ran does not push it out.
  if (pending?.timer) return;
  // The ladder climbs only on its own passes, and ends at the 60s sweep.
  const step = pending ? pending.step + 1 : 0;
  if (step >= SOON_FLUSH_DELAYS_MS.length) return;
  const entry: { timer?: NodeJS.Timeout; step: number } = { step };
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void flushHost(host);
  }, SOON_FLUSH_DELAYS_MS[step]);
  entry.timer.unref?.();
  soonFlushes.set(host, entry);
}

/**
 * A delivery path for `host` just came up somewhere the companion cannot see:
 * the Mac reached the host's daemon again (or its own daemon, restarted). The
 * Mac says so over its bridge (events-v1 `send-path-ready`); every row held for
 * the host goes now, and the quick ladder starts over.
 */
export function noteSendPathReady(host: string): void {
  if (!CLOUD_MODE || !host) return;
  const pending = soonFlushes.get(host);
  if (pending?.timer) clearTimeout(pending.timer);
  soonFlushes.delete(host);
  void (async () => {
    if (!(await listBankedSends()).some((op) => op.host === host)) return;
    log.session.info('send-queue: a delivery path came up; draining its held phone sends', { host });
    void flushHost(host);
  })();
}

/** The quick re-drain ladder runs only under the live triggers (a route test drains by hand). */
let quickRedrains = false;

/**
 * CLOUD box: start the drain triggers. Every event that makes a held row
 * deliverable drains that row's host at once:
 *  - the Mac's own bridge (re)connecting: everything (control relays and the
 *    Mac's sessions ride it);
 *  - a remote host's bridge (re)connecting while something is held for it (its
 *    direct path needs no primary);
 *  - the Mac reaching a host's daemon again, or its own restarted daemon: no
 *    bridge event shows it here, so the Mac announces it (noteSendPathReady);
 *  - a send of the session being answered (session-stream-v1.ts), and a row
 *    banked behind an earlier one.
 * A pass that leaves rows waiting on a hop expected back in seconds tries
 * again on a short ladder (scheduleSoonFlush), and a 60s sweep is the floor.
 */
export function startSendQueueFlush(): { stop: () => void } {
  quickRedrains = true;
  const timer = setInterval(() => { void flushSendQueue(); }, FLUSH_INTERVAL_MS);
  timer.unref?.();
  const unhooks: Array<() => void> = [];
  void (async () => {
    try {
      const registry = await import('../web/ws/bridge-registry.js');
      unhooks.push(registry.addPrimaryBridgeConnectedHandler(() => {
        log.session.info('send-queue: primary bridge connected; draining banked phone sends');
        void flushSendQueue();
      }));
      unhooks.push(registry.addBridgeConnectedHandler((hostAlias) => {
        if (hostAlias === '__local__') return; // the primary's hook above
        noteSendPathReady(hostAlias);
      }));
    } catch (err) {
      log.session.warn('send-queue: could not hook the bridge-connected trigger', { err: String(err) });
    }
  })();
  return {
    stop: () => {
      quickRedrains = false;
      clearInterval(timer);
      for (const unhook of unhooks) unhook();
      for (const pending of soonFlushes.values()) if (pending.timer) clearTimeout(pending.timer);
      soonFlushes.clear();
    },
  };
}
