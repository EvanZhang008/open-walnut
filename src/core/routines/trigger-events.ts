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

export async function handleTriggerFired(host: string, event: TriggerFiredEvent): Promise<void> {
  const service = await resolveService();
  if (!service) {
    // Deliberately NOT acked: the daemon keeps it in pendingFires and replays it
    // once the engine is up, which is the whole point of at-least-once.
    log.cron.warn('trigger.fired dropped: routines engine not running', { host, jobId: event.id });
    return;
  }

  const applied = await service.applyTriggerFired(event, async (job) => {
    if (!job.executor) return { status: 'error' as const, error: 'routine has no executor to deliver to' };
    const message = buildTriggerMessage(job, event, promptOf(job));
    const { runExecutor } = await import('./registry.js');
    return await runExecutor(job, job.executor, message);
  });

  log.cron.info('trigger fired', {
    host, jobId: event.id, epoch: event.epoch, seq: event.seq, items: event.items?.length ?? 0,
    found: applied.found, duplicate: applied.duplicate, delivered: applied.delivered, retry: applied.retry,
    ...(applied.error ? { error: applied.error } : {}),
  });

  if (!applied.found) {
    if (await hasPushedTriggersTo(host)) {
      await ackFire(host, event.id, event.seq);
    } else {
      log.cron.warn('trigger.fired for a routine this server never pushed: left unacked', { host, jobId: event.id, seq: event.seq });
    }
    return;
  }
  if (applied.retry) {
    // Withheld ack = the daemon replays it; the attempt count lives on the job.
    log.cron.warn('trigger delivery failed transiently; the daemon will replay it', {
      host, jobId: event.id, seq: event.seq, error: applied.error,
    });
    return;
  }
  if (applied.gaveUp) {
    await notifyTrigger({
      title: `Trigger "${applied.jobName ?? event.id}" could not deliver`,
      body: applied.error ?? 'delivery kept failing',
      dedupKey: `trigger-delivery:${event.id}:${event.epoch ?? ''}:${event.seq}`,
    });
  }
  await ackFire(host, event.id, event.seq);
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
 * A fire is guarded while it is being handled: the store's (epoch, seq) mark is
 * written only AFTER delivery, so concurrent copies would all pass the dedup and
 * deliver three times. The guard is released when handling ends, so the
 * daemon's minute-later replay of a fire whose delivery failed transiently is
 * NOT swallowed (that replay is the retry). A checked event has no ack and no
 * retry, so its copies are simply dropped for a minute.
 */
const firesInFlight = new Set<string>();
const recentChecked = new Map<string, number>();
const RECENT_CHECKED_TTL_MS = 60_000;
const RECENT_CHECKED_MAX = 5_000;

function fireKey(host: string, e: TriggerFiredEvent): string {
  return `${host}|${e.id}|${e.epoch ?? ''}|${e.seq}`;
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
      const key = fireKey(host, event);
      if (firesInFlight.has(key)) {
        log.cron.debug('trigger.fired duplicate while in flight (fan-out copy)', { host, jobId: event.id, seq: event.seq });
        return;
      }
      firesInFlight.add(key);
      try {
        await handleTriggerFired(host, event);
      } finally {
        firesInFlight.delete(key);
      }
    }
  })().catch((err) => {
    log.cron.error('trigger event handling failed', {
      host, type: (event as { type?: string }).type, jobId: (event as { id?: string }).id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
