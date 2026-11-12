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
import { shownTier } from '@/api/focus';
import { resolveParentRef } from './task-tree-index';

export type SortView = 'tasks' | 'projects';

const DAY_MS = 86_400_000;

/**
 * What the deck shows (2026-11-07, the user: Sort must not walk every task on the board; it opens on a
 * filter he can see and change). Empty `tiers` means every tier. `folder` takes its subfolders too.
 */
export interface SortFilter {
  tiers: string[];
  project: string | null;
  folder: string | null;
  /** Only tasks with no action for at least this many days (0: any). */
  idleDays: number;
}
/** The deck opens on Focus, the tier the user named, and keeps whatever he picks after that. */
export const DEFAULT_SORT_FILTER: SortFilter = { tiers: ['focus'], project: null, folder: null, idleDays: 0 };
export const IDLE_STEPS = [0, 3, 7, 30] as const;

export function isSortFilter(v: unknown): v is SortFilter {
  const f = v as SortFilter;
  return !!f && typeof f === 'object' && Array.isArray(f.tiers) && f.tiers.every(t => typeof t === 'string')
    && (f.project === null || typeof f.project === 'string') && (f.folder === null || typeof f.folder === 'string')
    && typeof f.idleDays === 'number';
}

/** How long a task has sat, from Walnut's record (never a guess). */
export interface TaskAges {
  /** Days since anything happened on it: it was made, its session started or resumed, or a field a
   *  person or its work writes moved (phase, tier or pin, title, note, summary, description, dates,
   *  priority, tags, project, folder, parent). Walnut's own status, read and order writes do not count. */
  idle: number;
  /** Days in the tier it is in now: since its pin or tier was last written, else since it was made. */
  inTier: number;
}

/** The timed fields (core/task-field-times.ts) whose change is something done to the task. */
const ACTION_FIELDS = ['title', 'phase', 'priority', 'project', 'group_id', 'due_date', 'start_date', 'end_date', 'pinned', 'focus_tier',
  'tags', 'summary', 'description', 'note', 'parent_task_id'] as const;
const ms = (iso: string | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : 0; };
const days = (from: number, now: number) => Math.max(0, Math.floor((now - from) / DAY_MS));

export function taskAges(t: Task, now = Date.now()): TaskAges {
  const at = t.field_at ?? {};
  const lastAction = Math.max(ms(t.created_at), ms(t.last_session_update), ms(t.phase_changed_at), ...ACTION_FIELDS.map(f => ms(at[f])));
  const tierSince = Math.max(ms(at.pinned), ms(at.focus_tier)) || ms(t.created_at);
  return { idle: days(lastAction, now), inTier: days(tierSince, now) };
}

/** The card's tags in plain words; a day or more only. */
export function ageTags(tier: string, tierLabel: string, ages: TaskAges): { kind: 'tier' | 'idle'; text: string }[] {
  const n = (d: number) => `${d} ${d === 1 ? 'day' : 'days'}`;
  const where = tier === 'unpinned' ? 'Unsorted' : `In ${tierLabel}`;
  // The same span twice reads as one fact: nothing happened since it landed there.
  if (ages.inTier >= 1 && ages.idle === ages.inTier) return [{ kind: 'idle', text: `${where}, no action for ${n(ages.idle)}` }];
  const tags: { kind: 'tier' | 'idle'; text: string }[] = [];
  if (ages.inTier >= 1) tags.push({ kind: 'tier', text: `${where} for ${n(ages.inTier)}` });
  if (ages.idle >= 1) tags.push({ kind: 'idle', text: `No action for ${n(ages.idle)}` });
  return tags;
}

export interface SortItem {
  task: Task;
  tier: string;
  /** The ids a tier move takes along: the task and its subtasks in the same tier (the board's rule). */
  family: string[];
  ages: TaskAges;
  /** What the task says it is doing or asking now, if anything. */
  line: string;
}

export interface SortProject {
  key: string;
  label: string;
  /** The project's open, sortable tasks the filter keeps. */
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

export function statusLine(t: Task): string {
  const s = t.user_status;
  // "Not started yet" says what the status label already says.
  if (s?.kind === 'not-started' && !s.ask) return '';
  return (s?.ask || s?.now || s?.next || s?.waitingOn || '').trim();
}

export interface QueueOptions {
  now?: number;
  query?: string;
  /** The folder ids the folder filter covers (the folder and its subfolders). */
  folders?: ReadonlySet<string> | null;
  /** Taken out of this round: skipped or already decided. */
  exclude?: ReadonlySet<string>;
}

function matches(t: Task, filter: SortFilter, custom: readonly CustomTierDef[], folders: ReadonlySet<string> | null | undefined, now: number, withProject = true): boolean {
  // A filter kept from before Parked was retired names `wait`: it reads Satellite, its tasks' column.
  if (filter.tiers.length && !filter.tiers.some((id) => shownTier(id) === homeBoardTier(t, custom))) return false;
  if (withProject && filter.project !== null && projectKey(t) !== filter.project) return false;
  if (folders && !(t.group_id && folders.has(t.group_id))) return false;
  return !filter.idleDays || taskAges(t, now).idle >= filter.idleDays;
}

/** How many open, unsnoozed tasks each tier holds under the rest of the filter (the tier chips' counts). */
export function tierCounts(tasks: readonly Task[], custom: readonly CustomTierDef[], filter: SortFilter, opts: QueueOptions = {}): Record<string, number> {
  const now = opts.now ?? Date.now();
  const byId = new Map(tasks.map(t => [t.id, t]));
  const out: Record<string, number> = {};
  for (const t of tasks) {
    if (!isSortable(t) || isSnoozed(t, byId, now) || !matches(t, { ...filter, tiers: [] }, custom, opts.folders, now)) continue;
    const tier = homeBoardTier(t, custom);
    out[tier] = (out[tier] ?? 0) + 1;
  }
  return out;
}

/**
 * The cards to decide, least recently acted on first. A card is a task with its subtasks in the same
 * tier, as a board move takes them; a subtask whose leader is in the deck too is part of that card.
 */
export function buildSortQueue(tasks: readonly Task[], custom: readonly CustomTierDef[], filter: SortFilter, opts: QueueOptions = {}): SortItem[] {
  const now = opts.now ?? Date.now();
  const text = (opts.query ?? '').trim().toLocaleLowerCase();
  const byId = new Map(tasks.map(t => [t.id, t]));
  const open = tasks.filter(isSortable);
  const candidates = open.filter(t => !isSnoozed(t, byId, now) && matches(t, filter, custom, opts.folders, now));
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
    items.push({ task, tier, family, ages: taskAges(task, now), line: statusLine(task) });
  }
  return items.sort((a, b) => b.ages.idle - a.ages.idle || a.task.created_at.localeCompare(b.task.created_at));
}

/** One card per project over the tasks the filter keeps: the most unsorted first, then the least recently touched. */
export function buildSortProjects(tasks: readonly Task[], custom: readonly CustomTierDef[], filter: SortFilter, opts: QueueOptions = {}): SortProject[] {
  const now = opts.now ?? Date.now();
  const text = (opts.query ?? '').trim().toLocaleLowerCase();
  const byId = new Map(tasks.map(t => [t.id, t]));
  const projects = new Map<string, SortProject>();
  for (const task of tasks.filter(isSortable)) {
    if (!matches(task, filter, custom, opts.folders, now, false)) continue;
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

