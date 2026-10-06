/**
 * Time tracking: the PER-TASK view of the records the rollup folds. PURE.
 *
 * The rollup (rollup.ts) answers "where did a day go": it is keyed
 * (date, task, kind) and drops the session. A task's own page asks the other
 * question, "how long did THIS task take, on which days, in which sessions", so
 * this index is keyed the other way round and keeps the session:
 * taskId → date → cell. It is fed at exactly the points the rollup is fed
 * (store.ts), in the same tick, so it inherits the store's exactly-once rule
 * instead of needing one of its own.
 *
 * The two lanes stay apart here too. `humanMs` and `agentMs` are never added:
 * a person and an agent often work at the same moment, and several sessions on
 * one task run in parallel, so a sum would describe time nobody spent.
 *
 * Size: one cell per (task, day) plus one entry per session active that day.
 * Measured on 44 real days: 5,712 (day, task, session, kind) combinations.
 */

import { isTimeKind, recentDateKeys } from './rollup.js';
import type { TimeRecord } from './types.js';

/** The two clocks, side by side. */
export interface TimePair {
  humanMs: number;
  agentMs: number;
}

interface DayCell extends TimePair {
  /** sessionId → its share of this day. Absent for time outside any session. */
  sessions: Map<string, TimePair>;
}

export interface TaskIndex {
  /** taskId ('' = no task) → local date → cell. */
  byTask: Map<string, Map<string, DayCell>>;
  /** sessionId → the tasks its time was filed under (usually one). */
  sessionTasks: Map<string, Set<string>>;
}

/** "This week" in the Time App's sense: the 7 days ending today (time-scope.ts). */
export const WEEK_DAYS = 7;

export function createTaskIndex(): TaskIndex {
  return { byTask: new Map(), sessionTasks: new Map() };
}

const zero = (): TimePair => ({ humanMs: 0, agentMs: 0 });

/** Fold one record in (mutates). A record the rollup would skip is skipped here too. */
export function addToTaskIndex(index: TaskIndex, rec: TimeRecord): void {
  const ms = rec.durationMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return;
  if (!isTimeKind(rec.kind) || !rec.date) return;
  const taskId = rec.taskId ?? '';
  let days = index.byTask.get(taskId);
  if (!days) {
    days = new Map();
    index.byTask.set(taskId, days);
  }
  let cell = days.get(rec.date);
  if (!cell) {
    cell = { humanMs: 0, agentMs: 0, sessions: new Map() };
    days.set(rec.date, cell);
  }
  const lane: keyof TimePair = rec.kind === 'agent' ? 'agentMs' : 'humanMs';
  cell[lane] += ms;
  if (!rec.sessionId) return;
  let share = cell.sessions.get(rec.sessionId);
  if (!share) {
    share = zero();
    cell.sessions.set(rec.sessionId, share);
  }
  share[lane] += ms;
  let tasks = index.sessionTasks.get(rec.sessionId);
  if (!tasks) {
    tasks = new Set();
    index.sessionTasks.set(rec.sessionId, tasks);
  }
  tasks.add(taskId);
}

/** The days on which any task has agent time: the days the live collector observed. */
export function agentDates(index: TaskIndex): Set<string> {
  const out = new Set<string>();
  for (const days of index.byTask.values()) {
    for (const [date, cell] of days) if (cell.agentMs > 0) out.add(date);
  }
  return out;
}

/**
 * A second index laid over the first, except on the days in `skip`: the usage-ledger
 * backfill (task-backfill.ts) for days the live collector never observed, the same
 * rule /summary applies (agent-time.ts withLedgerBackfill). Neither index is mutated.
 */
export interface TaskOverlay {
  index: TaskIndex;
  skip: ReadonlySet<string>;
}

function mergeCells(a: DayCell, b: DayCell): DayCell {
  const sessions = new Map(a.sessions);
  for (const [sid, share] of b.sessions) {
    const prev = sessions.get(sid);
    sessions.set(sid, prev ? { humanMs: prev.humanMs + share.humanMs, agentMs: prev.agentMs + share.agentMs } : share);
  }
  return { humanMs: a.humanMs + b.humanMs, agentMs: a.agentMs + b.agentMs, sessions };
}

/** One task's days, with the overlay's days merged in. */
function daysOf(index: TaskIndex, taskId: string, overlay?: TaskOverlay): Map<string, DayCell> | undefined {
  const own = index.byTask.get(taskId);
  const extra = overlay?.index.byTask.get(taskId);
  if (!extra) return own;
  const merged = new Map(own ?? []);
  for (const [date, cell] of extra) {
    if (overlay!.skip.has(date)) continue;
    const base = merged.get(date);
    merged.set(date, base ? mergeCells(base, cell) : cell);
  }
  return merged;
}

export interface TimeTotals {
  /** Everything recorded. */
  all: TimePair;
  today: TimePair;
  /** The WEEK_DAYS days ending today. */
  week: TimePair;
}

export interface TaskTimeDay extends TimePair {
  date: string;
  /** Each session's share of the day, largest human time first. */
  sessions: Array<TimePair & { sessionId: string }>;
  /** The part of the day outside any session: the task's row, its detail, its page. */
  other: TimePair;
}

export interface TaskTimeSession {
  sessionId: string;
  totals: TimeTotals;
  /** The last day this session has time on. */
  lastDate: string;
}

export interface TaskTimeView {
  taskId: string;
  today: string;
  /** First day of `totals.week`. */
  weekStart: string;
  totals: TimeTotals;
  /** Days with any time, newest first. */
  days: TaskTimeDay[];
  /** Every session with time on this task, YOUR time first (as the rollup ranks tasks). */
  sessions: TaskTimeSession[];
}

export interface SessionTimeDay extends TimePair {
  date: string;
}

export interface SessionTimeView {
  sessionId: string;
  /** The tasks this session's time was filed under. */
  taskIds: string[];
  today: string;
  weekStart: string;
  totals: TimeTotals;
  /** Days with any time, newest first. */
  days: SessionTimeDay[];
}

function add(into: TimePair, from: TimePair): void {
  into.humanMs += from.humanMs;
  into.agentMs += from.agentMs;
}

function emptyTotals(): TimeTotals {
  return { all: zero(), today: zero(), week: zero() };
}

function addToTotals(totals: TimeTotals, date: string, pair: TimePair, today: string, week: Set<string>): void {
  add(totals.all, pair);
  if (date === today) add(totals.today, pair);
  if (week.has(date)) add(totals.week, pair);
}

const byYourTimeFirst = (a: TimePair, b: TimePair) => (b.humanMs - a.humanMs) || (b.agentMs - a.agentMs);

/** One task's time: totals, every day, and every session. Unknown task → zeros. */
export function taskTimeView(index: TaskIndex, taskId: string, today: string, overlay?: TaskOverlay): TaskTimeView {
  const weekDates = recentDateKeys(today, WEEK_DAYS);
  const week = new Set(weekDates);
  const totals = emptyTotals();
  const days: TaskTimeDay[] = [];
  const sessions = new Map<string, TaskTimeSession>();

  for (const [date, cell] of daysOf(index, taskId, overlay) ?? []) {
    if (cell.humanMs <= 0 && cell.agentMs <= 0) continue;
    addToTotals(totals, date, cell, today, week);
    const other: TimePair = { humanMs: cell.humanMs, agentMs: cell.agentMs };
    const shares: TaskTimeDay['sessions'] = [];
    for (const [sessionId, share] of cell.sessions) {
      other.humanMs -= share.humanMs;
      other.agentMs -= share.agentMs;
      shares.push({ sessionId, ...share });
      let s = sessions.get(sessionId);
      if (!s) {
        s = { sessionId, totals: emptyTotals(), lastDate: date };
        sessions.set(sessionId, s);
      }
      addToTotals(s.totals, date, share, today, week);
      if (date > s.lastDate) s.lastDate = date;
    }
    shares.sort((a, b) => byYourTimeFirst(a, b) || a.sessionId.localeCompare(b.sessionId));
    days.push({
      date,
      humanMs: cell.humanMs,
      agentMs: cell.agentMs,
      sessions: shares,
      // Float drift cannot happen (integers), but a hand-edited file can make a
      // share exceed its cell; never report negative time.
      other: { humanMs: Math.max(0, other.humanMs), agentMs: Math.max(0, other.agentMs) },
    });
  }

  days.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const sessionList = [...sessions.values()]
    .sort((a, b) => byYourTimeFirst(a.totals.all, b.totals.all) || a.sessionId.localeCompare(b.sessionId));
  return { taskId, today, weekStart: weekDates[0]!, totals, days, sessions: sessionList };
}

/** One session's time, across every task it was filed under. Unknown session → zeros. */
export function sessionTimeView(index: TaskIndex, sessionId: string, today: string, overlay?: TaskOverlay): SessionTimeView {
  const weekDates = recentDateKeys(today, WEEK_DAYS);
  const week = new Set(weekDates);
  const totals = emptyTotals();
  const perDay = new Map<string, TimePair>();
  const candidates = new Set([
    ...(index.sessionTasks.get(sessionId) ?? []),
    ...(overlay?.index.sessionTasks.get(sessionId) ?? []),
  ]);
  const taskIds: string[] = [];

  for (const taskId of candidates) {
    let counted = false;
    for (const [date, cell] of daysOf(index, taskId, overlay) ?? []) {
      const share = cell.sessions.get(sessionId);
      if (!share || (share.humanMs <= 0 && share.agentMs <= 0)) continue;
      counted = true;
      addToTotals(totals, date, share, today, week);
      let day = perDay.get(date);
      if (!day) {
        day = zero();
        perDay.set(date, day);
      }
      add(day, share);
    }
    if (counted) taskIds.push(taskId);
  }

  const days = [...perDay].map(([date, pair]) => ({ date, ...pair }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { sessionId, taskIds: taskIds.sort(), today, weekStart: weekDates[0]!, totals, days };
}
