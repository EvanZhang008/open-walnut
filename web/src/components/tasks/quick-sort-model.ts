/**
 * The board's Sort mode (2026-11-07, the user: "so many task, I want to organize but too hard too many
 * information, and not easy to quick sort"): a few cards at a time, each with one-tap decisions (a pin
 * tier, a snooze, done), so a pile gets sorted without reading the whole board. Pure: the queue, the
 * project cards and the snooze presets; QuickSortView draws them and writes through the board's own
 * paths (the tier bulk write, the start date a snooze is, the phase).
 */
import type { Task } from '@open-walnut/core';
import { isHiddenFromTaskLists } from '@open-walnut/org-tree';
import { taskUserState } from '@/utils/session-status';
import { parseDateLocal } from '@/components/common/DatePicker';
import type { CustomTierDef } from '@/api/focus';
import { boardMoveIds, homeBoardTier } from './home-board-model';
import { resolveParentRef } from './task-tree-index';

export type SortQueue = 'unsorted' | 'parked' | 'all';
export type SortView = 'tasks' | 'projects';

/** A Parked task untouched this long comes back for another look. */
export const PARKED_STALE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface SortItem {
  task: Task;
  tier: string;
  /** The ids a tier move takes along: the task and its subtasks in the same tier (the board's rule). */
  family: string[];
  idleDays: number;
  /** What the task says it is doing or asking now, if anything. */
  line: string;
}

export interface SortProject {
  key: string;
  label: string;
  /** The project's open, sortable tasks. */
  tasks: Task[];
  /** Its top-level tasks there: a snooze is written on these, their subtasks inherit it. */
  roots: Task[];
  tiers: Record<string, number>;
  unsorted: number;
  snoozed: number;
  lastTouched: string;
}

export const projectKey = (t: Pick<Task, 'project'>) => (t.project ?? '').trim().toLowerCase();

/** Open work the user sorts: not done, not an org node or plugin task, not an Ask conversation. */
export function isSortable(t: Task): boolean {
  if (isHiddenFromTaskLists(t) || taskUserState(t) === 'done' || t.phase === 'COMPLETE') return false;
  return !t.walnut_agent && !/^ask /i.test((t.project ?? '').trim());
}

/** Snoozed now: its own start date, else its nearest ancestor's, is still to come (core/snooze.ts). */
export function isSnoozed(t: Task, byId: ReadonlyMap<string, Task>, now: number): boolean {
  let cur: Task | undefined = t;
  for (let hops = 0; cur && hops <= 10; hops++) {
    if (cur.start_date) {
      const at = parseDateLocal(cur.start_date).getTime();
      return Number.isFinite(at) && at > now;
    }
    cur = cur.parent_task_id ? byId.get(cur.parent_task_id) : undefined;
  }
  return false;
}

function inQueue(t: Task, queue: SortQueue, custom: readonly CustomTierDef[], now: number): boolean {
  const tier = homeBoardTier(t, custom);
  if (queue === 'unsorted') return tier === 'unpinned';
  if (queue === 'parked') return tier === 'wait' && now - Date.parse(t.updated_at) >= PARKED_STALE_DAYS * DAY_MS;
  return true;
}

export function statusLine(t: Task): string {
  const s = t.user_status;
  // "Not started yet" says what the status label already says.
  if (s?.kind === 'not-started' && !s.ask) return '';
  return (s?.ask || s?.now || s?.next || s?.waitingOn || '').trim();
}

export interface QueueOptions {
  now?: number;
  query?: string;
  /** Only this project's tasks (a project card's "Sort its tasks"), by projectKey. */
  project?: string | null;
  /** Taken out of this round: skipped or already decided. */
  exclude?: ReadonlySet<string>;
}

/**
 * The cards to decide, oldest first. A card is a task with its subtasks in the same tier, as a board
 * move takes them; a subtask whose leader is in the queue too is part of that card, not one of its own.
 */
export function buildSortQueue(tasks: readonly Task[], custom: readonly CustomTierDef[], queue: SortQueue, opts: QueueOptions = {}): SortItem[] {
  const now = opts.now ?? Date.now();
  const text = (opts.query ?? '').trim().toLocaleLowerCase();
  const byId = new Map(tasks.map(t => [t.id, t]));
  const open = tasks.filter(isSortable);
  const candidates = open.filter(t => inQueue(t, queue, custom, now) && !isSnoozed(t, byId, now)
    && (opts.project == null || projectKey(t) === opts.project));
  const inSet = new Set(candidates.map(t => t.id));
  const items: SortItem[] = [];
  for (const task of candidates) {
    const parent = task.parent_task_id ? resolveParentRef(open, task.parent_task_id) : undefined;
    const tier = homeBoardTier(task, custom);
    if (parent && parent.id !== task.id && inSet.has(parent.id) && homeBoardTier(parent, custom) === tier) continue;
    if (opts.exclude?.has(task.id)) continue;
    const family = boardMoveIds(tasks, task, custom);
    if (text && !family.some(id => {
      const t = byId.get(id);
      return t && `${t.title} ${t.project ?? ''}`.toLocaleLowerCase().includes(text);
    })) continue;
    items.push({ task, tier, family, idleDays: Math.max(0, Math.floor((now - Date.parse(task.updated_at)) / DAY_MS)), line: statusLine(task) });
  }
  return items.sort((a, b) => a.task.updated_at.localeCompare(b.task.updated_at) || a.task.created_at.localeCompare(b.task.created_at));
}

/** One card per project: the ones with the most unsorted work first, then the least recently touched. */
export function buildSortProjects(tasks: readonly Task[], custom: readonly CustomTierDef[], opts: Omit<QueueOptions, 'project'> = {}): SortProject[] {
  const now = opts.now ?? Date.now();
  const text = (opts.query ?? '').trim().toLocaleLowerCase();
  const byId = new Map(tasks.map(t => [t.id, t]));
  const projects = new Map<string, SortProject>();
  for (const task of tasks.filter(isSortable)) {
    const key = projectKey(task);
    let p = projects.get(key);
    if (!p) projects.set(key, p = { key, label: task.project?.trim() || 'Inbox', tasks: [], roots: [], tiers: {}, unsorted: 0, snoozed: 0, lastTouched: '' });
    p.tasks.push(task);
    const tier = homeBoardTier(task, custom);
    p.tiers[tier] = (p.tiers[tier] ?? 0) + 1;
    const snoozed = isSnoozed(task, byId, now);
    if (snoozed) p.snoozed++;
    else if (tier === 'unpinned') p.unsorted++;
    if (task.updated_at > p.lastTouched) p.lastTouched = task.updated_at;
  }
  const result: SortProject[] = [];
  for (const p of projects.values()) {
    const ids = new Set(p.tasks.map(t => t.id));
    p.roots = p.tasks.filter(t => {
      const parent = t.parent_task_id ? resolveParentRef(p.tasks, t.parent_task_id) : undefined;
      return !parent || parent.id === t.id || !ids.has(parent.id);
    }).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    if (opts.exclude?.has(`project:${p.key}`)) continue;
    if (text && !`${p.label} ${p.tasks.map(t => t.title).join(' ')}`.toLocaleLowerCase().includes(text)) continue;
    result.push(p);
  }
  return result.sort((a, b) => b.unsorted - a.unsorted || a.lastTouched.localeCompare(b.lastTouched) || a.label.localeCompare(b.label));
}

/** The tasks a project's snooze writes: its top-level tasks, plus any task of it whose own start
 *  date would come before the snooze (an own date wins over the leader's, so it would show early). */
export function projectSnoozeTargets(project: SortProject, until: string): Task[] {
  const at = parseDateLocal(until).getTime();
  const roots = new Set(project.roots.map(t => t.id));
  return project.tasks.filter(t => roots.has(t.id) || (!!t.start_date && parseDateLocal(t.start_date).getTime() < at));
}

export interface SnoozePreset { id: string; label: string; hint: string; date: string }

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Morning of a day, local time: a snooze that runs out at 9:00, not at midnight. A day past the
 *  month's end rolls into the next month, except for a month step (`clampToMonth`): Jan 31 plus a
 *  month is Feb 28, not Mar 3. */
function morning(y: number, m: number, d: number, clampToMonth = false): Date {
  const day = clampToMonth ? Math.min(d, new Date(y, m + 1, 0).getDate()) : d;
  return new Date(y, m, day, 9, 0, 0, 0);
}

export function snoozePresets(nowMs = Date.now()): SnoozePreset[] {
  const now = new Date(nowMs);
  const y = now.getFullYear(); const m = now.getMonth(); const d = now.getDate();
  const tomorrow = morning(y, m, d + 1);
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  const week = morning(y, m, d + toMonday);
  const month = morning(y, m + 1, d, true);
  const quarter = morning(y, m + 3, d, true);
  const day = (x: Date) => `${MONTH[x.getMonth()]} ${x.getDate()}`;
  return [
    { id: 'tomorrow', label: 'Tomorrow', hint: `${DOW[tomorrow.getDay()]} 9:00`, date: tomorrow.toISOString() },
    { id: 'next-week', label: 'Next week', hint: `Mon ${day(week)}`, date: week.toISOString() },
    { id: 'next-month', label: 'Next month', hint: day(month), date: month.toISOString() },
    { id: 'three-months', label: 'In 3 months', hint: day(quarter), date: quarter.toISOString() },
  ];
}

/** When a snooze runs out, in words: "tomorrow 9:00", "Mon Nov 9", "Tue Feb 9 2027". */
export function snoozeUntilText(start: string, nowMs = Date.now()): string {
  const d = parseDateLocal(start);
  if (Number.isNaN(d.getTime())) return start;
  const now = new Date(nowMs);
  const time = start.includes('T') && (d.getHours() || d.getMinutes()) ? ` ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` : '';
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(d) - dayStart(now)) / DAY_MS);
  if (days === 0) return `today${time}`;
  if (days === 1) return `tomorrow${time}`;
  const year = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${DOW[d.getDay()]} ${MONTH[d.getMonth()]} ${d.getDate()}${year}${time}`;
}

/** Today as YYYY-MM-DD (the calendar's first pickable day). */
export function todayIso(nowMs = Date.now()): string {
  const n = new Date(nowMs);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

export function idleText(days: number): string {
  if (days < 1) return 'touched today';
  if (days < 14) return `${days} ${days === 1 ? 'day' : 'days'} untouched`;
  if (days < 60) return `${Math.floor(days / 7)} weeks untouched`;
  return `${Math.floor(days / 30)} months untouched`;
}
