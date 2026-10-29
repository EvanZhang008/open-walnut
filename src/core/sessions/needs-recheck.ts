/**
 * A "needs you" nobody can check by script is checked again on a timer (2026-10-28, the user:
 * "I've already resolved some of these. You should at least verify ... either report it up when
 * it is resolved, or verify it again after a while"; a sign-in he had finished in a terminal stayed
 * on his list, and Main read it to him as fact).
 *
 * A task whose status asks the user something in its own words (user_status `needs`, source
 * `session`) records when that was last checked (`checkedAt`: its session said it at a turn end,
 * or an armed trigger of the task ran its check). When that is older than NEEDS_RECHECK_MS and no
 * trigger of its own watches it, its session gets ONE note: check whether the user did it outside
 * Walnut, carry on if so, and arm a check if one can be scripted. Its turn-end report then states
 * the ask again (checked now) or moves on. At most MAX_RECHECKS in a row while it keeps asking the
 * user (reworded or not); after that it shows as not verified until someone looks. Primary only; an ephemeral server never wakes
 * a task for a status it copied from the real Walnut.
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { NEEDS_RECHECK_MS, agoWords } from '../user-status.js';

/** A "needs you" checked longer ago than this is checked again (user-status.ts reads it as not
 *  verified a little later, once the re-check had its turn). */
export { NEEDS_RECHECK_MS };
export const MAX_RECHECKS = 6;
const SCAN_MS = Math.min(10 * 60_000, NEEDS_RECHECK_MS / 4);

export interface NeedsRecheck {
  /** When the last re-check note went in (ISO). */
  at: string;
  /** Notes sent in a row while the task kept asking the user (in any words: a session rewords
   *  its ask at every turn). Cleared once its status no longer asks the user. */
  count: number;
  /** The ask the last note was about. */
  ask: string;
}

/** The note the re-check brings into the session. */
export function recheckBody(ask: string, checkedAt: string | undefined, nowMs: number): string {
  const at = Date.parse(checkedAt ?? '');
  return [
    `Your status asks the user: "${ask}"${Number.isFinite(at) ? `, last checked ${agoWords(nowMs - at)}` : ''}.`,
    'The user may have done it outside Walnut (a sign-in in a terminal, a tap on the phone, a review), and nothing told you. Check it now yourself: run the command, look for the file, read the letter, the review or the state it needed.',
    'Done: carry on with the work, and your report no longer asks it. Still needed: say so in your report (that counts as checked now). If a script can tell when it is done, arm a trigger on it (trigger_create, wait:false) so you hear the moment it is, and no timer has to ask again.',
  ].join('\n');
}

/** Whether a task is due a re-check now. Pure; exported for tests. */
export function recheckDue(task: Pick<Task, 'phase' | 'status' | 'user_status' | 'needs_recheck'>, opts: {
  nowMs: number; armedCheck: boolean; notBefore?: number;
}): boolean {
  const s = task.user_status;
  if (!s || s.state !== 'needs' || s.source !== 'session' || !s.ask) return false;
  if (task.phase === 'COMPLETE' || task.status === 'done' || opts.armedCheck) return false;
  // Stamped only on an ask the session wrote itself (user-status.ts stampChecked).
  const checked = Date.parse(s.checkedAt ?? '');
  if (!Number.isFinite(checked) || opts.nowMs - checked < NEEDS_RECHECK_MS) return false;
  if (opts.notBefore !== undefined && checked < opts.notBefore) return false;
  const last = task.needs_recheck;
  if (last) {
    if (last.count >= MAX_RECHECKS) return false;
    if (opts.nowMs - Date.parse(last.at) < NEEDS_RECHECK_MS) return false;
  }
  return true;
}

let timer: ReturnType<typeof setInterval> | null = null;
let startedAt = 0;
let ephemeral = false;

/** One pass: wake each task due a re-check. Exported for tests. */
export async function runNeedsRecheck(nowMs = Date.now()): Promise<string[]> {
  const woken: string[] = [];
  try {
    const { listTasks, updateTaskRaw } = await import('../task-manager.js');
    const { triggersWatching } = await import('../task-wait-until.js');
    for (const task of await listTasks()) {
      // It no longer asks the user (it waits on something else, or is done): the next ask starts a
      // fresh count. Working is not that: a re-check turn runs as Working.
      const left = task.user_status?.state === 'waiting' || task.user_status?.state === 'done' || task.phase === 'COMPLETE';
      if (task.needs_recheck && left && !task.user_status?.transient) {
        await updateTaskRaw(task.id, { needs_recheck: null }, { push: false, source: 'needs-recheck' }).catch(() => null);
        continue;
      }
      if (task.plugin_only || task.user_status?.state !== 'needs' || task.user_status.source !== 'session') continue;
      const armedCheck = (await triggersWatching(task.id)).some((t) => t.state === 'armed');
      if (!recheckDue(task, { nowMs, armedCheck, ...(ephemeral ? { notBefore: startedAt } : {}) })) continue;
      const ask = task.user_status!.ask!;
      const { getSessionsForTask } = await import('../session-tracker.js');
      const { pickDeliverySession } = await import('../routines/session-target.js');
      const target = pickDeliverySession(await getSessionsForTask(task.id).catch(() => []));
      if (!target) continue;
      const prev = task.needs_recheck;
      const next: NeedsRecheck = { at: new Date(nowMs).toISOString(), count: (prev?.count ?? 0) + 1, ask };
      // Recorded first: a failed wake never repeats every scan.
      await updateTaskRaw(task.id, { needs_recheck: next }, { push: false, source: 'needs-recheck' }).catch(() => null);
      const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js');
      const { sendMessageToSession } = await import('../session-message-queue.js');
      const { WAIT_UNTIL_SEND_SOURCE } = await import('../task-wait-until.js');
      try {
        await sendMessageToSession(target.claudeSessionId, buildWalnutMessage({
          kind: 'trigger',
          attrs: { from: 'Walnut: re-check', note: 'is what you asked the user still needed' },
          body: recheckBody(ask, task.user_status!.checkedAt, nowMs),
        }), { source: WAIT_UNTIL_SEND_SOURCE, taskId: task.id });
        woken.push(task.id);
        log.task.info('needs-you re-check sent', { taskId: task.id, sessionId: target.claudeSessionId, count: next.count });
      } catch (err) {
        log.task.warn('needs-you re-check not delivered', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    log.task.warn('needs-you re-check pass failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return woken;
}

export function startNeedsRecheck(opts: { ephemeral?: boolean } = {}): void {
  ephemeral = !!opts.ephemeral;
  startedAt = Date.now();
  if (timer) return;
  timer = setInterval(() => { void runNeedsRecheck(); }, SCAN_MS);
  timer.unref?.();
}

export function stopNeedsRecheck(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
