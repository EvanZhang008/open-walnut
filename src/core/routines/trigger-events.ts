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
 *
 * Who delivers is the daemon's call (trigger-claim-v1): this server claims each
 * fire the moment it arrives, and a fire nobody claimed in time is delivered by
 * the host itself into the target task's live session there (the Mac asleep, a
 * dead socket). Such a fire comes back with `host` set, and is only recorded.
 * A claim that gets no answer is not a verdict: the fire is neither delivered nor
 * acked, and its replay asks again.
 */

import {
  FIRE_BUDGET_WINDOW_MS, MAX_CONSECUTIVE_CHECK_ERRORS, MAX_FIRES_PER_DAY_DEFAULT, isHostDelivery,
} from '../../providers/trigger-check-core.js';
import type {
  HostDelivery, TriggerCheckedEvent, TriggerClaimReply, TriggerEvent, TriggerFiredEvent,
} from '../../providers/trigger-check-core.js';
import { log } from '../../logging/index.js';
import type { CronJob } from '../cron/types.js';
import { buildTriggerMessage } from './trigger-envelope.js';
import { findTriggerDaemon } from './trigger-daemon.js';
import { promptOf } from './trigger-push.js';

export { promptOf };

/** The daemon arbitrates delivery (claims, host delivery). */
export const TRIGGER_CLAIM_CAPABILITY = 'trigger-claim-v1';
const CLAIM_TIMEOUT_MS = 15_000;

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

/** "every hour", "every 5 minutes", "every 2.4 hours": how often a spent budget gives back one fire. */
export function describeRefill(cap: number): string {
  const minutes = Math.max(1, Math.round(FIRE_BUDGET_WINDOW_MS / Math.max(1, cap) / 60_000));
  if (minutes < 60) return minutes === 1 ? 'every minute' : `every ${minutes} minutes`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return hours === 1 ? 'every hour' : `every ${hours} hours`;
}

/**
 * What the user is told the first time in a day the fire budget holds a trigger
 * back. With the cadence known it names the number that lets every check fire.
 */
export function fireBudgetNoticeBody(cap: number, everyMs?: number): string {
  const perDay = everyMs && everyMs > 0 ? Math.ceil(FIRE_BUDGET_WINDOW_MS / everyMs) : 0;
  const suggest = perDay > cap
    ? ` (it checks ${perDay} times a day, so ${perDay} lets every check fire; 0 = no limit).`
    : ' (0 = no limit).';
  return `It used its fire budget (${cap} fire${cap === 1 ? '' : 's'} a day), so it now fires at most once ${describeRefill(cap)}. `
    + 'Nothing is dropped: each fire carries everything new since the last one, it just arrives later. '
    + `If this source is this busy, raise "Fires per day" on the trigger in Routines${suggest}`;
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
  const heldCap = applied.budgetHeld ? applied.budgetHeld.maxFiresPerDay ?? MAX_FIRES_PER_DAY_DEFAULT : 0;
  // A stored 0 is "no limit" (sent as a cap nothing reaches), so it has no budget to report.
  if (applied.budgetHeld && heldCap > 0) {
    const cap = heldCap;
    await notifyTrigger({
      title: `Trigger "${applied.jobName ?? event.id}" is holding fires back`,
      body: fireBudgetNoticeBody(cap, applied.budgetHeld.everyMs),
      dedupKey: `trigger-budget-held:${event.id}:${event.atMs}`,
      severity: 'warning',
    });
  }
  if (!applied.disabled) return;

  await notifyTrigger({
    title: `Trigger "${applied.jobName ?? event.id}" was disabled`,
    body: `${MAX_CONSECUTIVE_CHECK_ERRORS} check errors in a row on ${host}. Last error: ${event.error ?? 'unknown'}`,
    dedupKey: `trigger-disabled:${event.id}`,
  });
  // The push is what actually stops the polling: the job is disabled in the
  // store, so the recompiled set no longer contains it.
  await pushTriggers(applied.host ?? host);
  // A WAITING task that counted on this trigger would otherwise wait forever: hand it back.
  const { handBackWaitingTaskOfDisabledTrigger } = await import('../task-wait-until.js');
  await handBackWaitingTaskOfDisabledTrigger(event.id, event.error).catch((err) => log.cron.warn('hand-back after trigger disable failed', {
    jobId: event.id, error: err instanceof Error ? err.message : String(err),
  }));
}

/**
 * Deliver one fire, or one trigger's batch of fires (same id, same epoch) as ONE
 * envelope. Every seq is acked on its own, since the daemon's ack removes one.
 * Fires the host already delivered are recorded instead, one row per message.
 */
export async function handleTriggerFired(host: string, fires: TriggerFiredEvent | readonly TriggerFiredEvent[]): Promise<void> {
  const batch = Array.isArray(fires) ? [...fires] : [fires as TriggerFiredEvent];
  const onHost = batch.filter((e) => isHostDelivery(e.host));
  const owed = batch.filter((e) => !isHostDelivery(e.host));
  for (const group of groupByMessage(onHost)) await recordHostDelivery(host, group);
  if (owed.length > 0) await deliverFires(host, owed);
}

function groupByMessage(events: TriggerFiredEvent[]): TriggerFiredEvent[][] {
  const groups = new Map<string, TriggerFiredEvent[]>();
  for (const e of events) {
    const k = e.host?.messageId ?? '';
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return [...groups.values()];
}

/**
 * A fire the host delivered while no server claimed it: the history row says
 * so, the task leaves WAITING as an online fire would have made it, and the seqs
 * are acked. Nothing is delivered: the session already has the message.
 */
async function recordHostDelivery(host: string, group: TriggerFiredEvent[]): Promise<void> {
  const head = group[0];
  const h = head?.host;
  if (!head || !h) return;
  const seqs = group.map((e) => e.seq);
  const service = await resolveService();
  if (!service) {
    log.cron.warn('trigger.fired (delivered on host) dropped: routines engine not running', { host, jobId: head.id });
    return;
  }
  const applied = await service.applyTriggerFired(group, async (job, fresh) => {
    const text = buildTriggerMessage(job, fresh, promptOf(job), { deliveredAtMs: h.atMs });
    await wakeParkedTarget(job, h);
    return {
      status: 'ok' as const,
      // Short, and ending in the session handle: the history row clamps this clause
      // and keeps only the handle's id once it runs long.
      summary: `${host === '__local__' ? 'the local host' : host} sent it to session ${await sessionLabel(h.sessionId)}`,
      delivered: { sessionId: h.sessionId, text },
      deliveredAtMs: h.atMs,
    };
  });
  log.cron.info('trigger fire recorded: delivered on host', {
    host, jobId: head.id, epoch: head.epoch, seqs, sessionId: h.sessionId, messageId: h.messageId,
    deliveredAt: new Date(h.atMs).toISOString(), found: applied.found, duplicate: applied.duplicate,
  });
  if (!applied.found && !(await hasPushedTriggersTo(host))) {
    log.cron.warn('trigger.fired for a routine this server never pushed: left unacked', { host, jobId: head.id, seqs });
    return;
  }
  await ackFires(host, head.id, seqs);
}

async function sessionLabel(sessionId: string): Promise<string> {
  try {
    const [{ getSessionByClaudeId }, { sessionHandle }] = await Promise.all([
      import('../session-tracker.js'),
      import('../peers/walnut-message-tag.js'),
    ]);
    const session = await getSessionByClaudeId(sessionId);
    return sessionHandle(session?.title, sessionId);
  } catch {
    return sessionId.slice(0, 8);
  }
}

/**
 * A fire wakes a WAITING task: it is a new turn. Delivered on the host, it did
 * so while this server was away, so the move is made now, unless the task was
 * parked again after that delivery (its own turn may have done that).
 */
async function wakeParkedTarget(job: CronJob, h: HostDelivery): Promise<void> {
  const taskId = (job.executor?.config as { target?: unknown } | undefined)?.target;
  if (typeof taskId !== 'string' || !taskId) return;
  try {
    const [{ getTask }, { HELD_PHASES, applySessionPhase }] = await Promise.all([
      import('../task-manager.js'),
      import('../phase.js'),
    ]);
    const task = await getTask(taskId).catch(() => null);
    if (!task || !HELD_PHASES.has(task.phase)) return;
    const parkedAt = Date.parse(task.phase_changed_at ?? '');
    if (Number.isFinite(parkedAt) && parkedAt >= h.atMs) return;
    await applySessionPhase(taskId, 'session:input', 'trigger-host-delivery', { sessionId: h.sessionId });
  } catch (err) {
    log.cron.warn('trigger host delivery: could not wake the parked task', {
      jobId: job.id, taskId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function deliverFires(host: string, batch: TriggerFiredEvent[]): Promise<void> {
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
  /** The daemon's answer to this server's claim, asked the moment each fire arrived. */
  verdicts: Map<string, Promise<FireVerdict>>;
}

/**
 * Who delivers a fire. `server`: this server (claimed, or a daemon that does not
 * arbitrate). `host`: the daemon already did; record it. `wait`: no verdict (the
 * claim got no answer, the host is writing it right now, or another Walnut owns
 * the trigger); neither deliver nor ack, the replay asks again.
 */
export type FireVerdict =
  | { kind: 'server' }
  | { kind: 'host'; host: HostDelivery }
  | { kind: 'wait'; reason: string };

/** One claim RPC per trigger per burst: a reconnect replays up to 50 fires at once. */
const claimBatches = new Map<string, { host: string; id: string; epoch?: string; waiters: Array<{ seq: number; resolve: (v: FireVerdict) => void }> }>();

function claimFire(host: string, event: TriggerFiredEvent): Promise<FireVerdict> {
  if (isHostDelivery(event.host)) return Promise.resolve({ kind: 'host', host: event.host });
  const key = `${host}|${event.id}|${event.epoch ?? ''}`;
  return new Promise((resolve) => {
    let batch = claimBatches.get(key);
    if (!batch) {
      const created = { host, id: event.id, ...(event.epoch ? { epoch: event.epoch } : {}), waiters: [] as Array<{ seq: number; resolve: (v: FireVerdict) => void }> };
      claimBatches.set(key, created);
      batch = created;
      setTimeout(() => {
        claimBatches.delete(key);
        // Every waiter is resolved, whatever happens: a lane awaits these verdicts.
        void claimSeqs(created.host, created.id, created.epoch, created.waiters.map((w) => w.seq))
          .catch(() => new Map<number, FireVerdict>())
          .then((verdicts) => {
            for (const w of created.waiters) w.resolve(verdicts.get(w.seq) ?? { kind: 'wait', reason: 'no verdict for this seq' });
          });
      }, 0);
    }
    batch.waiters.push({ seq: event.seq, resolve });
  });
}

/** Ask the daemon for these fires. Never throws; no answer is `wait`, never `server`. */
export async function claimSeqs(host: string, id: string, epoch: string | undefined, seqs: readonly number[]): Promise<Map<number, FireVerdict>> {
  const out = new Map<number, FireVerdict>();
  const all = (v: FireVerdict) => { for (const seq of seqs) out.set(seq, v); return out; };
  let conn: Awaited<ReturnType<typeof findTriggerDaemon>> = null;
  try { conn = await findTriggerDaemon(host); } catch { conn = null; }
  // With no connection there is nobody to ask, and nobody to ack to either.
  if (!conn) return all({ kind: 'wait', reason: 'daemon not connected' });
  // A daemon that says it does not arbitrate never delivers on its own. One whose
  // hello never answered is ASKED: assuming "old" there would let both deliver.
  if (conn.capabilitiesKnown !== false && !conn.hasCapability(TRIGGER_CLAIM_CAPABILITY)) return all({ kind: 'server' });
  let reply: Record<string, unknown>;
  try {
    reply = await conn.send('triggers.claim', { triggerId: id, ...(epoch ? { epoch } : {}), seqs: [...seqs] }, CLAIM_TIMEOUT_MS);
  } catch (err) {
    return all({ kind: 'wait', reason: `claim got no answer: ${err instanceof Error ? err.message : String(err)}` });
  }
  if (reply.ok === false) {
    const error = String(reply.error ?? 'unknown error');
    // Only a daemon too old to know the command is sure to deliver nothing itself.
    if (error.startsWith('unknown command')) return all({ kind: 'server' });
    return all({ kind: 'wait', reason: `claim refused: ${error}` });
  }
  const r = reply as unknown as Partial<TriggerClaimReply>;
  if (r.foreign) return all({ kind: 'wait', reason: 'the trigger belongs to another Walnut' });
  for (const seq of [...(r.claimed ?? []), ...(r.unknown ?? [])]) out.set(seq, { kind: 'server' });
  for (const seq of r.busy ?? []) out.set(seq, { kind: 'wait', reason: 'the host is delivering it right now' });
  for (const entry of r.host ?? []) {
    if (entry && isHostDelivery(entry.host)) out.set(entry.seq, { kind: 'host', host: entry.host });
  }
  return out;
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
    lane = { queue: [], keys: new Set(), draining: false, verdicts: new Map() };
    lanes.set(laneKey, lane);
  }
  const key = fireKey(host, event);
  if (lane.keys.has(key)) {
    log.cron.debug('trigger.fired duplicate while queued or in flight (fan-out copy)', { host, jobId: event.id, seq: event.seq });
    return;
  }
  lane.keys.add(key);
  lane.queue.push(event);
  // Claimed at ARRIVAL, not when the lane reaches it: a fire queued behind a slow
  // delivery would otherwise look unclaimed to the host and be delivered twice.
  lane.verdicts.set(key, claimFire(host, event));
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
      const judged = await Promise.all(taken.map(async (event) => ({
        event,
        verdict: await (lane.verdicts.get(fireKey(host, event)) ?? Promise.resolve<FireVerdict>({ kind: 'server' })),
      })));
      const ready: TriggerFiredEvent[] = [];
      for (const { event, verdict } of judged) {
        if (verdict.kind === 'wait') {
          log.cron.info('trigger fire left to the daemon: no claim verdict', { host, jobId: event.id, seq: event.seq, reason: verdict.reason });
          lane.keys.delete(fireKey(host, event));
          lane.verdicts.delete(fireKey(host, event));
        } else {
          ready.push(verdict.kind === 'host' ? { ...event, host: verdict.host } : event);
        }
      }
      for (const group of groupByEpoch(ready)) {
        try {
          await handleTriggerFired(host, group);
        } catch (err) {
          log.cron.error('trigger fire handling failed', {
            host, jobId: group[0].id, seqs: group.map((e) => e.seq),
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          for (const e of group) {
            lane.keys.delete(fireKey(host, e));
            lane.verdicts.delete(fireKey(host, e));
          }
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
