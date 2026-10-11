/**
 * Telling people a trigger's check is in trouble (2026-10-09: a check failed five
 * times in a row over one over-long item id, the trigger was switched off, and the
 * only sign of it was a bell nobody opened for 20 hours).
 *
 * Who hears what, decided under the store lock in cron/trigger-apply.ts
 * (`checkHealth`) and sent from here:
 *   - the FIRST failure of a run tells the target task's session, with the error,
 *     the trigger id and the run time, so the agent that wrote the script fixes it
 *     (at most once per 6h: a source that fails now and then must not wake it every
 *     time);
 *   - failures that go on (3 checks, or 30 minutes) put a bell in front of the user,
 *     one per run of failures, refreshed (not added) by the next run;
 *   - a trigger switched off always tells the session and sends the user a letter,
 *     and a WAITING task it would have woken goes back to Needs Action;
 *   - a quiet check whose output the daemon had to repair (an over-long id, a
 *     dropped item) tells a live session once a day; a fire's envelope already
 *     carries its own repairs.
 * Nothing here throws: it runs inside the daemon socket handler.
 */

import { log } from '../../logging/index.js';
import { MAX_CONSECUTIVE_CHECK_ERRORS } from '../../providers/trigger-check-core.js';
import type { TriggerCheckedEvent } from '../../providers/trigger-check-core.js';
import type { TriggerCheckedApplied } from '../cron/trigger-apply.js';
import { createEnvelopeKit } from '../peers/envelope-kit.js';
import { isLiveSessionStatus, pickDeliverySession } from './session-target.js';

const kit = createEnvelopeKit();
/** envelope-kit.ts NOTE_NOTIFICATION: the note every Walnut status notice carries. */
const NOTE_NOTIFICATION = 'automated Walnut status notice';
const NOTICE_SOURCE = 'walnut-notify';
const ERROR_TEXT_MAX = 1_500;
const RUN_TEXT_MAX = 300;

export const failingNoticeKey = (id: string): string => `trigger-failing:${id}`;
export const disabledNoticeKey = (id: string): string => `trigger-disabled:${id}`;

type Applied = TriggerCheckedApplied & { found: true };

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function hostLabel(host: string | undefined): string {
  return !host || host === '__local__' ? 'this machine' : host;
}

function at(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'an unknown time';
}

function errorOf(event: TriggerCheckedEvent, applied: Applied): string {
  return clip((event.error ?? applied.error ?? '').trim() || 'unknown error', ERROR_TEXT_MAX);
}

function testLine(applied: Applied, id: string): string {
  const args = JSON.stringify({ run: applied.checkRun ?? '', id });
  return `  walnut tools call trigger_test '${args.replace(/'/g, "'\\''")}'`;
}

/** The text the target task's session reads when its trigger's check failed or was stopped. */
export function buildCheckFailureNotice(event: TriggerCheckedEvent, applied: Applied, disabled: boolean): string {
  const name = applied.jobName ?? event.id;
  const errors = applied.consecutiveErrors ?? 1;
  const since = applied.errorSinceMs ?? event.atMs;
  const lead = disabled
    ? `Walnut stopped your trigger "${name}" (${event.id}): its check on ${hostLabel(applied.host)} failed `
      + `${errors} times in a row, from ${at(since)} to ${at(event.atMs)}. It no longer runs, and the user was sent a letter.`
    : `Your trigger "${name}" (${event.id}) check failed on ${hostLabel(applied.host)} at ${at(event.atMs)}`
      + `${Number.isFinite(event.durationMs) ? ` after ${event.durationMs} ms` : ''}. `
      + `After ${MAX_CONSECUTIVE_CHECK_ERRORS} failures in a row Walnut stops the trigger.`;
  const next = disabled
    ? ['Next: fix the check, try it, then start the trigger again:', testLine(applied, event.id),
      `  walnut tools call trigger_resume '{"id":"${event.id}"}'`]
    : ['Next: fix the check script and try it; the next scheduled check runs the fixed script:', testLine(applied, event.id)];
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: {
      from: `Trigger: ${name}`,
      title: disabled ? 'Trigger stopped' : 'Trigger check failed',
      outcome: disabled ? 'trigger_disabled' : 'check_failed',
      note: NOTE_NOTIFICATION,
    },
    body: [
      lead,
      `Error:\n${errorOf(event, applied)}`,
      ...(applied.checkRun ? [`The check runs: ${clip(applied.checkRun, RUN_TEXT_MAX)}`] : []),
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
 * Deliver a notice into the target task's session. `liveOnly` never resumes a
 * stopped one. Returns whether a session got it.
 */
async function tellSession(taskId: string | undefined, host: string | undefined, text: string, liveOnly: boolean): Promise<boolean> {
  if (!taskId) return false;
  try {
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(taskId).catch(() => null);
    if (!task || task.phase === 'COMPLETE') return false;
    const { getSessionsForTask } = await import('../session-tracker.js');
    const sessions = await getSessionsForTask(taskId).catch(() => []);
    const target = pickDeliverySession(sessions, host ? { reachableHost: host } : {});
    if (!target || (liveOnly && !isLiveSessionStatus(target.process_status))) return false;
    const { deliverToSession } = await import('../sessions/session-send-core.js');
    await deliverToSession(target, { busText: text, enqueueText: text, source: NOTICE_SOURCE, taskId });
    return true;
  } catch (err) {
    log.cron.warn('trigger notice to session failed', { taskId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

async function bell(input: { dedupKey: string; title: string; body: string; taskId?: string; severity: 'warning' | 'error' }): Promise<void> {
  try {
    const { upsertNotification } = await import('../notifications/store.js');
    await upsertNotification({
      kind: 'cron',
      severity: input.severity,
      title: input.title,
      body: input.body,
      dedupKey: input.dedupKey,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    });
  } catch (err) {
    log.cron.warn('trigger notification failed', { dedupKey: input.dedupKey, error: err instanceof Error ? err.message : String(err) });
  }
}

async function dismiss(keys: string[]): Promise<void> {
  try {
    const { dismissNotifications } = await import('../notifications/store.js');
    await dismissNotifications({ dedupKeys: keys });
  } catch { /* a stale bell is harmless */ }
}

/** A check worked again (a fire is one): the "keeps failing" bell is out of date. */
export async function dismissFailingNotice(id: string): Promise<void> {
  await dismiss([failingNoticeKey(id)]);
}

/** The letter a stopped trigger sends the user. */
export function disabledLetterMarkdown(event: TriggerCheckedEvent, applied: Applied, sessionTold: boolean, handedBack: boolean): string {
  const name = applied.jobName ?? event.id;
  const since = applied.errorSinceMs ?? event.atMs;
  const done = sessionTold
    ? 'Its task\'s session was told and asked to fix the check and start it again; if it does, there is nothing left for you to do.'
    : 'Its task has no session that could be told, so it waits for you.';
  return [
    `The trigger **${name}** (\`${event.id}\`) on ${hostLabel(applied.host)} stopped polling: its check failed `
      + `${applied.consecutiveErrors ?? MAX_CONSECUTIVE_CHECK_ERRORS} times in a row, from ${at(since)} to ${at(event.atMs)}.`,
    `Last error:\n\n~~~\n${errorOf(event, applied).replace(/~~~/g, '~ ~ ~')}\n~~~`,
    done + (handedBack ? ' The task was waiting on this trigger and is back in Needs Action.' : ''),
    'To start it again, use Resume on the trigger in Routines once the check is fixed.',
  ].join('\n\n');
}

async function sendDisabledLetter(event: TriggerCheckedEvent, applied: Applied, sessionTold: boolean, handedBack: boolean): Promise<boolean> {
  try {
    const { sendLetter } = await import('../human-inbox/store.js');
    await sendLetter({
      subject: `Trigger "${clip(applied.jobName ?? event.id, 120)}" stopped after ${applied.consecutiveErrors ?? MAX_CONSECUTIVE_CHECK_ERRORS} failed checks`,
      type: 'review',
      markdown: disabledLetterMarkdown(event, applied, sessionTold, handedBack),
      ...(applied.targetTaskId ? { taskRefs: [applied.targetTaskId] } : {}),
      sender: { sessionId: 'external', host: 'local' },
    });
    return true;
  } catch (err) {
    log.cron.warn('trigger disabled letter failed', { jobId: event.id, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Everything a checked report owes people. Called after the store write; never throws. */
export async function reportTriggerHealth(event: TriggerCheckedEvent, applied: Applied): Promise<void> {
  const name = applied.jobName ?? event.id;
  if (applied.disabled) {
    const { handBackWaitingTaskOfDisabledTrigger } = await import('../task-wait-until.js');
    const handedBack = await handBackWaitingTaskOfDisabledTrigger(event.id, event.error, { notify: false })
      .catch((err) => {
        log.cron.warn('hand-back after trigger disable failed', { jobId: event.id, error: err instanceof Error ? err.message : String(err) });
        return false;
      });
    const sessionTold = await tellSession(applied.targetTaskId, applied.host, buildCheckFailureNotice(event, applied, true), false);
    await dismiss([failingNoticeKey(event.id)]);
    const lettered = await sendDisabledLetter(event, applied, sessionTold, handedBack);
    // The letter makes its own bell; this one is for when the letter could not be sent.
    if (!lettered) {
      await bell({
        dedupKey: disabledNoticeKey(event.id),
        title: `Trigger "${name}" was disabled`,
        body: `${applied.consecutiveErrors ?? MAX_CONSECUTIVE_CHECK_ERRORS} check errors in a row on ${hostLabel(applied.host)}. Last error: ${errorOf(event, applied)}`,
        severity: 'error',
        ...(applied.targetTaskId ? { taskId: applied.targetTaskId } : {}),
      });
    }
    log.cron.warn('trigger disabled: told', { jobId: event.id, sessionTold, handedBack, lettered });
    return;
  }
  if (applied.recovered) await dismiss([failingNoticeKey(event.id)]);
  if (applied.tellSessionError) {
    const told = await tellSession(applied.targetTaskId, applied.host, buildCheckFailureNotice(event, applied, false), false);
    log.cron.info('trigger check failed: session told', { jobId: event.id, told });
  }
  if (applied.tellUserFailing) {
    const since = applied.errorSinceMs ?? event.atMs;
    await bell({
      dedupKey: failingNoticeKey(event.id),
      title: `Trigger "${name}" keeps failing`,
      body: `${applied.consecutiveErrors ?? 0} checks in a row failed on ${hostLabel(applied.host)} since ${at(since)}; `
        + `at ${MAX_CONSECUTIVE_CHECK_ERRORS} it stops. Last error: ${clip(errorOf(event, applied), 400)}`,
      severity: 'warning',
      ...(applied.targetTaskId ? { taskId: applied.targetTaskId } : {}),
    });
  }
  if (applied.warningsToTell?.length) {
    const told = await tellSession(applied.targetTaskId, applied.host, buildRepairNotice(event, applied, applied.warningsToTell), true);
    log.cron.info('trigger output repaired: session told', { jobId: event.id, told });
  }
}
