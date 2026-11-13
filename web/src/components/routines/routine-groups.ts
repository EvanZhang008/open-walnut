/**
 * The Routines page's shape (2026-11-04, the user: "routine page should be seperate
 * by global routine and each project routine ... default first page show min info").
 *
 * One group for the global routines (no task, or a task in the Inbox) first, then
 * one per project, named by it, in name order. A routine's project is its task's
 * (`owner`, server: src/core/routines/routine-owner.ts). Inside a group the failing
 * ones come first, then the rest by name, as the page opens; after that a row keeps
 * its place for the visit (keepShownOrder), whatever a switch or a run changes.
 *
 * A row's health is one of four words the dot draws: ok, running, error (a failed
 * last run or check, or a trigger the server stopped after its check kept failing)
 * and off (paused, or a one-time routine that has run).
 */
import type { Routine } from '@/api/routines';
import { describeSchedule, describeTriggerOff, describeWake, describeClockWait, triggerRunState } from '@/utils/routine-format';

export const GLOBAL_GROUP_KEY = 'global';

export type RoutineHealth = 'ok' | 'running' | 'error' | 'off';

export interface RoutineGroup {
  /** `global`, or `project:<name>`: the key the collapsed set stores. */
  key: string;
  name: string;
  global: boolean;
  routines: Routine[];
  /** How many need a look (health `error`). */
  failing: number;
}

export function routineHealth(r: Routine): RoutineHealth {
  if (r.check && triggerRunState(r) === 'stopped') return 'error';
  if (!r.enabled) return 'off';
  if (r.state.runningAtMs) return 'running';
  if (r.state.lastCheck?.outcome === 'error') return 'error';
  if (r.state.lastStatus === 'error' && !failedIntoOldTask(r)) return 'error';
  return 'ok';
}

/**
 * The last run failed into a finished task that is no longer the routine's: it has
 * been pointed at another task since, so it is not failing any more (its box says the
 * old failure is behind it until the next run).
 */
function failedIntoOldTask(r: Routine): boolean {
  const done = /target task (\S+) is complete/i.exec(r.state.lastError ?? '');
  const current = targetTaskOf(r);
  return !!done && !!current && done[1] !== current;
}

/** The word behind the dot, for its hover text and screen readers. */
export function healthLabel(r: Routine): string {
  const health = routineHealth(r);
  if (health === 'error') {
    if (r.check && triggerRunState(r) === 'stopped') return 'Stopped';
    return r.check && r.state.lastCheck?.outcome === 'error' ? 'Last check failed' : 'Last run failed';
  }
  if (health === 'running') return 'Running';
  if (health === 'off') return offLabel(r);
  return 'On';
}

/**
 * What the switch of a routine that is off says. A trigger is Paused or Stopped
 * (the server gave up on its failing check). A plain routine is Paused when
 * someone paused it, and Off otherwise: a one-time routine switches itself off
 * once it has run.
 */
export function offLabel(r: Routine): 'Paused' | 'Stopped' | 'Off' {
  if (r.check) return triggerRunState(r) === 'stopped' ? 'Stopped' : 'Paused';
  return typeof r.state.pausedAtMs === 'number' ? 'Paused' : 'Off';
}

export function groupKeyOf(r: Routine): string {
  const project = r.owner?.project ?? '';
  return project ? `project:${project}` : GLOBAL_GROUP_KEY;
}

const byName = (a: Routine, b: Routine) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

export function groupRoutines(routines: readonly Routine[]): RoutineGroup[] {
  const groups = new Map<string, RoutineGroup>();
  for (const r of routines) {
    const key = groupKeyOf(r);
    let group = groups.get(key);
    if (!group) {
      const global = key === GLOBAL_GROUP_KEY;
      const project = r.owner?.project ?? '';
      // A project the person named "Global" must not read as the global group.
      const name = global ? 'Global' : project.trim().toLowerCase() === 'global' ? `${project} (project)` : project;
      group = { key, name, global, routines: [], failing: 0 };
      groups.set(key, group);
    }
    group.routines.push(r);
  }
  for (const group of groups.values()) {
    const failing = group.routines.filter((r) => routineHealth(r) === 'error').sort(byName);
    const rest = group.routines.filter((r) => routineHealth(r) !== 'error').sort(byName);
    group.routines = [...failing, ...rest];
    group.failing = failing.length;
  }
  return [...groups.values()].sort((a, b) => {
    if (a.global !== b.global) return a.global ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * When the next run is, said short. A cadence that already names its hour ("Weekdays
 * at 9:00 AM") needs only the day: "today", "tomorrow", "in 3 days". One that does not
 * ("Every 2 hours") says the clock: "next at 12:09 PM", "tomorrow at 9:00 AM",
 * "Mon at 8:00 AM". Minutes away is "next in 3 min" either way.
 */
export function shortNextRun(nextMs: number | undefined, nowMs = Date.now(), cadenceHasHour = false): string | null {
  if (!nextMs) return null;
  const inMs = nextMs - nowMs;
  if (inMs < 60_000) return 'next in <1 min';
  if (inMs < 3_600_000) return `next in ${Math.round(inMs / 60_000)} min`;
  const at = new Date(nextMs);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date(nowMs); today.setHours(0, 0, 0, 0);
  const day = new Date(nextMs); day.setHours(0, 0, 0, 0);
  const days = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (days >= 7) return `on ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  if (cadenceHasHour) return days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  // Within half a day the clock time says it ("next at 1:07 AM"): "tomorrow at" for a
  // run an hour away read as far off (2026-11-04, a review).
  if (days <= 0 || inMs < 12 * 3_600_000) return `next at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `${SHORT_DAYS[at.getDay()]} at ${time}`;
}

/** A cron cadence that names its hour in this clock's zone ("Weekdays at 9:00 AM", not "... PST"). */
function cadenceNamesHour(r: Routine, said: string): boolean {
  if (r.schedule.kind !== 'cron') return false;
  if (r.schedule.tz && said !== describeSchedule({ ...r.schedule, tz: undefined })) return false;
  return / at \d{1,2}:\d\d/.test(said);
}

/**
 * The row's one line under the name: how often it runs and when next, or that it is
 * quiet. "Every 5 min · next in 3 min", "Weekdays at 9:00 AM · tomorrow",
 * "Paused · Every 5 min". When it was paused, and why a trigger stopped, are in the
 * opened row: the line stays short enough for a phone.
 */
export function rowTiming(r: Routine, nowMs = Date.now()): string {
  const schedule = describeSchedule(r.schedule);
  const cadence = r.check ? `Checks ${lowerFirst(schedule)}` : schedule;
  const counter = describeWake(r.wake);
  const parts = [cadence];
  if (counter) parts.push(`or ${counter}`);
  if (!r.enabled) {
    // A stopped trigger's row carries the red "Stopped" flag; the line keeps its cadence.
    if (routineHealth(r) === 'error') return parts.join(' · ');
    return `${offLabel(r)} · ${parts.join(' · ')}`;
  }
  // A run waiting on its host is past its slot: the detail says since when.
  if (describeClockWait(r)) return [...parts, 'waiting for its host'].join(' · ');
  // A one-time routine's cadence is its time already.
  if (r.schedule.kind === 'at') return parts.join(' · ');
  const next = shortNextRun(r.state.nextRunAtMs, nowMs, cadenceNamesHour(r, schedule));
  if (next) parts.push(next);
  return parts.join(' · ');
}

/** Why a routine is quiet, for the opened row: "Paused 2h ago", "Stopped after 5 failed checks". */
export function quietReason(r: Routine, nowMs = Date.now()): string | null {
  if (r.enabled) return null;
  if (r.check) return describeTriggerOff(r, nowMs);
  if (typeof r.state.pausedAtMs === 'number') return describeTriggerOff({ enabled: false, state: { pausedAtMs: r.state.pausedAtMs } }, nowMs);
  return 'Off';
}

/** The task a routine runs in now: its session target, else its owner. */
export function targetTaskOf(r: Routine): string | undefined {
  const target = (r.executor?.config as { target?: unknown } | undefined)?.target;
  return typeof target === 'string' && target.trim() ? target.trim() : r.owner?.taskId || undefined;
}

/** A server line with the routine's task named by its title instead of its id. */
export function nameTaskIn(text: string, r: Routine): string {
  const owner = r.owner;
  return owner?.title && owner.taskId ? text.split(owner.taskId).join(`"${owner.title}"`) : text;
}

/**
 * The last error in the person's words: the task's title instead of its id, and the
 * way out when the task it delivers into is finished. "target task mw20xlw0-fcd9 is
 * complete; ..." named nothing a person could find.
 */
export function routineError(r: Routine): { text: string; next: string | null; past?: true } | null {
  const raw = r.state.lastError?.trim();
  if (!raw) return null;
  const done = /target task (\S+) is complete/i.exec(raw);
  if (done) {
    const current = targetTaskOf(r);
    // Already pointed at another task (Edit's Task): the old failure says so instead
    // of asking for the fix again.
    if (current && done[1] !== current) {
      const title = r.owner?.taskId === current && r.owner.title ? `"${r.owner.title}"` : 'the task you picked';
      // A trigger stopped by those failures stays stopped until Resume.
      const when = r.check && triggerRunState(r) === 'stopped' ? 'once you Resume it' : 'from its next run';
      return { text: 'Its last run failed: the task it ran in then was complete.', next: `It runs in ${title} ${when}.`, past: true };
    }
    const title = r.owner?.title ? `"${r.owner.title}"` : 'its task';
    return { text: `Its task ${title} is complete, so its last run went nowhere.`, next: 'Point it at an open task with Edit, or turn it off.' };
  }
  return { text: nameTaskIn(raw, r), next: null };
}

/**
 * The groups with each one's rows in the order they were last shown, newcomers after
 * them in the usual order. A run that fails, a check that recovers or a failing row
 * switched off must not move a row under the person's pointer (2026-11-04: Run now on
 * an opened row failed and the row jumped to the top of its group; pausing a failing
 * row on the phone put another row's switch under the thumb).
 */
export function keepShownOrder(groups: RoutineGroup[], shown: ReadonlyMap<string, readonly string[]>): RoutineGroup[] {
  return groups.map((g) => {
    const before = shown.get(g.key);
    if (!before) return g;
    const at = new Map(before.map((id, i) => [id, i]));
    const kept = g.routines.filter((r) => at.has(r.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
    // A newcomer that is failing joins the failing ones at the top (the header counts it).
    const added = g.routines.filter((r) => !at.has(r.id));
    const addedFailing = added.filter((r) => routineHealth(r) === 'error');
    const addedRest = added.filter((r) => routineHealth(r) !== 'error');
    // Any other newcomer (made here, or moved in by an edit) takes its place by name
    // among the kept rows, where a reload would put it, so it never moves again.
    const natural = new Map(g.routines.map((r, i) => [r.id, i]));
    const out = [...addedFailing, ...kept];
    for (const r of addedRest) {
      const mine = natural.get(r.id)!;
      const next = out.findIndex((o, i) => i >= addedFailing.length && natural.get(o.id)! > mine);
      if (next === -1) out.push(r); else out.splice(next, 0, r);
    }
    return { ...g, routines: out };
  });
}

/**
 * What a Run now answered, in a word for the row: the run route answers 200 with
 * `{ status: 'error', error }` when the routine could not start (a paused trigger's
 * daemon no longer knows it, say), which must not read as started.
 */
export function runOutcome(result: unknown): { ok: boolean; text: string } {
  const r = (result && typeof result === 'object' ? result : {}) as { status?: unknown; error?: unknown; ok?: unknown };
  if (r.status === 'error' || r.ok === false) {
    return { ok: false, text: typeof r.error === 'string' && r.error.trim() ? r.error.trim() : 'It did not start.' };
  }
  return { ok: true, text: 'Started' };
}

/** What changes on a routine when it has run (its last run, or its check's). */
export function runStamp(r: Routine): string {
  return `${r.state.lastRunAtMs ?? ''}|${r.state.lastCheck?.atMs ?? ''}`;
}

/**
 * How a run that the server took ended, once the routine shows it: null while it has
 * not (the stamp from before Run now is unchanged). The run answers "started" before
 * it delivers, so a delivery that failed (a finished task, say) is only known from the
 * routine (2026-11-04, a review: a green "Started" beside a fresh failure).
 */
export function settledRun(before: string, r: Routine): { ok: boolean; text: string } | null {
  if (runStamp(r) === before) return null;
  const failed = r.check ? r.state.lastCheck?.outcome === 'error' : r.state.lastStatus === 'error';
  if (failed) return { ok: false, text: 'It ran and failed: the reason is above.' };
  return { ok: true, text: r.check ? 'Checked just now' : 'Ran just now' };
}

/**
 * What a saved edit would replace that someone changed after the form opened
 * (2026-11-04, a review: a second tab's save was silently overwritten by an older
 * form). Only what the form sends counts: a pause or a run while it is open is no
 * conflict.
 */
export function changedSince(opened: Routine, latest: Routine): string[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const out: string[] = [];
  if (opened.name !== latest.name) out.push('name');
  if ((opened.description ?? '') !== (latest.description ?? '')) out.push('description');
  if (!same(opened.schedule, latest.schedule)) out.push('when it runs');
  if (!same(opened.executor, latest.executor)) out.push('what it runs');
  if (!same(opened.check, latest.check)) out.push('check');
  return out;
}

/** The same, as one key: a conflict the person already saw is not asked again. */
export function editKey(r: Routine): string {
  return JSON.stringify([r.name, r.description ?? '', r.schedule, r.executor ?? null, r.check ?? null]);
}

/**
 * A history line in the person's words: the task by its title, and the daemon's
 * "target task X is complete; the trigger will not resurrect it" as what happened.
 */
export function historyWords(text: string, r: Routine): string {
  const said = nameTaskIn(text, r)
    .replace(/target task (".*?"|\S+) is complete(?:; the trigger will not resurrect it)?/i, 'its task $1 was complete')
    .replace(/\s*\[[0-9a-f]{6,}\]/gi, '')
    .replace(/\bresumed session\b/i, 'delivered to')
    .replace(/^check error: /i, 'The check failed: ')
    .replace(/^quiet — the script said no/i, 'Checked: nothing to do')
    .replace(/^quiet — nothing new \(all items already seen\)/i, 'Checked: nothing new')
    .replace(/^held: fire budget used up, it fires on a later check/i, 'Held: it already ran as often as allowed today')
    .replace(/^run now → /i, 'Run now: ')
    .replace(/^fired, (\d+ new items?) → /i, 'Ran with $1: ')
    .replace(/^fired → /i, 'Ran: ')
    .replace(/ → /g, ': ')
    .replace(/: not delivered: /i, ': not delivered, ');
  return said.charAt(0).toUpperCase() + said.slice(1);
}

/**
 * Consecutive history lines that say the same thing, as one line with a count
 * (2026-11-05, a review: two identical red lines read as noise).
 */
export function collapseRepeats<T>(items: readonly T[], said: (item: T) => string): Array<{ item: T; count: number }> {
  const out: Array<{ item: T; count: number; key: string }> = [];
  for (const item of items) {
    const key = said(item);
    const last = out[out.length - 1];
    if (last && last.key === key) last.count += 1;
    else out.push({ item, count: 1, key });
  }
  return out.map(({ item, count }) => ({ item, count }));
}
