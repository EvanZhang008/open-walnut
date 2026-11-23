/**
 * Rows on their way from one session's queue to another place (2026-11-23, the user: a message is
 * never lost, a restart or crash included). An engine switch or a move takes the old session's
 * waiting rows and puts them on the new session minutes later; a host hand takes a session's lines
 * and keeps them until its host says it took them. Taken into the code's memory, a crash or a
 * failed write between the take and the put left a row in no queue at all.
 *
 * So the rows wait in the queue file itself (QueueStore.transit), under the move's id: the take is
 * one strict write (out of the queue, into the transit), the put is one strict write (out of the
 * transit, into the target queue), and a row is always in exactly one place on disk. A transit no
 * live code holds (its process died, or the put kept failing) is put back where it belongs by
 * settleStrandedTransits, at startup and again until it lands.
 */
import { randomUUID } from 'node:crypto';
import { log } from '../logging/index.js';
import { IS_EPHEMERAL } from '../constants.js';
import { isProcessAlive } from '../utils/process.js';
import { processActionsRefused } from './sessions/replica-process-guard.js';
import { mutateStore, readQueueFileFresh, type QueuedMessage, type QueueTransit } from './session-queue-store.js';

/** Transits this process holds: the sweep leaves them to their owner. */
const live = new Set<string>();
/** Host hands the host took whose drop did not reach the disk: the sweep drops them, never puts them back. */
const delivered = new Set<string>();
/** This process's boot: a transit of another boot is stranded unless its owner is provably alive. */
const BOOT = randomUUID();
/** A transit of another boot this old is stranded whatever its pid says (a reused pid, EPERM). */
const OWNER_MAX_MS = 10 * 60_000;
/** Switch transits wait for the switch resume (engine-switch-watch.ts) before the sweep may place them. */
let switchesSettled = false;

export function newTransitId(kind: string): string {
  return `${kind}-${randomUUID()}`;
}

/**
 * Take the rows `pick` chooses out of `from`'s queue into transit `id`, in one strict write (a
 * second take into the same id adds to it). Throws, with nothing changed, when the write fails.
 */
export async function takeIntoTransit(
  id: string, kind: QueueTransit['kind'], from: string,
  pick: (r: QueuedMessage) => boolean, mark?: (r: QueuedMessage) => void, to?: string,
): Promise<QueuedMessage[]> {
  live.add(id);
  let created = false;
  try {
    return await mutateStore((s) => {
      const rows = s.queues[from] ?? [];
      const take = rows.filter(pick);
      if (take.length === 0) return [];
      for (const r of take) mark?.(r);
      const transit = s.transit ??= {};
      created = !transit[id];
      const t = transit[id] ??= { from, kind, pid: process.pid, boot: BOOT, at: Date.now(), ...(to ? { to } : {}), rows: [] };
      for (const r of take) if (!t.rows.some((x) => x.id === r.id)) t.rows.push(r);
      s.queues[from] = rows.filter((r) => !take.includes(r));
      if (s.queues[from].length === 0) delete s.queues[from];
      return take.map((r) => structuredClone(r));
    }, true, true);
  } catch (err) {
    // A write that landed and then threw (a failed directory sync) left rows its caller thinks
    // were not taken: the sweep places whatever the transit holds. A take into a transit the
    // caller already holds (a switch's second take) leaves it to that caller, which lands the
    // whole transit, whatever this take added.
    if (created) abandonTransit(id);
    throw err;
  }
}

/**
 * Rows a move held only in memory before transits existed (an engine switch's `held_rows` on its
 * task, from a server older than this file): into transit `id`, unless a queue has them already.
 */
export async function adoptIntoTransit(id: string, kind: QueueTransit['kind'], from: string, rows: QueuedMessage[]): Promise<void> {
  if (rows.length === 0) return;
  await mutateStore((s) => {
    const queued = new Set(Object.values(s.queues).flat().map((r) => r.id));
    const transit = s.transit ??= {};
    const t = transit[id] ??= { from, kind, pid: process.pid, boot: BOOT, at: Date.now(), rows: [] };
    for (const r of rows) if (!queued.has(r.id) && !t.rows.some((x) => x.id === r.id)) t.rows.push(structuredClone(r));
    if (t.rows.length === 0) delete transit[id];
    if (!Object.keys(transit).length) delete s.transit;
  }, true, true);
}

/**
 * Put transit `id`'s rows into `to`'s queue and end the transit, in one strict write. `rows`: the
 * caller's own versions of them (an engine switch puts its carried context on the first); only
 * the transit decides which rows go, so a transit the sweep already placed puts nothing a second
 * time. A row `to` already has is not put twice. `front`: before
 * the rows already there (rows put back where they were taken). How many rows went in. Throws,
 * with nothing changed, when the write fails: the rows stay in the transit.
 */
export async function landTransit(
  id: string, to: string,
  opts: { rows?: QueuedMessage[]; prepare?: (r: QueuedMessage) => QueuedMessage; front?: boolean } = {},
): Promise<number> {
  const n = await mutateStore((s) => {
    const t = s.transit?.[id];
    const mine = new Map((opts.rows ?? []).map((r) => [r.id, r] as const));
    const base = t?.rows ?? [];
    const all = base.map((r) => mine.get(r.id) ?? r);
    const queue = s.queues[to] ?? [];
    const have = new Set(queue.map((r) => r.id));
    const moved = all.filter((r) => !have.has(r.id)).map((r) => (opts.prepare ? opts.prepare(structuredClone(r)) : structuredClone(r)));
    if (moved.length > 0) s.queues[to] = opts.front ? [...moved, ...queue] : [...queue, ...moved];
    if (t) {
      delete s.transit![id];
      if (!Object.keys(s.transit!).length) delete s.transit;
    }
    return moved.length;
  }, true, true);
  live.delete(id);
  delivered.delete(id);
  return n;
}

/** The rows left for good (a host took them): the transit ends. A failed write leaves it to the sweep, which drops it. */
export async function dropTransit(id: string): Promise<void> {
  try {
    await mutateStore((s) => {
      if (!s.transit?.[id]) return;
      delete s.transit[id];
      if (!Object.keys(s.transit).length) delete s.transit;
    }, true, true);
    live.delete(id);
    delivered.delete(id);
  } catch (err) {
    delivered.add(id);
    abandonTransit(id, err);
  }
}

/** Where transit `id` goes, once its owner knows (a switch's new session): its rows show there too. Best effort. */
export async function noteTransitTarget(id: string, to: string): Promise<void> {
  await mutateStore((s) => { const t = s.transit?.[id]; if (t && t.to !== to) t.to = to; }).catch(() => {});
}

/** A transit that never took a row: nothing to place. */
export function forgetTransit(id: string): void {
  live.delete(id);
}

/** The owner gave up on placing transit `id` (its put failed): the sweep places it, and keeps trying. */
export function abandonTransit(id: string, err?: unknown): void {
  live.delete(id);
  if (err !== undefined) {
    log.session.warn('queue transit: rows wait in the queue file for the sweep to place them', {
      transitId: id, error: err instanceof Error ? err.message : String(err),
    });
  }
  scheduleSweep();
}

/** Whether another process may still be placing `t`: only an owner of another boot that is provably alive, and not for ever. */
function ownedElsewhere(t: QueueTransit): boolean {
  if (t.boot === BOOT || (t.boot === undefined && t.pid === process.pid)) return false;
  if (Date.now() - t.at > OWNER_MAX_MS) return false;
  // A host replica probes no pid (its sessions are copies of the Mac's): the owner keeps it until its allowance ends.
  if (processActionsRefused()) return true;
  // A signal-0 probe of this machine's own process table (ESRCH: gone; EPERM: another user's
  // process holds the pid now, not the owner). Never a signal sent to a session's process.
  return isProcessAlive(t.pid);
}

/**
 * Place every transit no live code holds: a host hand's rows go back to their session's queue (in
 * front, where they were), an engine switch's to the task's active session (the new one when the
 * switch finished, the old one when it was undone), deliverable. `switches`: the switch resume
 * ran, so switch transits of an earlier server may be placed too. Keeps trying (scheduleSweep)
 * while one does not land. Never on an ephemeral server: its copied file is production's.
 */
export async function settleStrandedTransits(opts: { switches?: boolean } = {}): Promise<number> {
  if (IS_EPHEMERAL) return 0;
  if (opts.switches) switchesSettled = true;
  let placed = 0;
  let again = false;
  let disk;
  try { disk = await readQueueFileFresh({ readErrors: 'throw' }); } catch { scheduleSweep(); return 0; }
  for (const [id, t] of Object.entries(disk.transit ?? {})) {
    if (live.has(id)) continue;
    if (ownedElsewhere(t)) { again = true; continue; }
    // A switch an earlier server ran waits for the switch resume to settle it first.
    if (t.kind === 'switch' && !switchesSettled && t.boot !== BOOT) continue;
    try {
      if (delivered.has(id)) {
        await mutateStore((s) => { if (s.transit) { delete s.transit[id]; if (!Object.keys(s.transit).length) delete s.transit; } }, true, true);
        delivered.delete(id);
        continue;
      }
      let to = t.from;
      if (t.kind === 'switch') {
        const { activeSessionFor } = await import('./sessions/engine-switch.js');
        to = await activeSessionFor(t.from);
      }
      // Its owner may have taken it up again while the address was looked up.
      if (live.has(id)) continue;
      const n = t.kind === 'switch'
        ? await (await import('./sessions/engine-switch-io.js')).putQueuedRows(to, [], id, { release: true })
        : await landTransit(id, to, { front: true });
      if (n === 0) continue;
      placed += t.rows.length;
      log.session.info('queue transit: rows a move left on the way are queued again', { transitId: id, kind: t.kind, from: t.from, to, rows: t.rows.length });
      const { bus, EventNames } = await import('./event-bus.js');
      bus.emit(EventNames.SESSION_SEND, { sessionId: to, message: '' }, ['session-runner'], { source: 'queue-transit' });
    } catch (err) {
      again = true;
      log.session.warn('queue transit: placing stranded rows failed; trying again', { transitId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (again) scheduleSweep();
  return placed;
}

/**
 * Rows of `sessionId` not in its queue yet (read only): on their way from it or to it (a move, a
 * host hand), or in the enqueue's spool (session-queue-spool.ts). Its panel shows them as waiting.
 */
export async function rowsOnTheWay(sessionId: string): Promise<QueuedMessage[]> {
  const { getStore } = await import('./session-queue-store.js');
  const store = await getStore();
  const queued = new Set((store.queues[sessionId] ?? []).map((r) => r.id));
  const out: QueuedMessage[] = Object.values(store.transit ?? {})
    .filter((t) => t.from === sessionId || t.to === sessionId)
    .flatMap((t) => t.rows.map((r) => ({ ...r, status: 'pending' as const })));
  const { spoolMayHoldRows, spooledRows } = await import('./session-queue-spool.js');
  if (spoolMayHoldRows()) out.push(...(await spooledRows()).filter((r) => r.sessionId === sessionId).map((r) => ({ ...r, status: 'pending' as const })));
  const seen = new Set<string>();
  return out.filter((r) => !queued.has(r.id) && !seen.has(r.id) && !!seen.add(r.id));
}

/** The row of this id on its way somewhere (a transit, the spool), or null. */
export async function rowOnTheWay(messageId: string): Promise<QueuedMessage | null> {
  const { getStore } = await import('./session-queue-store.js');
  for (const t of Object.values((await getStore()).transit ?? {})) {
    const row = t.rows.find((r) => r.id === messageId);
    if (row) return row;
  }
  const { spoolMayHoldRows, spooledRow } = await import('./session-queue-spool.js');
  return spoolMayHoldRows() ? spooledRow(messageId) : null;
}

const SWEEP_RETRY_MS = 30_000;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    void settleStrandedTransits().catch(() => scheduleSweep());
  }, SWEEP_RETRY_MS);
  sweepTimer.unref?.();
}

/** Tests only: forget this process's transits and timers (a restart). */
export function resetTransitState(): void {
  live.clear();
  delivered.clear();
  switchesSettled = false;
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = null;
}
