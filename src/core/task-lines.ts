/**
 * A task's lines: the few threads of work one task holds at once, each with its own state, and the
 * task's state as their sum (2026-11-19, the user on a deploy task that watched its pipeline, waited
 * on an engineer's reply and asked him for a yes at the same time: "它这个里面至少有几个小
 * thread……那这几个 thread 这这个 status 是什么？……那么那这个总体的 status 当然就是一个
 * aggregate……如果说其中有一个 thread，它它需要我。那就是他需要我"; Walnut VP picked design A).
 *
 * A line is derived from facts the status already reads (no store of its own): what it asks of the
 * user (Action needed items, action-needed.ts, referenced by id, never copied), a turn running or
 * its own work going on, a watch, a scheduled run, a reply it waits for, a subtask at work, a wait
 * its report names. The task's status (deriveUserStatus) stays the one authority in this first step:
 * its own reason becomes a line when no fact line says it, so its state always has a line, and the
 * lines hold a Needs you line exactly when the task is Needs you (tests/core/task-lines.test.ts).
 * `aggregateLines` is the sum the later step derives the status from. Not the user's Threads (org/threads-store.ts): a thread is a
 * request of his with its history; a line is one live fact of one task.
 *
 * Pure and browser-safe: the server derives it (user-status-sync.ts) and the web draws it
 * (web/src/components/tasks/TaskLines.tsx, experiment task_lines).
 */
import { OUTLIVING_SOURCES } from './sessions/outliving-work.js';
import { hasAbove, reportIsCurrent, reportWaitsOnUser, type UserStatus, type UserStatusInput } from './user-status.js';

/** The states a line can be in, strongest first: the task's state is its strongest line's. */
export const LINE_STATES = ['needs', 'working', 'read', 'waiting'] as const;
export type LineState = typeof LINE_STATES[number];

export type LineKind =
  | 'ask'       // something of the user's: an Action needed item, or its status's own ask
  | 'read'      // a result or an answer for the user to read
  | 'turn'      // its turn runs now
  | 'own'       // its own work goes on (a build or test it watches, a background job)
  | 'watch'     // a trigger that checks something outside
  | 'schedule'  // a scheduled run in its session
  | 'reply'     // a reply it asked another task for
  | 'subtask'   // its subtask at work
  | 'wait';     // a wait its report or its status names

export interface TaskLine {
  /** Stable within a task: `action:<item id>`, `watch:<name>`, `reply:<task>`, ... */
  id: string;
  kind: LineKind;
  state: LineState;
  /** One line, what it is. */
  what: string;
  /** When it checks or runs next (ISO), where known. */
  until?: string;
  /** The Action needed item it is (kind ask): answered and snoozed there. */
  item?: string;
}

const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

/** The lines of a task with this input and its finished status (after Action needed). Pure. */
export function taskLines(input: UserStatusInput, status: UserStatus, nowMs = Date.now()): TaskLine[] {
  if (status.state === 'done') return [];
  const out: TaskLine[] = [];
  const add = (l: TaskLine) => { if (l.what && !out.some((o) => o.id === l.id)) out.push(l); };
  // What it asks of the user: each open Action needed item (a snoozed one is not asked now). Items
  // that only ride along (an org node's, a held team's, an ask folded into another task's or answered
  // for the user: applyActions) ask nothing now, so they are no line.
  for (const a of status.state === 'needs' ? status.actions ?? [] : []) {
    if (!a.snoozedUntil) add({ id: `action:${a.id}`, kind: 'ask', state: 'needs', what: clean(a.summary), item: a.id });
  }
  // Working: a turn running, its own work going on.
  if (input.processStatus === 'running' && !input.pendingPermissionTool) add({ id: 'turn', kind: 'turn', state: 'working', what: clean(status.now) || 'Its turn is running' });
  for (const n of input.ownWorkTriggers ?? []) add({ id: `own:${clean(n)}`, kind: 'own', state: 'working', what: clean(n) });
  for (const o of input.outliving ?? []) add({ id: `outliving:${o}`, kind: 'own', state: 'working', what: `Its own work: ${OUTLIVING_SOURCES[o] ?? o}` });
  // Waiting on something outside it.
  for (const n of input.triggers ?? []) add({ id: `watch:${clean(n)}`, kind: 'watch', state: 'waiting', what: clean(n) });
  for (const r of input.schedules ?? []) {
    const next = r.nextAt && Date.parse(r.nextAt) > nowMs ? r.nextAt : undefined;
    add({ id: `schedule:${clean(r.name)}`, kind: 'schedule', state: 'waiting', what: clean(r.name), ...(next ? { until: next } : {}) });
  }
  for (const t of input.waitingOnTasks ?? []) add({ id: `reply:${clean(t)}`, kind: 'reply', state: 'waiting', what: `A reply from ${clean(t)}` });
  for (const t of input.workersAtWork ?? []) add({ id: `subtask:${clean(t)}`, kind: 'subtask', state: 'waiting', what: `Its subtask at work: ${clean(t)}` });
  const report = reportIsCurrent(input) ? input.report : null;
  if (report?.state === 'waiting' && clean(report.waiting_on) && !reportWaitsOnUser(report, hasAbove(input))) {
    add({ id: 'wait:report', kind: 'wait', state: 'waiting', what: clean(report.waiting_on) });
  }
  // The status's own reason, when no line above says its state (a failure, a prompt, a machine
  // wait, a result to read, its lead to look): the sum of the lines is the status, always.
  if (!out.some((l) => l.state === status.state)) {
    const what = clean(status.state === 'needs' ? status.ask : status.state === 'working' ? status.now : status.waitingOn)
      || (status.state === 'working' ? 'Working' : status.state === 'read' ? 'Something to read' : 'Waiting');
    add({ id: `status:${status.state}`, kind: status.state === 'needs' ? 'ask' : status.state === 'read' ? 'read' : status.state === 'working' ? 'own' : 'wait', state: status.state as LineState, what, ...(status.until ? { until: status.until } : {}) });
  }
  // A clock it checks again by: on its waiting lines that name no time of their own.
  const until = input.waitUntil && Date.parse(input.waitUntil) > nowMs ? input.waitUntil : undefined;
  if (until) for (const l of out) if (l.state === 'waiting' && !l.until && l.kind !== 'schedule') l.until = until;
  return out.sort((a, b) => LINE_STATES.indexOf(a.state) - LINE_STATES.indexOf(b.state));
}

/** The task's state from its lines: the strongest one, or null for none. Pure. */
export function aggregateLines(lines: readonly Pick<TaskLine, 'state'>[]): LineState | null {
  for (const s of LINE_STATES) if (lines.some((l) => l.state === s)) return s;
  return null;
}
