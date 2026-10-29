/**
 * The 4-hour re-check, for the decision letters a task sent the user (human-inbox/decision-settle.ts).
 *
 * The "needs you" re-check (needs-recheck.ts) reads a task's own status; a letter asking the user to
 * do something lives beside it and stayed open after the thing was done (2026-10-29: an "accept the
 * Apple agreement" letter outlived three shipped builds). Each pass, on the same clock:
 *
 *   - a COMPLETE task's open decision letters are settled (the completion edge does it at once,
 *     complete-archive.ts; this catches completions it missed: a restart, an older Walnut);
 *   - an open task whose decision letter nobody wrote in for NEEDS_RECHECK_MS gets ONE note in its
 *     session naming those letters: check whether each still needs the user, settle the ones that
 *     do not, keep the rest. Not a parked (WAITING) task, whose note would end its wait, and not
 *     one whose own "needs you" the needs re-check covers (its note asks it to settle the letter). At most MAX_RECHECKS in a row while letters stay open, recorded on the
 *     task first (`letter_recheck`), so a failed wake never repeats every scan.
 *
 * Primary only; an ephemeral server never wakes a task for a letter it copied from the real Walnut.
 */
import { log } from '../../logging/index.js';
import type { LetterRecord } from '../human-inbox/types.js';
import type { Task } from '../types.js';
import { agoWords, NEEDS_RECHECK_MS } from '../user-status.js';
import { MAX_RECHECKS } from './needs-recheck.js';

export interface LetterRecheck {
  /** When the last note went in (ISO). */
  at: string;
  /** Notes sent in a row while the task kept decision letters open. */
  count: number;
  /** The letters the last note named. */
  letters: string[];
}

/** The note the re-check brings into the session. Pure. */
export function letterRecheckBody(letters: readonly LetterRecord[], nowMs: number, activityAt: (l: LetterRecord) => number): string {
  const lines = letters.map((l) => `- "${l.subject}" (${l.id}), last written ${agoWords(nowMs - activityAt(l))}`);
  return [
    `Your ${letters.length === 1 ? 'letter asks' : 'letters ask'} the user for a decision, still unanswered:`,
    ...lines,
    'The user may have done it outside Walnut, or the blocker may have cleared on its own. Check each one now yourself (human_inbox_get reads it).',
    'No longer needed: settle it with one line the user reads, walnut tools call human_inbox_mark \'{"id":"<letter id>","settled":"<why nobody needs to answer>"}\', and carry on. '
      + 'Still needed: leave it; if a script can tell when it is done, arm a trigger on it (trigger_create, wait:false).',
  ].join('\n');
}

/** Whether a task is due a letter re-check now. Pure; exported for tests. */
export function letterRecheckDue(task: Pick<Task, 'letter_recheck'>, nowMs: number): boolean {
  const last = task.letter_recheck;
  if (!last) return true;
  if (last.count >= MAX_RECHECKS) return false;
  return nowMs - Date.parse(last.at) >= NEEDS_RECHECK_MS;
}

/** One pass. Exported for tests. Returns the letters it settled and the tasks it woke. */
export async function runLetterRecheck(
  nowMs = Date.now(),
  opts: { notBefore?: number } = {},
): Promise<{ settled: string[]; woken: string[] }> {
  const out = { settled: [] as string[], woken: [] as string[] };
  try {
    const { listLetters, settleLettersWhere } = await import('../human-inbox/store.js');
    const { isOpenDecision, letterActivityAt, completionSettleReason } = await import('../human-inbox/decision-settle.js');
    const { listTasks, listTasksByIds, updateTaskRaw } = await import('../task-manager.js');
    const open = (await listLetters({ archived: false })).letters.filter(isOpenDecision);
    const ids = [...new Set(open.map((l) => l.sender.taskId!))];
    const tasks = new Map((ids.length ? await listTasksByIds(ids) : []).map((t) => [t.id, t]));

    // Completions the edge missed.
    const settled = await settleLettersWhere((l) => {
      const task = l.sender?.taskId ? tasks.get(l.sender.taskId) : undefined;
      return task?.phase === 'COMPLETE' ? completionSettleReason(l, task) : null;
    });
    out.settled = settled.map((s) => s.id);
    if (settled.length) log.notif.info('human-inbox: settled decision letters of completed tasks', { letters: settled });
    const gone = new Set(out.settled);

    // A count left from letters that are all answered or settled now starts over.
    const stillOpen = new Set(open.filter((l) => !gone.has(l.id)).map((l) => l.sender.taskId!));
    for (const t of await listTasks()) {
      if (t.letter_recheck && !stillOpen.has(t.id)) {
        await updateTaskRaw(t.id, { letter_recheck: null }, { push: false, source: 'needs-recheck' }).catch(() => null);
      }
    }

    const byTask = new Map<string, LetterRecord[]>();
    for (const l of open) {
      if (gone.has(l.id)) continue;
      const at = letterActivityAt(l);
      if (nowMs - at < NEEDS_RECHECK_MS || (opts.notBefore !== undefined && at < opts.notBefore)) continue;
      const tid = l.sender.taskId!;
      byTask.set(tid, [...(byTask.get(tid) ?? []), l]);
    }
    for (const [taskId, letters] of byTask) {
      const task = tasks.get(taskId);
      if (!task || task.phase === 'COMPLETE' || task.plugin_only || !letterRecheckDue(task, nowMs)) continue;
      // Parked: it waits on something (its own trigger, a clock that asks it to check on waking),
      // and this note would end that wait. A "needs you" of its own gets the needs re-check, which
      // asks it to settle such a letter too: one note, not two.
      if (task.phase === 'WAITING') continue;
      if (task.user_status?.state === 'needs' && task.user_status.source === 'session' && task.user_status.ask) continue;
      const { getSessionsForTask } = await import('../session-tracker.js');
      const { pickDeliverySession } = await import('../routines/session-target.js');
      const target = pickDeliverySession(await getSessionsForTask(taskId).catch(() => []));
      if (!target) continue;
      const next: LetterRecheck = { at: new Date(nowMs).toISOString(), count: (task.letter_recheck?.count ?? 0) + 1, letters: letters.map((l) => l.id) };
      await updateTaskRaw(taskId, { letter_recheck: next }, { push: false, source: 'needs-recheck' }).catch(() => null);
      const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js');
      const { sendMessageToSession } = await import('../session-message-queue.js');
      const { WAIT_UNTIL_SEND_SOURCE } = await import('../task-wait-until.js');
      try {
        await sendMessageToSession(target.claudeSessionId, buildWalnutMessage({
          kind: 'trigger',
          attrs: { from: 'Walnut: re-check', note: 'do your letters to the user still need an answer' },
          body: letterRecheckBody(letters, nowMs, letterActivityAt),
        }), { source: WAIT_UNTIL_SEND_SOURCE, taskId });
        out.woken.push(taskId);
        log.task.info('letter re-check sent', { taskId, sessionId: target.claudeSessionId, letters: next.letters, count: next.count });
      } catch (err) {
        log.task.warn('letter re-check not delivered', { taskId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    log.task.warn('letter re-check pass failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return out;
}
