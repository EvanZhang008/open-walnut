/**
 * /tasks page view state that survives leaving the page — pure logic, no React.
 *
 * The /tasks route UNMOUNTS on every navigation (only the home page stays mounted),
 * so anything held in component state is gone when the user comes back. Sort,
 * grouping and collapse were already persisted; this module adds the three the
 * user notices first (2026-09-23: "task now doesn't [remember]"): the project the
 * rail was on, the query conditions, and the search text. Same store as the rest of
 * the page (localStorage), so a reload keeps them too.
 *
 * Readers validate: a stored shape from an older build must degrade to the default,
 * never to a crash on first paint.
 *
 * Tested in tests/web/tasks-page-persist.test.ts.
 */
import { DEFAULT_TASK_QUERY_FILTER_STATE, type TaskQueryFilterState } from './view-filter-model';
import type { TpSort } from './tasks-page-sort';

export const LS_TASKS_PAGE_PROJECT = 'walnut-tasks-page-project';
export const LS_TASKS_PAGE_SORT = 'walnut-tasks-page-sort';
export const LS_TASKS_PAGE_QUERY = 'walnut-tasks-page-query';
export const LS_TASKS_PAGE_SEARCH = 'walnut-tasks-page-search';

/** The query /tasks ships with: open tasks only (Todo on, Done off). */
export const TASKS_PAGE_DEFAULT_QUERY: TaskQueryFilterState = {
  ...DEFAULT_TASK_QUERY_FILTER_STATE,
  completion: ['todo', 'in_progress'],
};

/** The sort /tasks ships with: most recently updated first (the home panel's default too). */
export const TASKS_PAGE_DEFAULT_SORT: TpSort = { key: 'updated', dir: 'desc' };

/** Minimal Storage surface, so tests can pass a Map-backed fake. */
export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function safeStore(): KeyStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Active project: `null` = All Tasks, `''` = Inbox, else a project name. Stored as
 * JSON so the empty string (a real value: Inbox) survives the round trip; a missing
 * or malformed key reads as All Tasks.
 */
export function readActiveProject(store: KeyStore | null = safeStore()): string | null {
  try {
    const raw = store?.getItem(LS_TASKS_PAGE_PROJECT);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function writeActiveProject(project: string | null, store: KeyStore | null = safeStore()): void {
  try {
    if (project === null) store?.removeItem(LS_TASKS_PAGE_PROJECT);
    else store?.setItem(LS_TASKS_PAGE_PROJECT, JSON.stringify(project));
  } catch { /* quota / private mode — the page still works, it just forgets */ }
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isTriState = (v: unknown): v is true | false | undefined => v === undefined || typeof v === 'boolean';

/**
 * Field-by-field merge over the page default: each known key is taken from the
 * stored object only when its type is right, everything else keeps the default.
 * Unknown keys are ignored, so a stale build's extra fields cannot leak in.
 */
export function sanitizeQuery(v: unknown): TaskQueryFilterState {
  const d = TASKS_PAGE_DEFAULT_QUERY;
  if (!v || typeof v !== 'object') return { ...d };
  const o = v as Record<string, unknown>;
  const arr = <T extends string>(key: keyof TaskQueryFilterState): T[] =>
    (isStringArray(o[key]) ? o[key] : d[key]) as T[];
  const out: TaskQueryFilterState = {
    completion: arr('completion'),
    phases: arr('phases'),
    projects: arr('projects'),
    priorities: arr('priorities'),
    sources: arr('sources'),
    sprints: arr('sprints'),
    tagsAny: arr('tagsAny'),
    pinned: isTriState(o.pinned) ? o.pinned : d.pinned,
    blocked: isTriState(o.blocked) ? o.blocked : d.blocked,
    timeBasis: (typeof o.timeBasis === 'string' ? o.timeBasis : d.timeBasis) as TaskQueryFilterState['timeBasis'],
    timePreset: (o.timePreset === null || typeof o.timePreset === 'string' ? o.timePreset : d.timePreset) as TaskQueryFilterState['timePreset'],
    timeCustomValue: typeof o.timeCustomValue === 'number' && Number.isInteger(o.timeCustomValue) && o.timeCustomValue > 0
      ? o.timeCustomValue : d.timeCustomValue,
    timeCustomUnit: o.timeCustomUnit === 'hours' || o.timeCustomUnit === 'days' ? o.timeCustomUnit : d.timeCustomUnit,
    sort: (typeof o.sort === 'string' ? o.sort : d.sort) as TaskQueryFilterState['sort'],
  };
  return out;
}

export function readQuery(store: KeyStore | null = safeStore()): TaskQueryFilterState {
  try {
    const raw = store?.getItem(LS_TASKS_PAGE_QUERY);
    if (!raw) return { ...TASKS_PAGE_DEFAULT_QUERY };
    return sanitizeQuery(JSON.parse(raw));
  } catch {
    return { ...TASKS_PAGE_DEFAULT_QUERY };
  }
}

export function writeQuery(query: TaskQueryFilterState, store: KeyStore | null = safeStore()): void {
  try { store?.setItem(LS_TASKS_PAGE_QUERY, JSON.stringify(query)); } catch { /* see writeActiveProject */ }
}

const SORT_KEYS = new Set([
  'title', 'priority', 'due', 'start', 'session', 'project', 'phase', 'created', 'updated', 'completed',
]);

/**
 * Column sort. Absent = the shipped default; the literal `null` (stored when the
 * user cycles a header to "off") = manual/server order, which must NOT snap back
 * to the default on the next visit — turning sort off is a choice too.
 */
export function readSort(store: KeyStore | null = safeStore()): TpSort | null {
  try {
    const raw = store?.getItem(LS_TASKS_PAGE_SORT);
    if (raw === null || raw === undefined || raw === '') return { ...TASKS_PAGE_DEFAULT_SORT };
    const v: unknown = JSON.parse(raw);
    if (v === null) return null;
    if (v && typeof v === 'object') {
      const { key, dir } = v as { key?: unknown; dir?: unknown };
      if (typeof key === 'string' && SORT_KEYS.has(key) && (dir === 'asc' || dir === 'desc')) {
        return { key: key as TpSort['key'], dir };
      }
    }
    return { ...TASKS_PAGE_DEFAULT_SORT };
  } catch {
    return { ...TASKS_PAGE_DEFAULT_SORT };
  }
}

export function writeSort(sort: TpSort | null, store: KeyStore | null = safeStore()): void {
  try { store?.setItem(LS_TASKS_PAGE_SORT, JSON.stringify(sort)); } catch { /* see writeActiveProject */ }
}

export function readSearch(store: KeyStore | null = safeStore()): string {
  try { return store?.getItem(LS_TASKS_PAGE_SEARCH) ?? ''; } catch { return ''; }
}

export function writeSearch(search: string, store: KeyStore | null = safeStore()): void {
  try {
    if (search) store?.setItem(LS_TASKS_PAGE_SEARCH, search);
    else store?.removeItem(LS_TASKS_PAGE_SEARCH);
  } catch { /* see writeActiveProject */ }
}
