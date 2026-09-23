/**
 * The server half of walnut-trigger: what a daemon's trigger events mean.
 *
 * Registered once at startup (`setTriggerEventSink`) and called straight from
 * the daemon socket handler, so the ONE hard rule here is that nothing throws
 * back into that handler: a bad event must never take a WebSocket down.
 *
 * Split of responsibilities (docs/plan/walnut-trigger.md, "daemon = when and
 * whether, server = who and what"):
 *   - cron/trigger-apply.ts owns the store bookkeeping (dedup, history, errors),
 *   - this file owns the policy: the envelope, the executor, the notification,
 *     the auto-disable push, and the ack that lets the daemon forget the fire.
 *
 * The ack for a job this server does not have is conditional: `pendingFires` is
 * at-least-once, so an unacked fire for a DELETED routine would be replayed for
 * as long as the daemon lives, and the ack is what ends that; but a fire for a
 * routine this server never pushed may belong to ANOTHER server sharing the
 * daemon (a stale test server that adopted the production daemon is a recorded
 * incident here), and acking it would eat that server's fire. The tell is
 * whether this server has pushed a trigger set to that host on this connection:
 * if it has, the daemon's armed set is ours and an unknown id is an orphan.
 *
 * A TRANSIENT delivery failure is not acked either (cron/trigger-apply.ts
 * decides which failures those are): the daemon replays the fire about once a
 * minute and the next attempt goes through the same path.
 */

import { MAX_CONSECUTIVE_CHECK_ERRORS } from '../../providers/trigger-check-core.js';
import type { TriggerCheckedEvent, TriggerEvent, TriggerFiredEvent } from '../../providers/trigger-check-core.js';
import { log } from '../../logging/index.js';
import type { CronJob } from '../cron/types.js';
import { buildTriggerMessage } from './trigger-envelope.js';
import { findTriggerDaemon } from './trigger-daemon.js';

async function notifyTrigger(input: {
  title: string;
  body?: string;
  dedupKey: string;
  severity?: 'warning' | 'error';
}): Promise<void> {
  try {
    const { addNotification } = await import('../notifications/store.js');
    await addNotification({
      kind: 'cron',
      severity: input.severity ?? 'error',
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      dedupKey: input.dedupKey,
    });
  } catch (err) {
    log.cron.warn('trigger notification failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Tell the daemon a fire is processed. Best effort: a lost ack costs one replay.
 *
 * The param is `triggerId`, never `id`: DaemonConnection.send builds the frame as
 * {id, cmd, ...params}, so an `id` param would overwrite the numeric RPC id and
 * the reply would be dropped as unmatched (a silent timeout, no log).
 */
async function ackFire(host: string, id: string, seq: number): Promise<void> {
  try {
    const conn = await findTriggerDaemon(host);
    if (!conn) return;
    await conn.send('triggers.ack', { triggerId: id, seq }, 15_000);
  } catch (err) {
    log.cron.warn('trigger ack failed', { host, jobId: id, seq, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The routine's own instruction text, whichever executor holds it. */
export function promptOf(job: CronJob): string {
  const config = job.executor?.config ?? {};
  const prompt = (config as { prompt?: unknown }).prompt;
  if (typeof prompt === 'string' && prompt.trim()) return prompt;
  const instructions = (config as { instructions?: unknown }).instructions;
  return typeof instructions === 'string' ? instructions : '';
}

async function resolveService() {
  const { getCronService } = await import('../../web/routes/cron.js');
  return getCronService();
}

export async function handleTriggerChecked(host: string, event: TriggerCheckedEvent): Promise<void> {
  const service = await resolveService();
  if (!service) {
    log.cron.warn('trigger.checked dropped: routines engine not running', { host, jobId: event.id });
    return;
  }
  const applied = await service.applyTriggerChecked(event);
  if (!applied.found) {
    log.cron.debug('trigger.checked for an unknown routine', { host, jobId: event.id });
    return;
  }
  log.cron.info('trigger checked', {
    host, jobId: event.id, outcome: event.outcome,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.error ? { error: event.error } : {}),
    consecutiveErrors: applied.consecutiveErrors ?? 0,
    disabled: applied.disabled,
  });
  if (!applied.disabled) return;

  await notifyTrigger({
    title: `Trigger "${applied.jobName ?? event.id}" was disabled`,
    body: `${MAX_CONSECUTIVE_CHECK_ERRORS} check errors in a row on ${host}. Last error: ${event.error ?? 'unknown'}`,
    dedupKey: `trigger-disabled:${event.id}`,
  });
  // The push is what actually stops the polling: the job is disabled in the
  // store, so the recompiled set no longer contains it.
  await pushTriggers(applied.host ?? host);
}

/**
 * Deliver one fire, or one trigger's batch of fires (same id, same epoch) as ONE
 * envelope. Every seq is acked on its own, since the daemon's ack removes one.
 */
export async function handleTriggerFired(host: string, fires: TriggerFiredEvent | readonly TriggerFiredEvent[]): Promise<void> {
  const batch = Array.isArray(fires) ? [...fires] : [fires as TriggerFiredEvent];
  const head = batch[0];
  if (!head) return;
  const seqs = batch.map((e) => e.seq);
  const service = await resolveService();
  if (!service) {
    // Deliberately NOT acked: the daemon keeps it in pendingFires and replays it
    // once the engine is up, which is the whole point of at-least-once.
    log.cron.warn('trigger.fired dropped: routines engine not running', { host, jobId: head.id });
    return;
  }

  const applied = await service.applyTriggerFired(batch, async (job, fresh, at) => {
    if (!job.executor) return { status: 'error' as const, error: 'routine has no executor to deliver to' };
    const message = buildTriggerMessage(job, fresh, promptOf(job), { deliveredAtMs: at.startedAtMs });
    const { runExecutor } = await import('./registry.js');
    return await runExecutor(job, job.executor, message);
  });

  log.cron.info('trigger fired', {
    host, jobId: head.id, epoch: head.epoch, seq: applied.seq ?? Math.min(...seqs),
    ...(batch.length > 1 ? { seqs, coalesced: batch.length } : {}),
    items: batch.reduce((n, e) => n + (e.items?.length ?? 0), 0),
    found: applied.found, duplicate: applied.duplicate, delivered: applied.delivered, retry: applied.retry,
    ...(applied.error ? { error: applied.error } : {}),
  });

  if (!applied.found) {
    if (await hasPushedTriggersTo(host)) {
      await ackFires(host, head.id, seqs);
    } else {
      log.cron.warn('trigger.fired for a routine this server never pushed: left unacked', { host, jobId: head.id, seqs });
    }
    return;
  }
  if (applied.retry) {
    // Withheld ack = the daemon replays it; the attempt count lives on the job.
    // Seqs already recorded before this batch are acked anyway, or they would
    // keep riding every replay.
    log.cron.warn('trigger delivery failed transiently; the daemon will replay it', {
      host, jobId: head.id, seqs, error: applied.error,
    });
    await ackFires(host, head.id, applied.duplicateSeqs ?? []);
    return;
  }
  if (applied.gaveUp) {
    await notifyTrigger({
      title: `Trigger "${applied.jobName ?? head.id}" could not deliver`,
      body: applied.error ?? 'delivery kept failing',
      dedupKey: `trigger-delivery:${head.id}:${head.epoch ?? ''}:${applied.seq ?? Math.min(...seqs)}`,
    });
  }
  await ackFires(host, head.id, seqs);
}

async function ackFires(host: string, id: string, seqs: readonly number[]): Promise<void> {
  await Promise.all(seqs.map((seq) => ackFire(host, id, seq)));
}

/** Whether this server has pushed a trigger set to that host on its live connection. */
async function hasPushedTriggersTo(host: string): Promise<boolean> {
  try {
    const conn = await findTriggerDaemon(host);
    return conn?.triggersPushed === true;
  } catch {
    return false;
  }
}

async function pushTriggers(host: string): Promise<void> {
  try {
    const { pushTriggersToHost } = await import('../../providers/daemon-connection.js');
    pushTriggersToHost(host);
  } catch (err) {
    log.cron.warn('trigger push failed', { host, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * The daemon fans every trigger event out to ALL of its trusted clients, and one
 * server holds more than one socket to a daemon (the main connection plus the
 * bulk socket, each of which dispatches trigger frames so that whichever one is
 * "first" after a reconnect still delivers). The same event therefore arrives
 * here two or three times within a few milliseconds.
 *
 * Fires of one trigger go through ONE lane, one delivery at a time. Deliveries
 * of different fires must not overlap: each one decides where to deliver from
 * the task's sessions, and with the store lock released during delivery, seven
 * concurrent fires all saw "no session" and started seven (2026-09-21). Whatever
 * queues up behind a delivery is taken as one batch, and a replay (the daemon
 * sending everything it held, after a reconnect) waits a moment first so the
 * whole burst becomes that batch.
 *
 * A fire's key stays in its lane from arrival until its delivery ends: the
 * store's (epoch, seq) mark is written only AFTER delivery, so copies arriving
 * meanwhile would pass the dedup. It is released afterwards, so the daemon's
 * minute-later replay of a fire whose delivery failed transiently is NOT
 * swallowed (that replay is the retry). A checked event has no ack and no retry,
 * so its copies are simply dropped for a minute.
 */
interface FireLane {
  queue: TriggerFiredEvent[];
  keys: Set<string>;
  draining: boolean;
}

const lanes = new Map<string, FireLane>();
/** Long enough for a replay burst over two sockets; a delivery takes seconds anyway. */
export const REPLAY_SETTLE_MS = 250;
const recentChecked = new Map<string, number>();
const RECENT_CHECKED_TTL_MS = 60_000;
const RECENT_CHECKED_MAX = 5_000;

function fireKey(host: string, e: TriggerFiredEvent): string {
  return `${host}|${e.id}|${e.epoch ?? ''}|${e.seq}`;
}

function enqueueFire(host: string, event: TriggerFiredEvent): void {
  const laneKey = `${host}|${event.id}`;
  let lane = lanes.get(laneKey);
  if (!lane) {
    lane = { queue: [], keys: new Set(), draining: false };
    lanes.set(laneKey, lane);
  }
  const key = fireKey(host, event);
  if (lane.keys.has(key)) {
    log.cron.debug('trigger.fired duplicate while queued or in flight (fan-out copy)', { host, jobId: event.id, seq: event.seq });
    return;
  }
  lane.keys.add(key);
  lane.queue.push(event);
  if (!lane.draining) void drainLane(host, laneKey, lane);
}

async function drainLane(host: string, laneKey: string, lane: FireLane): Promise<void> {
  lane.draining = true;
  try {
    if (lane.queue.some((e) => (e as { replay?: unknown }).replay === true)) {
      await new Promise((resolve) => setTimeout(resolve, REPLAY_SETTLE_MS));
    }
    while (lane.queue.length > 0) {
      const taken = lane.queue.splice(0);
      for (const group of groupByEpoch(taken)) {
        try {
          await handleTriggerFired(host, group);
        } catch (err) {
          log.cron.error('trigger fire handling failed', {
            host, jobId: group[0].id, seqs: group.map((e) => e.seq),
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          for (const e of group) lane.keys.delete(fireKey(host, e));
        }
      }
    }
  } finally {
    lane.draining = false;
    if (lane.queue.length === 0 && lanes.get(laneKey) === lane) lanes.delete(laneKey);
  }
}

/** The store's dedup window is per epoch, so a batch never mixes two numberings. */
function groupByEpoch(events: TriggerFiredEvent[]): TriggerFiredEvent[][] {
  const groups = new Map<string, TriggerFiredEvent[]>();
  for (const e of events) {
    const k = e.epoch ?? '';
    const group = groups.get(k);
    if (group) group.push(e);
    else groups.set(k, [e]);
  }
  return [...groups.values()];
}

function checkedSeenBefore(host: string, e: TriggerCheckedEvent): boolean {
  const now = Date.now();
  const key = `${host}|${e.id}|${e.atMs}|${e.outcome}`;
  const at = recentChecked.get(key);
  if (at !== undefined && now - at < RECENT_CHECKED_TTL_MS) return true;
  if (recentChecked.size >= RECENT_CHECKED_MAX) {
    for (const [k, t] of recentChecked) if (now - t >= RECENT_CHECKED_TTL_MS) recentChecked.delete(k);
    if (recentChecked.size >= RECENT_CHECKED_MAX) recentChecked.clear();
  }
  recentChecked.set(key, now);
  return false;
}

/**
 * The registered sink. Synchronous by signature (the socket handler must not
 * await) and swallowing by contract.
 */
export function handleTriggerEvent(host: string, event: TriggerEvent): void {
  void (async () => {
    if (event.type === 'trigger.checked') {
      if (checkedSeenBefore(host, event)) return;
      await handleTriggerChecked(host, event);
    } else if (event.type === 'trigger.fired') {
      enqueueFire(host, event);
    }
  })().catch((err) => {
    log.cron.error('trigger event handling failed', {
      host, type: (event as { type?: string }).type, jobId: (event as { id?: string }).id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
