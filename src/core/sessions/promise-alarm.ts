/**
 * Every promise gets an alarm (2026-10-28, the Grok Bot study, borrow point d: "Follow-ups are
 * records, not promises"; its users lost every "I'll get back to you" that nothing woke up).
 *
 * When a lead's or Main's turn ends with a report that waits on someone (not the user) or says it
 * will follow up, and nothing will bring it back (no armed trigger, no wait_until clock), Walnut
 * sets a follow-up time for it: `Task.promise_alarm`, a day out. At that time its session gets ONE
 * note naming what it said, and it checks the thing, arms a trigger, or lets it go. A later report
 * that no longer promises anything, a trigger or a clock clears it; a report that still promises
 * keeps the time it had, so a chatty lead never pushes its own alarm out.
 *
 * Primary only, in memory over the tasks (one timer at the earliest alarm, the task events keep it
 * current), the same shape as task-wait-until.ts. An ephemeral server never fires an alarm it
 * copied from the real Walnut.
 */
import { log } from '../../logging/index.js';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import type { Task } from '../types.js';
import type { StatusReport } from '../user-status.js';

export interface PromiseAlarm {
  /** When it fires (ISO). */
  at: string;
  /** What the session said it waits for or will do. */
  words: string;
  /** When it was set (ISO). */
  set_at: string;
}

/** A day: a lead's follow-up runs on its own timescale, not a park's clock (DEFAULT_WAIT_MS). */
export const PROMISE_ALARM_MS = 24 * 60 * 60_000;
const WORDS_MAX = 300;
const SUBSCRIBER = 'promise-alarm';
const RECHECK_MS = 3_600_000;

const FOLLOW_UP_RE = /\b(?:follow(?:ing)?[ -]up|check (?:back|again|in later)|circle back|get back to|i(?:'ll| will) (?:check|look|ping|chase|remind)|will (?:check|ping|chase) (?:on|back|again|later))\b|跟进|回头再|稍后再(?:看|查|问)|晚点再/i;

function clip(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > WORDS_MAX ? `${chars.slice(0, WORDS_MAX - 1).join('')}…` : flat;
}

/** The promise a report makes, in its own words, or null when it makes none. */
export function promiseOf(report: Pick<StatusReport, 'state' | 'waiting_kind' | 'waiting_on' | 'next' | 'now'>): string | null {
  if (report.state === 'waiting' && report.waiting_kind !== 'you') {
    const words = report.waiting_on?.trim() || report.next?.trim();
    return words ? clip(words) : 'what it waits on';
  }
  if (report.state === 'needs' || report.state === 'done') return null;
  const text = [report.next, report.now].find((t) => t && FOLLOW_UP_RE.test(t));
  return text ? clip(text) : null;
}

/** Who gets alarms: Main and the leads, whose follow-ups the research found lost. */
export function keepsPromises(task: Pick<Task, 'org_role'>): boolean {
  return task.org_role === 'main' || task.org_role === 'lead';
}

/** Something already brings the task back: a clock on its wait, or an armed trigger of its own. */
async function hasWakeup(task: Task, nowMs: number): Promise<boolean> {
  if (task.phase === 'WAITING' && task.wait_until && Date.parse(task.wait_until) > nowMs) return true;
  const { triggersWatching } = await import('../task-wait-until.js');
  return (await triggersWatching(task.id)).some((t) => t.state === 'armed');
}

/**
 * After a turn-end report is stored and applied (session-hooks/builtins.ts): set, keep or clear
 * the task's alarm. Never throws.
 */
export async function notePromise(taskId: string, report: StatusReport, nowMs = Date.now()): Promise<PromiseAlarm | null> {
  try {
    const { getTask, updateTaskRaw } = await import('../task-manager.js');
    const task = await getTask(taskId).catch(() => null);
    if (!task || task.phase === 'COMPLETE' || task.status === 'done' || !keepsPromises(task)) return null;
    const words = promiseOf(report);
    const current = task.promise_alarm ?? null;
    const next: PromiseAlarm | null = words && !(await hasWakeup(task, nowMs))
      ? { at: current?.at ?? new Date(nowMs + PROMISE_ALARM_MS).toISOString(), words, set_at: current?.set_at ?? new Date(nowMs).toISOString() }
      : null;
    if (JSON.stringify(next) === JSON.stringify(current)) return next;
    const res = await updateTaskRaw(taskId, { promise_alarm: next }, {
      emitEvent: true, push: false, source: 'promise-alarm', shouldUpdate: (cur) => cur.phase !== 'COMPLETE' && cur.status !== 'done',
    });
    if (res.changed) log.task.info(next ? 'promise alarm set' : 'promise alarm cleared', { taskId, ...(next ? { at: next.at } : {}) });
    return next;
  } catch (err) {
    log.task.warn('promise alarm: note failed', { taskId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The note the alarm brings into the session. */
export function promiseAlarmBody(alarm: PromiseAlarm): string {
  const when = new Date(alarm.set_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  return [
    `At ${when} your turn ended saying you wait on, or will follow up on: "${alarm.words}".`,
    'Nothing was set to bring you back to it (no trigger, no wait_until), so Walnut set this follow-up a day later.',
    'Check it now. If it is still pending, arm a trigger on it (walnut-trigger skill) or park with a short wait_until; if it is settled or no longer needed, say so in your report. This note comes once.',
  ].join('\n');
}

// ── The clock ──

const alarms = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let live = false;
/** Ephemeral: alarms set before this process started are the real Walnut's. */
let startedAt = 0;
let ephemeral = false;

function alarmAt(task: Pick<Task, 'phase' | 'status' | 'promise_alarm'>): number | null {
  if (!task.promise_alarm || task.phase === 'COMPLETE' || task.status === 'done') return null;
  if (ephemeral && Date.parse(task.promise_alarm.set_at) < startedAt) return null;
  const at = Date.parse(task.promise_alarm.at);
  return Number.isFinite(at) ? at : null;
}

function track(task: Task): void {
  const at = alarmAt(task);
  if (at === null) alarms.delete(task.id);
  else alarms.set(task.id, at);
  arm();
}

function arm(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!live || alarms.size === 0) return;
  const next = Math.min(...alarms.values());
  timer = setTimeout(() => {
    timer = null;
    void firePromiseAlarms().catch((err) => log.task.warn('promise alarm sweep failed', { error: err instanceof Error ? err.message : String(err) }));
  }, Math.max(1_000, Math.min(next - Date.now(), RECHECK_MS)));
  timer.unref?.();
}

/** Fire every alarm that is due: clear it, then wake the task's session with the note. Exported for tests. */
export async function firePromiseAlarms(nowMs = Date.now()): Promise<string[]> {
  const due = [...alarms.entries()].filter(([, at]) => at <= nowMs).map(([id]) => id);
  const fired: string[] = [];
  for (const id of due) {
    alarms.delete(id);
    try {
      const { getTask, updateTaskRaw } = await import('../task-manager.js');
      const task = await getTask(id).catch(() => null);
      const at = task ? alarmAt(task) : null;
      if (!task || at === null || at > nowMs) { if (task) track(task); continue; }
      const alarm = task.promise_alarm!;
      // Cleared first: a failed wake never fires it again every minute.
      const res = await updateTaskRaw(id, { promise_alarm: null }, {
        emitEvent: true, push: false, source: 'promise-alarm', shouldUpdate: (cur) => cur.promise_alarm?.at === alarm.at,
      });
      if (!res.changed) continue;
      const { getSessionsForTask } = await import('../session-tracker.js');
      const { pickDeliverySession } = await import('../routines/session-target.js');
      const target = pickDeliverySession(await getSessionsForTask(id).catch(() => []));
      if (!target) { log.task.info('promise alarm due, no session to wake', { taskId: id }); continue; }
      const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js');
      const { sendMessageToSession } = await import('../session-message-queue.js');
      const { WAIT_UNTIL_SEND_SOURCE } = await import('../task-wait-until.js');
      await sendMessageToSession(target.claudeSessionId, buildWalnutMessage({
        kind: 'trigger',
        attrs: { from: 'Walnut: follow-up', note: 'the follow-up Walnut set for what your turn said it would do' },
        body: promiseAlarmBody(alarm),
      }), { source: WAIT_UNTIL_SEND_SOURCE, taskId: id });
      fired.push(id);
      log.task.info('promise alarm fired', { taskId: id, sessionId: target.claudeSessionId, setAt: alarm.set_at });
    } catch (err) {
      log.task.warn('promise alarm fire failed', { taskId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  arm();
  return fired;
}

function onTaskEvent(event: BusEvent): void {
  const task = (event.data as { task?: Task } | undefined)?.task;
  if (!task) return;
  if (event.name === EventNames.TASK_DELETED) { if (alarms.delete(task.id)) arm(); return; }
  if (alarms.has(task.id) || alarmAt(task) !== null) track(task);
}

/** Start the clock (server boot, primary only). Idempotent. */
export function startPromiseAlarms(opts: { ephemeral?: boolean } = {}): void {
  ephemeral = !!opts.ephemeral;
  startedAt = Date.now();
  live = true;
  void (async () => {
    const { listTasks } = await import('../task-manager.js');
    for (const task of await listTasks()) {
      const at = alarmAt(task);
      if (at !== null) alarms.set(task.id, at);
    }
    arm();
  })().catch((err) => log.task.warn('promise alarm boot scan failed', { error: err instanceof Error ? err.message : String(err) }));
  bus.subscribe(SUBSCRIBER, onTaskEvent, {
    global: true,
    interest: [EventNames.TASK_UPDATED, EventNames.TASK_COMPLETED, EventNames.TASK_DELETED],
  });
}

export function stopPromiseAlarms(): void {
  bus.unsubscribe(SUBSCRIBER);
  live = false;
  alarms.clear();
  arm();
}

/** Test seam. */
export function trackedPromiseAlarms(): ReadonlyMap<string, number> {
  return alarms;
}
