import type { Task, TaskPhase, TaskPriority } from './types.js';
import { VALID_PRIORITIES } from './types.js';

export type TaskCompletion = 'todo' | 'in_progress' | 'complete';
export type TimeBasis = 'created' | 'updated' | 'created_or_updated';
export type TaskQuerySort = 'updated_desc' | 'created_desc' | 'completed_desc' | 'priority' | 'title_asc';

export interface TaskQueryTime {
  basis: TimeBasis;
  /** Relative window [now - duration, now]. Mutually exclusive with from/until. */
  last?: { value: number; unit: 'hours' | 'days' };
  /** Absolute half-open window [from, until). ISO-8601 strings. */
  from?: string;
  until?: string;
}

export interface TaskQuery {
  completion?: TaskCompletion[];
  phases?: TaskPhase[];
  /** Project names to match (case-insensitive). '' matches Inbox. */
  projects?: string[];
  priorities?: TaskPriority[];
  sources?: string[];
  sprints?: string[];
  tagsAny?: string[];
  tagsAll?: string[];
  pinned?: boolean;
  starred?: boolean;
  /** Read/unread marker — true = agent output the human hasn't opened. */
  unread?: boolean;
  blocked?: boolean;
  parentTaskId?: string;
  groupId?: string;
  time?: TaskQueryTime;
  sort?: TaskQuerySort;
  limit?: number;
}

/** Normalized form: time window resolved to epoch-ms numbers, single captured `now`. */
export interface NormalizedTaskQuery extends Omit<TaskQuery, 'time'> {
  time?: { basis: TimeBasis; fromMs: number; untilMs: number; untilExclusive: boolean };
  now: number;
}

export class TaskQueryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TaskQueryError';
  }
}

// This module is imported by the browser bundle, so it may only import from
// types.ts (types + plain literals). phase.ts pulls in the logger, which pulls
// in node:fs/os — so PHASE_ORDER can't be reused here and the 7 phases are
// listed literally. tests/core/task-query.test.ts locks this list against
// PHASE_ORDER so a new phase can't land in one place only.
export const QUERY_TASK_PHASES: readonly TaskPhase[] = [
  'TODO',
  'IN_PROGRESS',
  'AGENT_COMPLETE',
  'AWAIT_HUMAN_ACTION',
  'HUMAN_VERIFIED',
  'POST_WORK_COMPLETED',
  'COMPLETE',
];
const TASK_PRIORITIES: readonly TaskPriority[] = VALID_PRIORITIES;
const COMPLETIONS: readonly TaskCompletion[] = ['todo', 'in_progress', 'complete'];
const TIME_BASES: readonly TimeBasis[] = ['created', 'updated', 'created_or_updated'];
const QUERY_SORTS: readonly TaskQuerySort[] = [
  'updated_desc',
  'created_desc',
  'completed_desc',
  'priority',
  'title_asc',
];
const ARRAY_FIELDS = [
  'completion',
  'phases',
  'projects',
  'priorities',
  'sources',
  'sprints',
  'tagsAny',
  'tagsAll',
] as const;

/** Max rows one query may return. Mirrored in the REST 400 message + tool schema. */
export const MAX_QUERY_LIMIT = 200;

// HUMAN_VERIFIED and POST_WORK_COMPLETED count as in_progress ON PURPOSE: this
// mirrors PHASE_TO_STATUS (only COMPLETE is "done" to a human), NOT
// TERMINAL_PHASES in phase.ts (which is about "the agent may stop working").
// Don't "fix" this to follow phase.ts — a task the human hasn't signed off on
// must stay visible in the in_progress bucket.
export const COMPLETION_TO_PHASES: Record<TaskCompletion, readonly TaskPhase[]> = {
  todo: ['TODO'],
  in_progress: [
    'IN_PROGRESS',
    'AGENT_COMPLETE',
    'AWAIT_HUMAN_ACTION',
    'HUMAN_VERIFIED',
    'POST_WORK_COMPLETED',
  ],
  complete: ['COMPLETE'],
};

/**
 * Legacy 3-state `status` vocabulary → completion bucket. Both the agent tool
 * and the REST route accept `status` as a convenience alias, so the mapping
 * lives here instead of being copied into each adapter.
 */
export const LEGACY_STATUS_TO_COMPLETION: Readonly<Record<string, TaskCompletion>> = {
  todo: 'todo',
  in_progress: 'in_progress',
  done: 'complete',
};

/**
 * Priority values written before the 4-tier vocabulary. Same mapping as
 * sanitizePriority() in task-manager.ts, which normalizes on WRITE — rows
 * written before it existed still carry these strings, so every reader of
 * task.priority has to fold them too.
 */
export const LEGACY_PRIORITY: Readonly<Record<string, TaskPriority>> = {
  high: 'immediate',
  medium: 'backlog',
  low: 'backlog',
};

/**
 * Canonicalize a stored priority. A value that is neither canonical nor legacy
 * (absent, garbage) passes through UNCHANGED rather than becoming 'none': it
 * then misses both the priorities filter and PRIORITY_RANK, which is what keeps
 * such a row sorting below a real 'none'.
 */
export function normalizeTaskPriority(priority: TaskPriority | undefined): TaskPriority | undefined {
  if (priority === undefined) return undefined;
  return LEGACY_PRIORITY[priority as string] ?? priority;
}

function queryError(code: string, message: string): never {
  throw new TaskQueryError(code, message);
}

function validateStringArray(raw: TaskQuery, field: typeof ARRAY_FIELDS[number]): void {
  const value = raw[field];
  if (value === undefined) return;
  if (!Array.isArray(value)) queryError('invalid_array', `${field} must be an array`);
  if (value.some((entry) => typeof entry !== 'string')) {
    queryError('invalid_array_value', `${field} must contain only strings`);
  }
}

function validateEnumArray<T extends string>(
  value: readonly string[] | undefined,
  allowed: readonly T[],
  field: string,
): void {
  if (!value) return;
  const invalid = value.find((entry) => !allowed.includes(entry as T));
  if (invalid !== undefined) queryError('invalid_enum', `Unknown ${field} value: ${invalid}`);
}

function validateEnum<T extends string>(value: string | undefined, allowed: readonly T[], field: string): void {
  if (value !== undefined && !allowed.includes(value as T)) {
    queryError('invalid_enum', `Unknown ${field} value: ${value}`);
  }
}

// Date.parse accepts impossible dates by rolling them forward, so validate calendar fields first.
function parseIsoTimestampValue(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return Number.NaN;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (month < 1 || month > 12 || day < 1 || day > daysByMonth[month - 1]
      || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return Number.NaN;
  }
  return Date.parse(value);
}

function parseIsoTimestamp(value: string, field: string): number {
  const parsed = parseIsoTimestampValue(value);
  if (!Number.isFinite(parsed)) queryError('invalid_timestamp', `${field} must be a valid ISO-8601 timestamp`);
  return parsed;
}

/** Strictly validate a query and resolve its time window using one captured clock value. */
export function normalizeTaskQuery(raw: TaskQuery, now: Date): NormalizedTaskQuery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    queryError('invalid_query', 'Task query must be an object');
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) queryError('invalid_now', 'now must be a valid Date');

  for (const field of ARRAY_FIELDS) validateStringArray(raw, field);
  validateEnumArray(raw.completion, COMPLETIONS, 'completion');
  validateEnumArray(raw.phases, QUERY_TASK_PHASES, 'phase');
  validateEnumArray(raw.priorities, TASK_PRIORITIES, 'priority');
  validateEnum(raw.sort, QUERY_SORTS, 'sort');

  for (const field of ['pinned', 'starred', 'unread', 'blocked'] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== 'boolean') {
      queryError('invalid_boolean', `${field} must be a boolean`);
    }
  }
  for (const field of ['parentTaskId', 'groupId'] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') {
      queryError('invalid_string', `${field} must be a string`);
    }
  }
  if (raw.limit !== undefined
      && (!Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > MAX_QUERY_LIMIT)) {
    queryError('invalid_limit', `limit must be an integer from 1 to ${MAX_QUERY_LIMIT}`);
  }

  let time: NormalizedTaskQuery['time'];
  if (raw.time !== undefined) {
    if (!raw.time || typeof raw.time !== 'object' || Array.isArray(raw.time)) {
      queryError('invalid_time', 'time must be an object');
    }
    if (raw.time.basis === undefined) queryError('invalid_enum', 'time.basis is required');
    validateEnum(raw.time.basis, TIME_BASES, 'time basis');
    if (raw.time.last !== undefined && (raw.time.from !== undefined || raw.time.until !== undefined)) {
      queryError('conflicting_time_window', 'time.last cannot be combined with time.from or time.until');
    }

    if (raw.time.last !== undefined) {
      const last = raw.time.last;
      if (!last || typeof last !== 'object' || Array.isArray(last)) {
        queryError('invalid_last', 'time.last must be an object');
      }
      if (!Number.isInteger(last.value) || last.value <= 0) {
        queryError('invalid_last_value', 'time.last.value must be a positive integer');
      }
      if (last.unit === undefined) queryError('invalid_enum', 'time.last.unit is required');
      validateEnum(last.unit, ['hours', 'days'] as const, 'time.last unit');
      // Cap = "one year" as an intentional API semantic (8760h == 365d), not a
      // resource guard — the filter is O(n) regardless of window. Queries older
      // than a year should use absolute from/until, which have no cap.
      const maximum = last.unit === 'hours' ? 8760 : 365;
      if (last.value > maximum) {
        queryError('last_too_large', `time.last.value cannot exceed ${maximum} ${last.unit}`);
      }
      const unitMs = last.unit === 'hours' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      time = {
        basis: raw.time.basis,
        fromMs: nowMs - last.value * unitMs,
        untilMs: nowMs,
        untilExclusive: false,
      };
    } else {
      if (raw.time.from !== undefined && typeof raw.time.from !== 'string') {
        queryError('invalid_timestamp', 'time.from must be a valid ISO-8601 timestamp');
      }
      if (raw.time.until !== undefined && typeof raw.time.until !== 'string') {
        queryError('invalid_timestamp', 'time.until must be a valid ISO-8601 timestamp');
      }
      const fromMs = raw.time.from === undefined ? Number.NEGATIVE_INFINITY : parseIsoTimestamp(raw.time.from, 'time.from');
      const untilMs = raw.time.until === undefined ? Number.POSITIVE_INFINITY : parseIsoTimestamp(raw.time.until, 'time.until');
      if (fromMs >= untilMs) queryError('invalid_time_range', 'time.from must be before time.until');
      time = { basis: raw.time.basis, fromMs, untilMs, untilExclusive: true };
    }
  }

  return {
    ...raw,
    completion: raw.completion?.slice(),
    phases: raw.phases?.slice(),
    projects: raw.projects?.slice(),
    priorities: raw.priorities?.slice(),
    sources: raw.sources?.slice(),
    sprints: raw.sprints?.slice(),
    tagsAny: raw.tagsAny?.slice(),
    tagsAll: raw.tagsAll?.slice(),
    time,
    now: nowMs,
  };
}

export interface TaskQueryContext {
  /** Lowercased favorite project names (for effective-starred). */
  favoriteProjects?: ReadonlySet<string>;
  /** Set of task ids currently blocked by incomplete dependencies. REQUIRED
   *  when query.blocked is set — matchesTaskQuery throws if it's absent, so
   *  "caller never computed it" can't silently read as "nothing is blocked"
   *  (blocked:false would match every task, blocked:true none). */
  blockedIds?: ReadonlySet<string>;
}

/**
 * Ids of every task blocked by an incomplete dependency. ONE id→task map for the
 * whole list (isTaskBlocked in task-manager.ts builds a fresh Map per task,
 * which is quadratic over a few thousand rows). Semantics are identical:
 * a dependency id that resolves to nothing does NOT block, and only a
 * non-COMPLETE phase on a resolvable dependency does.
 */
export function computeBlockedIds(tasks: readonly Task[]): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const blocked = new Set<string>();
  for (const task of tasks) {
    if (!task.depends_on?.length) continue;
    const isBlocked = task.depends_on.some((depId) => {
      const dep = byId.get(depId);
      return dep !== undefined && dep.phase !== 'COMPLETE';
    });
    if (isBlocked) blocked.add(task.id);
  }
  return blocked;
}

function matchesArray<T>(actual: T, accepted: readonly T[] | undefined): boolean {
  return accepted === undefined || accepted.includes(actual);
}

function timestampInWindow(value: string | undefined, query: NonNullable<NormalizedTaskQuery['time']>): boolean {
  if (!value) return false;
  const timestamp = parseIsoTimestampValue(value);
  if (!Number.isFinite(timestamp) || timestamp < query.fromMs) return false;
  return query.untilExclusive ? timestamp < query.untilMs : timestamp <= query.untilMs;
}

/** Final query semantics. Different fields are AND-ed; arrays are OR-ed within a field. */
export function matchesTaskQuery(task: Task, query: NormalizedTaskQuery, ctx: TaskQueryContext = {}): boolean {
  if (query.completion !== undefined) {
    const completionPhases = query.completion.flatMap((completion) => COMPLETION_TO_PHASES[completion]);
    if (!completionPhases.includes(task.phase)) return false;
  }
  if (!matchesArray(task.phase, query.phases)) return false;

  const project = (task.project || '').toLowerCase();
  if (query.projects !== undefined
      && !query.projects.some((candidate) => candidate.toLowerCase() === project)) return false;
  // Legacy 'high'/'medium'/'low' rows must answer the canonical filter.
  if (!matchesArray(normalizeTaskPriority(task.priority), query.priorities)) return false;
  if (!matchesArray(task.source, query.sources)) return false;
  if (!matchesArray(task.sprint, query.sprints)) return false;

  const tags = task.tags ?? [];
  if (query.tagsAny !== undefined && !query.tagsAny.some((tag) => tags.includes(tag))) return false;
  if (query.tagsAll !== undefined && !query.tagsAll.every((tag) => tags.includes(tag))) return false;

  if (query.pinned !== undefined && Boolean(task.pinned) !== query.pinned) return false;
  if (query.unread !== undefined && Boolean(task.unread) !== query.unread) return false;
  if (query.blocked !== undefined) {
    if (!ctx.blockedIds) {
      throw new Error('matchesTaskQuery: query.blocked requires ctx.blockedIds (caller must compute the blocked set)');
    }
    if (ctx.blockedIds.has(task.id) !== query.blocked) return false;
  }
  if (query.starred !== undefined) {
    const effectiveStarred = task.starred === true
      || ctx.favoriteProjects?.has(project) === true;
    if (effectiveStarred !== query.starred) return false;
  }

  if (query.parentTaskId !== undefined && task.parent_task_id !== query.parentTaskId) return false;
  if (query.groupId !== undefined && task.group_id !== query.groupId) return false;

  if (query.time) {
    const createdMatches = timestampInWindow(task.created_at, query.time);
    const updatedMatches = timestampInWindow(task.updated_at, query.time);
    if (query.time.basis === 'created' && !createdMatches) return false;
    if (query.time.basis === 'updated' && !updatedMatches) return false;
    if (query.time.basis === 'created_or_updated' && !createdMatches && !updatedMatches) return false;
  }

  return true;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTimestampDesc(a: string | undefined, b: string | undefined): number {
  const aMs = a === undefined ? Number.NaN : Date.parse(a);
  const bMs = b === undefined ? Number.NaN : Date.parse(b);
  const aValid = Number.isFinite(aMs);
  const bValid = Number.isFinite(bMs);
  if (!aValid || !bValid) return aValid ? -1 : bValid ? 1 : 0;
  return bMs - aMs;
}

const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
  immediate: 4,
  important: 3,
  backlog: 2,
  none: 1,
};

/** Compare tasks by a query sort key, always ending with id ascending. */
export function compareTasksForQuery(a: Task, b: Task, sort: TaskQuerySort): number {
  let result = 0;
  if (sort === 'updated_desc') result = compareTimestampDesc(a.updated_at, b.updated_at);
  else if (sort === 'created_desc') result = compareTimestampDesc(a.created_at, b.created_at);
  else if (sort === 'completed_desc') result = compareTimestampDesc(a.completed_at, b.completed_at);
  else if (sort === 'priority') {
    const rank = (task: Task): number => PRIORITY_RANK[normalizeTaskPriority(task.priority)!] ?? 0;
    result = rank(b) - rank(a);
    if (result === 0) result = compareTimestampDesc(a.created_at, b.created_at);
  } else if (sort === 'title_asc') {
    result = a.title.localeCompare(b.title);
  }
  return result || compareStrings(a.id, b.id);
}
