/**
 * A switch picked while a turn ran waits for that turn's end (engine-switch.ts,
 * the user's rule: "你可以让他等完再去切"). The pick is stored on the task
 * (`engine_switch.state = 'pending'`), so it survives a restart; this module
 * runs it once the old session is free, after the short settle a background
 * command's follow-up turn needs (team-stop.ts does the same).
 *
 * A pending switch always ends, by a clock as well as by events (2026-11-03: a task's
 * move to the Mac stayed pending 1 h 50 min, because the turn that asked for it had
 * started a test run in the background, the session read `running` all along, and only
 * a status event could start the switch):
 *  - every status change of the session looks again, and so does a poll every
 *    TURN_END_POLL_MS, so a missed event costs at most one poll;
 *  - work the finished turn left running (a detached command, an armed wakeup) holds it
 *    SWITCH_BACKGROUND_GRACE_MS from when it was first seen holding it; then the switch
 *    runs and stops that work, and the new session is told (BACKGROUND_CUT_NOTE);
 *  - a turn (or a queued message) still holding it SWITCH_PENDING_MAX_MS after the ask
 *    fails it: `engine_switch.state = 'failed'` with the reason, its message kept for the
 *    user, and the task's session (and the asking task's, when another) is told.
 * The wait itself is turn-end-wait.ts; lifecycle-waits.ts lists it.
 */
import { log } from '../../logging/index.js';
import type { EngineSwitchState } from '../types.js';
import type { SwitchHold } from './engine-switch.js';
import { TurnEndWait, turnEndVerdict, type TurnEndVerdict, type TurnHold } from './turn-end-wait.js';

export const SWITCH_BACKGROUND_GRACE_MS = 10 * 60_000;
export const SWITCH_PENDING_MAX_MS = 2 * 60 * 60_000;
const LIMITS = { backgroundGraceMs: SWITCH_BACKGROUND_GRACE_MS, maxMs: SWITCH_PENDING_MAX_MS };

export type PendingVerdict = TurnEndVerdict;

/** What a pending switch does now, from what holds it and for how long. */
export function pendingVerdict(input: { hold: TurnHold; askedAt: number; backgroundSince?: number; now: number }): PendingVerdict {
  return turnEndVerdict({ ...input, limits: LIMITS });
}

let taskManagerMod: Promise<typeof import('../task-manager.js')> | null = null;
const taskManager = () => (taskManagerMod ??= import('../task-manager.js'));

async function pendingOf(taskId: string, sessionId: string): Promise<EngineSwitchState | null> {
  const { getTask } = await taskManager();
  const pending = (await getTask(taskId).catch(() => null))?.engine_switch;
  return pending?.state === 'pending' && pending.from_session_id === sessionId ? pending : null;
}

const waiter = new TurnEndWait<{ taskId: string }>({
  name: 'engine-switch-turn-end',
  limits: LIMITS,
  queue: true,
  asked: async (sid, { taskId }) => {
    const pending = await pendingOf(taskId, sid);
    return pending ? { askedAt: Date.parse(pending.at) } : null;
  },
  act: async (sid, { taskId }, verdict, hold) => {
    const pending = await pendingOf(taskId, sid);
    if (!pending) return;
    if (verdict === 'expire') { await expireSwitch(taskId, pending, hold); return; }
    if (verdict === 'run-over-background') {
      log.session.info('engine switch: runs over the background work its turn left', { taskId, sessionId: sid, switchId: pending.id });
    }
    const { runEngineSwitch } = await import('./engine-switch.js');
    // A session busy again parks it once more, and that calls watchPendingSwitch (engine-switch.ts execute).
    await runEngineSwitch(taskId, pending, { overBackground: verdict === 'run-over-background' });
  },
});

export function watchPendingSwitch(taskId: string, sessionId: string): void {
  waiter.watch(sessionId, { taskId });
}

/** Tests: the pending switches being watched (sessionId → taskId). */
export function watchedSwitchesForTest(): Map<string, string> {
  return new Map(waiter.values().map(([sid, d]) => [sid, d.taskId]));
}

/** The words a failed wait leaves on the task and tells its session. */
export function expiredSwitchText(sw: Pick<EngineSwitchState, 'move' | 'to'>, hold: SwitchHold): string {
  const what = sw.move ? `The move to ${sw.to.host ?? 'the other host'}` : `The switch to ${sw.to.engine}`;
  const why = hold === 'queue' ? 'a message queued for its session was still waiting to be delivered' : 'its session was still in a turn';
  return `${what} waited ${Math.round(SWITCH_PENDING_MAX_MS / 3_600_000)} hours and ${why}, so it did not run. `
    + 'The task stays on its current session. Ask for it again once the session is free.';
}

async function expireSwitch(taskId: string, sw: EngineSwitchState, hold: SwitchHold): Promise<void> {
  const error = expiredSwitchText(sw, hold);
  const { updateTaskRaw } = await import('../task-manager.js');
  let failed = false;
  await updateTaskRaw(taskId, (cur) => {
    if (cur.engine_switch?.id !== sw.id || cur.engine_switch.state !== 'pending') return null;
    failed = true;
    // Its message stays, as for every failed switch: the user can still send it here or let it go.
    return { engine_switch: { ...cur.engine_switch, state: 'failed', error } };
  }, { source: 'engine-switch', emitEvent: true });
  if (!failed) return;
  log.session.warn('engine switch: the wait ran out; the task stays on its session', { taskId, switchId: sw.id, hold, from: sw.from_session_id });
  await tellExpired(taskId, sw, error).catch((err: unknown) => log.session.warn('engine switch: telling the session the wait ran out failed', {
    taskId, error: err instanceof Error ? err.message : String(err),
  }));
}

/** The task's session hears it (and the asking task's, when another task asked), never woken for it. */
async function tellExpired(taskId: string, sw: EngineSwitchState, error: string): Promise<void> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const { deliverToSession } = await import('./session-send-core.js');
  const { createEnvelopeKit } = await import('../peers/envelope-kit.js');
  const { taskConversation } = await import('./task-session-claim.js');
  const kit = createEnvelopeKit();
  const text = kit.buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', 'about-task': taskId, outcome: sw.move ? 'move-expired' : 'switch-expired', note: 'automated Walnut status notice' },
    body: `${error} A status notice, not a request: nothing waits on an answer.`,
  });
  const targets = new Set<string>([sw.from_session_id]);
  const asker = sw.by?.startsWith('task:') ? sw.by.slice(5) : undefined;
  if (asker && asker !== taskId) {
    const conv = await taskConversation(asker).catch(() => null);
    if (conv) targets.add(conv.claudeSessionId);
  }
  for (const sid of targets) {
    const rec = await getSessionByClaudeId(sid).catch(() => null);
    if (!rec || rec.archived) continue;
    await deliverToSession(rec, { busText: text, enqueueText: text, source: 'walnut-notify', taskId: rec.taskId });
  }
}

/**
 * At startup: a pending switch waits again (or runs, when its turn is over); one a
 * restart cut mid-way is put back to pending, after its old session is restored as
 * the task's session when no new one took over.
 */
export async function resumeEngineSwitches(): Promise<number> {
  const { listTasks, updateTaskRaw } = await import('../task-manager.js');
  const { getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js');
  let n = 0;
  for (const task of await listTasks()) {
    const sw = task.engine_switch;
    if (!sw || (sw.state !== 'pending' && sw.state !== 'switching')) continue;
    n++;
    if (sw.state === 'switching') {
      const { taskConversation } = await import('./task-session-claim.js');
      const active = await taskConversation(task.id);
      if (active && active.claudeSessionId !== sw.from_session_id) {
        // The new session started (or the earlier one was resumed) before the restart:
        // finish what follows it (each step is idempotent).
        const to = active.claudeSessionId;
        if (sw.resume_session_id === to && sw.resume_message) {
          // Its message may not have been queued yet; the same id collapses onto it when it was.
          const { sendResumeMessage } = await import('./engine-switch-resume.js');
          await sendResumeMessage(task.id, sw, to, sw.resume_message, sw.to.permission_mode).catch((err: unknown) => log.session.warn('engine switch: resending the resume message failed', {
            taskId: task.id, sessionId: to, error: err instanceof Error ? err.message : String(err),
          }));
        }
        await updateSessionRecord(sw.from_session_id, { supersededBy: to }).catch(() => {});
        const { retargetRequestsToSession } = await import('../session-requests.js');
        await retargetRequestsToSession(sw.from_session_id, to).catch(() => 0);
        const { putQueuedRows } = await import('./engine-switch-io.js');
        if (sw.held_rows?.length) await putQueuedRows(to, sw.held_rows as never[]).catch(() => {});
        await updateTaskRaw(task.id, {
          engine_switch: {
            ...sw, state: 'done', message: undefined, display_text: undefined, held_rows: undefined,
            resume_session_id: undefined, resume_message: undefined, session_id: to, ...(sw.resume_session_id === to ? { resumed: true } : {}),
          },
        }, { source: 'engine-switch', emitEvent: true });
        continue;
      }
      const old = await getSessionByClaudeId(sw.from_session_id).catch(() => null);
      if (old?.archived) await updateSessionRecord(old.claudeSessionId, { archived: false, archive_reason: undefined }).catch(() => {});
      if (old) {
        const { linkSession } = await import('../task-manager.js');
        await linkSession(task.id, old.claudeSessionId).catch(() => {});
        const { putQueuedRows } = await import('./engine-switch-io.js');
        if (sw.held_rows?.length) await putQueuedRows(old.claudeSessionId, sw.held_rows as never[]).catch(() => {});
      }
      await updateTaskRaw(task.id, { engine_switch: { ...sw, state: 'pending', held_rows: undefined, resume_session_id: undefined, resume_message: undefined } }, { source: 'engine-switch', emitEvent: true });
    }
    // The watch looks at once and keeps the deadlines (counted from `sw.at`, kept on the task).
    watchPendingSwitch(task.id, sw.from_session_id);
  }
  if (n > 0) log.session.info('engine switches resumed at startup', { count: n });
  return n;
}
