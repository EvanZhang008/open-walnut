/**
 * Telling the team a trigger's check is in trouble (2026-10-09: a check failed five
 * times in a row over one over-long item id, the trigger was switched off, and the
 * only sign of it was a bell nobody opened for 20 hours).
 *
 * A trigger is a task's own work, so its trouble goes to that task, never to the
 * user (2026-11-02, the user: a completed task's trigger lost its check script and
 * Walnut wrote him an English letter, "Trigger ... stopped after 5 failed checks";
 * the notice goes to the task that owns it or that task's lead). Who hears what,
 * decided under the store lock in cron/trigger-apply.ts (`checkHealth`) and sent
 * from here:
 *   - the FIRST failure of a run tells the owning task's session, with the error,
 *     the trigger id and the run time, so the agent that wrote the script fixes it
 *     (at most once per 6h: a source that fails now and then must not wake it every
 *     time);
 *   - failures that go on (3 checks, or 30 minutes) tell the owner again, once per
 *     run of failures, or its lead when the owner cannot be told;
 *   - a trigger switched off tells the owner, or its lead, and a WAITING task it
 *     would have woken goes back to Needs Action;
 *   - a quiet check whose output the daemon had to repair (an over-long id, a
 *     dropped item) tells a live owner session once a day; a fire's envelope already
 *     carries its own repairs.
 * "Its lead" is the first open task above the owner that has a session, in the order
 * a status move goes up (status-push.ts `statusFollowersOf`: its parent chain, its
 * project's VP, Main last). Nobody to tell is only logged: the trigger shows its
 * state in Routines. Nothing here writes a letter or a bell (ratchet:
 * tests/core/routines/trigger-user-notice-ratchet.test.ts).
 * Nothing here throws: it runs inside the daemon socket handler.
 */

import { log } from '../../logging/index.js';
import { MAX_CONSECUTIVE_CHECK_ERRORS } from '../../providers/trigger-check-core.js';
import type { TriggerCheckedEvent } from '../../providers/trigger-check-core.js';
import type { TriggerCheckedApplied } from '../cron/trigger-apply.js';
import { createEnvelopeKit } from '../peers/envelope-kit.js';
import type { Task } from '../types.js';
import { isLiveSessionStatus, pickDeliverySession } from './session-target.js';
import { limitAdvice, timeLimitSeconds } from '../cron/trigger-time-limit.js';

const kit = createEnvelopeKit();
/** envelope-kit.ts NOTE_NOTIFICATION: the note every Walnut status notice carries. */
const NOTE_NOTIFICATION = 'automated Walnut status notice';
const NOTICE_SOURCE = 'walnut-notify';
const ERROR_TEXT_MAX = 1_500;
const RUN_TEXT_MAX = 300;

type Applied = TriggerCheckedApplied & { found: true };

/**
 * Who a notice reaches:
 *   - `owner`: the owning task's session, while the task is open (a stopped one is resumed);
 *   - `live-owner`: only a live session of the open owner, never woken;
 *   - `team`: the owner, else its lead;
 *   - `above`: its lead only (what failed is the delivery into the owner itself).
 */
export type TriggerNoticeReach = 'owner' | 'live-owner' | 'team' | 'above';

/** Who reads a notice: the owner, or a task above it reading about its owner. */
export type TriggerNoticeAudience =
  | { kind: 'owner' }
  | { kind: 'lead'; owner: Pick<Task, 'id' | 'title' | 'phase' | 'status'> };

export interface TriggerTold {
  to: 'owner' | 'lead' | null;
  taskId?: string;
  sessionId?: string;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function hostLabel(host: string | undefined): string {
  return !host || host === '__local__' ? 'this machine' : host;
}

function at(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'an unknown time';
}

/** The stored error first: it says a deadline kill as one, with the limit (trigger-time-limit.ts). */
function errorOf(event: TriggerCheckedEvent, applied: Applied): string {
  return clip((applied.error ?? event.error ?? '').trim() || 'unknown error', ERROR_TEXT_MAX);
}

/** How long the failed run took, or that the limit cut it off. */
function ranFor(event: TriggerCheckedEvent, applied: Applied): string {
  if (applied.killedAtLimit) return `: the daemon killed it at its ${applied.timeLimitSeconds ?? '?'} s time limit`;
  return Number.isFinite(event.durationMs) ? ` after ${event.durationMs} ms` : '';
}

function testLine(applied: Applied, id: string): string {
  const args = JSON.stringify({ run: applied.checkRun ?? '', id });
  return `  walnut tools call trigger_test '${args.replace(/'/g, "'\\''")}'`;
}

const isOpen = (t: Pick<Task, 'phase' | 'status'>): boolean => t.phase !== 'COMPLETE' && t.status !== 'done';

/** `the trigger "X" (id) of your team's task "T" (tid), which is complete` */
function ofOwner(name: string, id: string, audience: TriggerNoticeAudience & { kind: 'lead' }): string {
  const why = isOpen(audience.owner) ? 'has no session that could be told' : 'is complete';
  return `the trigger "${name}" (${id}) of your team's task "${clip(audience.owner.title, 120)}" (${audience.owner.id}), which ${why}`;
}

const upper = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The text a session reads when a trigger's check failed, keeps failing, or was stopped. */
export function buildCheckFailureNotice(
  event: TriggerCheckedEvent,
  applied: Applied,
  stage: 'failed' | 'failing' | 'disabled',
  audience: TriggerNoticeAudience = { kind: 'owner' },
): string {
  const name = applied.jobName ?? event.id;
  const errors = applied.consecutiveErrors ?? 1;
  const since = applied.errorSinceMs ?? event.atMs;
  const owner = audience.kind === 'owner';
  const mine = `your trigger "${name}" (${event.id})`;
  const theirs = audience.kind === 'lead' ? ofOwner(name, event.id, audience) : '';
  const lead = stage === 'disabled'
    ? `Walnut stopped ${owner ? mine : theirs}: its check on ${hostLabel(applied.host)} failed `
      + `${errors} times in a row, from ${at(since)} to ${at(event.atMs)}. It no longer runs.`
    : stage === 'failing'
      ? `${upper(owner ? mine : `${theirs},`)} keeps failing: ${errors} checks in a row failed on ${hostLabel(applied.host)} `
        + `since ${at(since)}. At ${MAX_CONSECUTIVE_CHECK_ERRORS} failures in a row Walnut stops it.`
      : `${owner ? upper(mine) : `${upper(theirs)}: its`} check failed on ${hostLabel(applied.host)} at ${at(event.atMs)}`
        + `${ranFor(event, applied)}. `
        + `After ${MAX_CONSECUTIVE_CHECK_ERRORS} failures in a row Walnut stops the trigger.`;
  const resume = `  walnut tools call trigger_resume '{"id":"${event.id}"}'`;
  const next = stage === 'disabled'
    ? owner
      ? ['Next: fix the check, try it, then start the trigger again:', testLine(applied, event.id), resume]
      : ['Next: if the work still needs this watch, fix the check, try it and start it again:', testLine(applied, event.id), resume,
        `If it does not, delete it:\n  walnut tools call trigger_delete '{"id":"${event.id}"}'`]
    : owner
      ? ['Next: fix the check script and try it; the next scheduled check runs the fixed script:', testLine(applied, event.id)]
      : ['Next: fix the check script and try it, or pause the trigger if the work no longer needs it:', testLine(applied, event.id),
        `  walnut tools call trigger_pause '{"id":"${event.id}"}'`];
  const titles = { failed: 'Trigger check failed', failing: 'Trigger keeps failing', disabled: 'Trigger stopped' } as const;
  const outcomes = { failed: 'check_failed', failing: 'check_failing', disabled: 'trigger_disabled' } as const;
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: { from: `Trigger: ${name}`, title: titles[stage], outcome: outcomes[stage], note: NOTE_NOTIFICATION },
    body: [
      lead,
      `Error:\n${errorOf(event, applied)}`,
      ...(applied.checkRun ? [`The check runs: ${clip(applied.checkRun, RUN_TEXT_MAX)}`] : []),
      ...(applied.killedAtLimit ? [limitAdvice(applied.timeLimitSeconds ?? timeLimitSeconds(null))] : []),
      next.join('\n'),
    ].join('\n\n'),
  });
}

/** The text a live session reads when the daemon had to repair its check's output. */
export function buildRepairNotice(event: TriggerCheckedEvent, applied: Applied, warnings: readonly string[]): string {
  const name = applied.jobName ?? event.id;
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: { from: `Trigger: ${name}`, title: 'Trigger output repaired', outcome: 'check_repaired', note: NOTE_NOTIFICATION },
    body: [
      `Your trigger "${name}" (${event.id}) check at ${at(event.atMs)} broke the output contract, and the daemon `
        + 'repaired it, so the run still counted. Fix the script so it stops needing repairs (you hear this at most once a day):',
      warnings.map((w) => `- ${w}`).join('\n'),
      `Try it:\n${testLine(applied, event.id)}`,
    ].join('\n\n'),
  });
}

/**
 * Any other trouble of a task's trigger or routine (it could not deliver a fire, its
 * target is complete, a host refused to start its session, its fire budget holds it
 * back), worded for whoever reads it.
 */
export function buildTriggerTroubleNotice(input: {
  jobId: string; jobName: string; title: string; body: string; next?: string; outcome: string;
}, audience: TriggerNoticeAudience): string {
  const subject = audience.kind === 'owner'
    ? `Your trigger "${input.jobName}" (${input.jobId})`
    : upper(ofOwner(input.jobName, input.jobId, audience));
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: { from: `Trigger: ${input.jobName}`, title: input.title, outcome: input.outcome, note: NOTE_NOTIFICATION },
    body: [`${subject}: ${input.body.trim()}`, ...(input.next ? [input.next] : [])].join('\n\n'),
  });
}

/** A routine's trouble with no trigger fields at hand (the session executor's): its title and the problem. */
export function buildRoutineTroubleNotice(input: { title: string; body: string }, audience: TriggerNoticeAudience): string {
  const about = audience.kind === 'owner'
    ? ''
    : ` (your team's task "${clip(audience.owner.title, 120)}" (${audience.owner.id}), which ${isOpen(audience.owner) ? 'has no session that could be told' : 'is complete'})`;
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut routines', title: clip(input.title, 120), outcome: 'routine_trouble', note: NOTE_NOTIFICATION },
    body: `${input.title}${about}${input.body.trim() ? `: ${input.body.trim()}` : '.'}`,
  });
}

/**
 * Deliver into one task's best session. `liveOnly` never resumes a stopped one. A failed
 * delivery answers null, so the next task up is tried.
 */
async function deliverToTask(taskId: string, host: string | undefined, text: string, liveOnly: boolean): Promise<string | null> {
  try {
    const { getSessionsForTask } = await import('../session-tracker.js');
    const sessions = await getSessionsForTask(taskId).catch(() => []);
    const target = pickDeliverySession(sessions, host ? { reachableHost: host } : {});
    if (!target || (liveOnly && !isLiveSessionStatus(target.process_status))) return null;
    const { deliverToSession } = await import('../sessions/session-send-core.js');
    await deliverToSession(target, { busText: text, enqueueText: text, source: NOTICE_SOURCE, taskId });
    return target.claudeSessionId;
  } catch (err) {
    log.cron.warn('trigger notice to session failed', { taskId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Tell the task that owns a trigger, or its lead, about the trigger's trouble. Never
 * the user. Returns who got it; nobody (a gone task, no session anywhere) is logged.
 */
export async function tellTriggerTeam(input: {
  taskId: string | undefined;
  jobId: string;
  /** The host that reported (a session there is reachable now). */
  host?: string;
  reach: TriggerNoticeReach;
  text: (audience: TriggerNoticeAudience) => string;
}): Promise<TriggerTold> {
  const nobody = (why: string): TriggerTold => {
    log.cron.info('trigger notice: nobody to tell', { jobId: input.jobId, taskId: input.taskId, reach: input.reach, why });
    return { to: null };
  };
  if (!input.taskId) return nobody('no task');
  try {
    const { getTask, listTasks } = await import('../task-manager.js');
    const owner = await getTask(input.taskId).catch(() => null);
    if (!owner) return nobody('task gone');
    if (input.reach !== 'above' && isOpen(owner)) {
      const sid = await deliverToTask(owner.id, input.host, input.text({ kind: 'owner' }), input.reach === 'live-owner');
      if (sid) return { to: 'owner', taskId: owner.id, sessionId: sid };
    }
    if (input.reach === 'owner' || input.reach === 'live-owner') return nobody('owner cannot be told');
    const { followContext, statusFollowersOf } = await import('../sessions/status-push.js');
    const { byId, vpOf, main } = await followContext(await listTasks());
    const text = input.text({ kind: 'lead', owner });
    // A lead with a live session hears it; a stopped one is never woken for it (a stopped parent
    // is not woken for a state notice), the next lead up is tried. Main is not a task's lead.
    for (const lead of statusFollowersOf(owner, byId, vpOf, main)) {
      if (!isOpen(lead) || lead.org_role === 'main') continue;
      const sid = await deliverToTask(lead.id, undefined, text, true);
      if (sid) return { to: 'lead', taskId: lead.id, sessionId: sid };
    }
    return nobody('no open lead above it has a live session');
  } catch (err) {
    log.cron.warn('trigger notice failed', { jobId: input.jobId, taskId: input.taskId, error: err instanceof Error ? err.message : String(err) });
    return { to: null };
  }
}

/** Notices told recently, by key: a fire that keeps meeting the same problem tells it once a day. */
const toldAt = new Map<string, number>();
const TOLD_AGAIN_AFTER_MS = 24 * 60 * 60 * 1000;
const TOLD_MAX = 2_000;

/** Whether `key` was told within the last day; marks it told when not. */
export function toldRecently(key: string, now = Date.now()): boolean {
  const was = toldAt.get(key);
  if (was !== undefined && now - was < TOLD_AGAIN_AFTER_MS) return true;
  if (toldAt.size >= TOLD_MAX) toldAt.clear();
  toldAt.set(key, now);
  return false;
}

/** Test seam. */
export function _resetTriggerNoticesForTest(): void {
  toldAt.clear();
}

/** The bells an older Walnut put in front of the user for a failing or stopped trigger. */
const legacyBellKeys = (id: string): string[] => [`trigger-failing:${id}`, `trigger-disabled:${id}`];

/**
 * A check worked again (a fire is one), or the trigger stopped: a "keeps failing" bell an
 * older Walnut left is out of date. Taking one back is all this does; nothing new is sent.
 */
export async function dismissFailingNotice(id: string): Promise<void> {
  try {
    const { dismissNotifications } = await import('../notifications/store.js');
    await dismissNotifications({ dedupKeys: legacyBellKeys(id) });
  } catch { /* a stale bell is harmless */ }
}

/** Everything a checked report owes the team. Called after the store write; never throws. */
export async function reportTriggerHealth(event: TriggerCheckedEvent, applied: Applied): Promise<void> {
  const base = { taskId: applied.targetTaskId, jobId: event.id, host: applied.host };
  if (applied.disabled) {
    const told = await tellTriggerTeam({ ...base, reach: 'team', text: (a) => buildCheckFailureNotice(event, applied, 'disabled', a) });
    // The task waited on this trigger. Told, its session (or its lead) decides what comes next;
    // nobody told, it waits on nothing now and is handed back, quietly: no push, no unread
    // (2026-11-02: a stopped trigger's trouble reached the user).
    let handedBack = false;
    if (told.to !== 'owner') {
      const { handBackWaitingTaskOfDisabledTrigger } = await import('../task-wait-until.js');
      handedBack = await handBackWaitingTaskOfDisabledTrigger(event.id, event.error, { notify: false, quiet: true })
        .catch((err) => {
          log.cron.warn('hand-back after trigger disable failed', { jobId: event.id, error: err instanceof Error ? err.message : String(err) });
          return false;
        });
    }
    await dismissFailingNotice(event.id);
    log.cron.warn('trigger disabled: told', { jobId: event.id, told: told.to, toldTask: told.taskId, handedBack });
    return;
  }
  if (applied.recovered) await dismissFailingNotice(event.id);
  if (applied.tellSessionError) {
    const told = await tellTriggerTeam({ ...base, reach: 'owner', text: (a) => buildCheckFailureNotice(event, applied, 'failed', a) });
    log.cron.info('trigger check failed: session told', { jobId: event.id, told: told.to === 'owner' });
  }
  if (applied.tellFailing) {
    const told = await tellTriggerTeam({ ...base, reach: 'team', text: (a) => buildCheckFailureNotice(event, applied, 'failing', a) });
    log.cron.info('trigger keeps failing: told', { jobId: event.id, told: told.to, toldTask: told.taskId });
  }
  if (applied.warningsToTell?.length) {
    const told = await tellTriggerTeam({ ...base, reach: 'live-owner', text: () => buildRepairNotice(event, applied, applied.warningsToTell!) });
    log.cron.info('trigger output repaired: session told', { jobId: event.id, told: told.to === 'owner' });
  }
}
