/**
 * A "needs you" is checked again on a timer (2026-10-28, the user: "I've already resolved some of
 * these. You should at least verify ... either report it up when it is resolved, or verify it
 * again after a while"; a sign-in he had finished in a terminal stayed on his list, and Main read
 * it to him as fact).
 *
 * A task whose status asks the user something in its own words (user_status `needs`, source
 * `session`) records when its session last said so (`checkedAt`, at a turn end). When that is
 * older than NEEDS_RECHECK_MS, its session gets ONE note: check whether the user did it outside
 * Walnut, carry on if so, and arm a check if one can be scripted. Its turn-end report then states
 * the ask again (checked now) or moves on. A trigger of the task does not exempt it: it watches
 * the task, maybe not this ask; one the session armed to watch it (trigger_create watches:"ask")
 * checks it each time it runs, which counts as the last check (user-status.ts stampChecked), so a
 * watch that keeps running keeps the re-check away and one that stopped running brings it back.
 * MAX_RECHECKS in a row every NEEDS_RECHECK_MS while it keeps asking the user (reworded or not),
 * then once a day (RECHECK_AFTER_CAP_MS), never stopping (2026-11-04, Main's reflection: asks sat
 * NOT VERIFIED for 18 to 21 hours, one for five days, until Main chased each one). Primary only; an
 * ephemeral server never wakes a task for a status it copied from the real Walnut. The task's open
 * decision letters to the user ride the same clock (letter-recheck.ts), and so does a Board choice
 * that asks the user about it: its Board owner is asked to confirm or remove it (choiceRecheckBody).
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { NEEDS_RECHECK_MS, agoWords } from '../user-status.js';
import { snoozeEndedMs } from '../snooze.js';
import { statusDecision } from '../ask-decision.js';

/** A "needs you" checked longer ago than this is checked again (user-status.ts reads it as not
 *  verified a little later, once the re-check had its turn). */
export { NEEDS_RECHECK_MS };
export const MAX_RECHECKS = 6;
/** After MAX_RECHECKS in a row, the re-check comes once a day: no ask reads NOT VERIFIED longer. */
export const RECHECK_AFTER_CAP_MS = 24 * 60 * 60_000;
const SCAN_MS = Math.min(10 * 60_000, NEEDS_RECHECK_MS / 4);
/** After boot, once the hosts had a moment to connect (the host checks read where tasks run). */
const BOOT_SWEEP_DELAY_MS = 30_000;

export interface NeedsRecheck {
  /** When the last re-check note went in (ISO). */
  at: string;
  /** Notes sent in a row while the task kept asking the user (in any words: a session rewords
   *  its ask at every turn). Cleared once its status no longer asks the user. */
  count: number;
  /** The ask the last note was about. */
  ask: string;
  /** Its decision (ask-decision.ts): another decision starts its own count; other words do not. */
  decision?: string;
}

/** The count of the next note: on from the last while the task asks the same decision, in any words. */
export function nextRecheckCount(prev: NeedsRecheck | null | undefined, decisionId: string | undefined): number {
  if (!prev) return 1;
  return prev.decision && decisionId && prev.decision !== decisionId ? 1 : prev.count + 1;
}

/** The note the re-check brings into the session. */
export function recheckBody(ask: string, checkedAt: string | undefined, nowMs: number, decisionId?: string): string {
  const at = Date.parse(checkedAt ?? '');
  return [
    `Your status asks the user: "${ask}"${decisionId ? ` (decision ${decisionId})` : ''}${Number.isFinite(at) ? `, last checked ${agoWords(nowMs - at)}` : ''}.`,
    'The user may have done it outside Walnut (a sign-in in a terminal, a tap on the phone, a review), and nothing told you. Check it now yourself: run the command, look for the file, read the letter, the review or the state it needed.',
    'Done: carry on with the work, and your report no longer asks it; if a letter of yours asked it, settle that letter (human_inbox_mark with "settled": one line saying why). '
      + 'Still needed and nothing changed: answer with only the agent-ack line, <walnut-turn status="agent-ack"/>, so the user\'s chat does not repeat the same status; your report still counts as checked now. '
      + 'If a script can tell when it is done, arm a trigger on it (trigger_create, wait:false, watches:"ask") so you hear the moment it is: each run of its check counts as this ask\'s check, and this re-check stays quiet while it keeps running.',
  ].join('\n');
}

/**
 * The note a Board choice's re-check brings into its Board owner's session (2026-10-31: a choice
 * nobody re-checked kept a task on the user's list a day after the task had moved on).
 */
export function choiceRecheckBody(
  choice: { board: string; id: string }, title: string,
  about: Pick<Task, 'id' | 'title' | 'user_status' | 'status_report'>, checkedAt: string | undefined, nowMs: number,
): string {
  const at = Date.parse(checkedAt ?? '');
  const own = about.status_report?.ask ?? about.status_report?.now;
  return [
    `The choice "${title}" (id ${choice.id}) on your Board asks the user about "${about.title}" (${about.id}), ${Number.isFinite(at) ? `and nobody confirmed it since it was written ${agoWords(nowMs - at)}` : 'and no one ever confirmed it (no time recorded)'}.`,
    own ? `That task's own latest words: "${own.replace(/\s+/g, ' ').slice(0, 300)}".` : '',
    'The task may have moved on, or the user may have answered it elsewhere (in the task\'s chat, on the phone). Check it now: read the task (task_get) and its latest messages.',
    `No longer needed: remove the <walnut-choice id="${choice.id}"> from your Board (board_edit). Still needed: set its checked attribute to the time now (board_edit on its tag, checked="${new Date(nowMs).toISOString().slice(0, 16)}Z"), which records it as checked now. `
      + 'Then answer with only the agent-ack line, <walnut-turn status="agent-ack"/>, unless something needs saying.',
  ].filter(Boolean).join('\n');
}

/** A stable point in the re-check window for one task (FNV-1a of its id). */
function spreadOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return h % NEEDS_RECHECK_MS;
}

/** Whether a task is due a re-check now. Pure; exported for tests. */
export function recheckDue(task: Pick<Task, 'phase' | 'status' | 'user_status' | 'needs_recheck'> & { id?: string }, opts: {
  nowMs: number; notBefore?: number;
  /** Since when a choice with no recorded time has been seen (this server's start): each is due
   *  at its own point of the re-check window after it, so a Board stored before the times were
   *  kept does not wake every owner in the first pass. */
  unknownSince?: number;
  /** When a snooze of the task ran out (snooze.ts snoozeEndedMs): the clock starts again there. */
  snoozeEndedMs?: number;
}): boolean {
  const s = task.user_status;
  if (!s || s.state !== 'needs' || (s.source !== 'session' && s.source !== 'choice') || !s.ask || s.snoozed) return false;
  if (task.phase === 'COMPLETE' || task.status === 'done') return false;
  // Stamped only on an ask the session wrote itself (user-status.ts stampChecked), or on a Board
  // choice when it was written (stampChoiceChecked; one with no time was never checked). A snooze
  // that ran out since counts as the last look: the user put it away until then (snooze.ts).
  const stamped = Date.parse(s.checkedAt ?? '')
    || (s.source === 'choice' ? (opts.unknownSince ?? 0) + spreadOf(task.id ?? '') - NEEDS_RECHECK_MS : NaN);
  const checked = Number.isFinite(opts.snoozeEndedMs) && opts.snoozeEndedMs! > stamped ? opts.snoozeEndedMs! : stamped;
  if (!Number.isFinite(checked) || opts.nowMs - checked < NEEDS_RECHECK_MS) return false;
  if (opts.notBefore !== undefined && checked < opts.notBefore) return false;
  const last = task.needs_recheck;
  if (last) {
    // Another decision has its own count; the same in other words carries on (ask-decision.ts).
    const gap = nextRecheckCount(last, statusDecision(s)?.id) > MAX_RECHECKS ? RECHECK_AFTER_CAP_MS : NEEDS_RECHECK_MS;
    if (opts.nowMs - Date.parse(last.at) < gap) return false;
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
    const all = await listTasks();
    const byId = new Map(all.map((t) => [t.id, t] as const));
    // A team stopped or quieted in one step (team-stop.ts) is not woken by a timer until it is resumed.
    const quieted = new Set(all.flatMap((t) => (t.team_stop?.members ?? []).map((m) => m.id)));
    // The org is off (org/org-enabled.ts): Main and the VPs are not woken to re-check a Board choice.
    const { isOrgEnabled, isOrgNode } = await import('../org/org-enabled.js');
    const orgOff = !(await isOrgEnabled());
    for (const task of all) {
      // It no longer asks the user (it waits on something else, or is done): the next ask starts a
      // fresh count. Working is not that: a re-check turn runs as Working.
      const left = task.user_status?.state === 'waiting' || task.user_status?.state === 'read' || task.user_status?.state === 'done' || task.phase === 'COMPLETE';
      if (task.needs_recheck && left && !task.user_status?.transient) {
        await updateTaskRaw(task.id, { needs_recheck: null }, { push: false, source: 'needs-recheck' }).catch(() => null);
        continue;
      }
      const source = task.user_status?.source;
      if (task.plugin_only || task.user_status?.state !== 'needs' || (source !== 'session' && source !== 'choice')) continue;
      // A trigger of the task does not exempt it (it watches the task, maybe not this ask); one the
      // session armed to watch this ask stamps its check (recheck-watch.ts, stampChecked).
      if (!recheckDue(task, { nowMs, snoozeEndedMs: snoozeEndedMs(task, byId, nowMs), unknownSince: startedAt || nowMs, ...(ephemeral ? { notBefore: startedAt } : {}) })) continue;
      if (quieted.has(task.id)) continue;
      // A trigger watching the ask needs no skip here: each run it makes is the ask's last check
      // (checkedAt), so it is due only once that trigger stopped checking (2026-11-04: a skip on
      // any live watch kept asks NOT VERIFIED for days behind triggers that checked nothing new).
      const ask = task.user_status!.ask!;
      // A Board choice is its Board owner's to confirm or remove: that session gets the note.
      const choice = source === 'choice' ? task.user_status!.choice : undefined;
      if (source === 'choice' && !choice) continue;
      const owner = choice ? byId.get(choice.board) : task;
      if (!owner || owner.phase === 'COMPLETE' || owner.status === 'done') continue;
      if (orgOff && isOrgNode(owner)) continue;
      const { getSessionsForTask } = await import('../session-tracker.js');
      const { pickDeliverySession } = await import('../routines/session-target.js');
      const target = pickDeliverySession(await getSessionsForTask(owner.id).catch(() => []));
      if (!target) continue;
      const prev = task.needs_recheck;
      const decision = statusDecision(task.user_status)?.id;
      const next: NeedsRecheck = { at: new Date(nowMs).toISOString(), count: nextRecheckCount(prev, decision), ask, ...(decision ? { decision } : {}) };
      // Recorded first: a failed wake never repeats every scan.
      await updateTaskRaw(task.id, { needs_recheck: next }, { push: false, source: 'needs-recheck' }).catch(() => null);
      const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js');
      const { sendMessageToSession } = await import('../session-message-queue.js');
      const { WAIT_UNTIL_SEND_SOURCE } = await import('../task-wait-until.js');
      try {
        await sendMessageToSession(target.claudeSessionId, buildWalnutMessage({
          kind: 'trigger',
          attrs: { from: 'Walnut: re-check', note: choice ? 'is the choice on your Board still needed' : 'is what you asked the user still needed' },
          body: choice ? choiceRecheckBody(choice, ask, task, task.user_status!.checkedAt, nowMs) : recheckBody(ask, task.user_status!.checkedAt, nowMs, decision),
        // A Board owner asked about a choice only gives words: its own wait comes back (task-wait-resume.ts).
        }), { source: choice ? 'choice-recheck' : WAIT_UNTIL_SEND_SOURCE, taskId: owner.id });
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

let bootTimer: ReturnType<typeof setTimeout> | null = null;

export function startNeedsRecheck(opts: { ephemeral?: boolean } = {}): void {
  ephemeral = !!opts.ephemeral;
  startedAt = Date.now();
  if (timer) return;
  // Walnut's own letters nobody needs any more go at boot too, not 10 minutes later (walnut-letters/sweep.ts).
  bootTimer = setTimeout(() => {
    bootTimer = null;
    if (ephemeral || !timer) return;
    void import('../human-inbox/walnut-letters/sweep.js').then((m) => m.settleUnneededWalnutLetters())
      .catch((err) => log.task.warn('Walnut letter sweep at boot failed', { error: err instanceof Error ? err.message : String(err) }));
  }, BOOT_SWEEP_DELAY_MS);
  bootTimer.unref?.();
  timer = setInterval(() => {
    void runNeedsRecheck();
    // The task's decision letters to the user, on the same clock (letter-recheck.ts).
    void import('./letter-recheck.js')
      .then((m) => m.runLetterRecheck(Date.now(), ephemeral ? { notBefore: startedAt } : {}))
      .catch((err) => log.task.warn('letter re-check not loaded', { error: err instanceof Error ? err.message : String(err) }));
  }, SCAN_MS);
  timer.unref?.();
}

export function stopNeedsRecheck(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = null;
}
