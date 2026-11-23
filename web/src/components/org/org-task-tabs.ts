/**
 * The Task view of an Org node (OrgNodeDetail.tsx), 2026-10-31, the user, translated: "inside status, just
 * call it task ... with four small tabs: needs you, working, snooze waiting, completed", the same names and order
 * as the home panel's status sections. Pure: which of the node's tasks is in which tab, read from
 * each task's own user status (userStateOf), the one reading the node's counts and the Brief's
 * sections use too. The Needs you tab holds the node's asks (its row's alerts, the cards).
 */
import type { Task } from '@open-walnut/core';
import { projectKey, userStateOf } from '@open-walnut/org-tree';
import { shownState } from '@open-walnut/user-status';
import { STATUS_SECTION_LABELS, isNotStarted, isWatched, notStartedReason, sortSectionTasks } from '@/components/tasks/status-sections';
import { readStatusLine } from './org-ask-form';
import { askCount, flattenNodes, needsRowText, taskTime, type ChannelRow, type OrgAlertView } from './org-channels-model';
import { isPlaceholderColumnId } from '@/utils/column-ids';
import type { LayoutSlot } from '@/utils/layout-record';
import type { TaskTextField } from '@/utils/agent-text-source';

// A task with only a result or an answer to look at (To read) is under Needs you, a card with
// its line (2026-11-03, the user: "I dont wnat serpeate to read"): no tab of its own. A task nobody
// started has its own tab after Waiting, as on Home (2026-11-09, the user: not started is
// "completeli differnet" from wait and snooze; status-sections.ts isNotStarted).
export type OrgTaskTab = 'needs' | 'working' | 'waiting' | 'notstarted' | 'done';
/** A tab one user status fills (Not started is a part of Waiting). */
export type OrgStateTab = Exclude<OrgTaskTab, 'notstarted'>;
export const ORG_TASK_TABS: readonly OrgTaskTab[] = ['needs', 'working', 'waiting', 'notstarted', 'done'];
export const ORG_TASK_TAB_LABELS: Record<OrgTaskTab, string> = {
  needs: STATUS_SECTION_LABELS.needs, working: STATUS_SECTION_LABELS.working,
  waiting: STATUS_SECTION_LABELS.waiting, notstarted: STATUS_SECTION_LABELS.notstarted, done: STATUS_SECTION_LABELS.done,
};

/** The rail's sections (All tasks): the tasks the user watches first, then the status sections, as on the home
 *  panel. Watching is Home's own list (Task.watched_at; 2026-11-02, the user: "if it watching then
 *  concideras pinnedl rename this to watching ... same wathcing as regular home pannel"): the
 *  node's tab holds the watched tasks of its work. A node still opens on Needs you. */
export type OrgRailTab = 'watching' | OrgTaskTab;
export const ORG_RAIL_TABS: readonly OrgRailTab[] = ['watching', ...ORG_TASK_TABS];
export const ORG_RAIL_TAB_LABELS: Record<OrgRailTab, string> = { watching: STATUS_SECTION_LABELS.watching, ...ORG_TASK_TAB_LABELS };

/** Each status tab's dot. */
export const TAB_DOT: Record<OrgTaskTab, string> = {
  needs: 'var(--error, #FF3B30)', working: 'var(--success, #34C759)', waiting: 'var(--fg-muted, #86868B)',
  notstarted: 'var(--fg-muted, #86868B)', done: 'var(--accent, #0A84FF)',
};

/** Completed work stays listed this long (the Board's Status view and the phone use the same). */
export const ORG_DONE_WINDOW_DAYS = 7;

export interface OrgTaskTabs {
  /** The watched tasks of this node's work, in the order they were watched, whatever their state. */
  watching: Task[];
  /** The cards: every ask in the node's work, and every result or answer it has to look at. */
  needs: OrgAlertView[];
  working: Task[];
  waiting: Task[];
  /** Waiting because nobody started it, not snoozed: its own tab. */
  notstarted: Task[];
  done: Task[];
}

const doneAt = (t: Task) => Date.parse(t.completed_at ?? t.updated_at ?? '') || 0;

/**
 * A node's tasks by tab. A VP's node: the open tasks of its teams (its own project and every
 * project it leads), as the org tree counts them (the VP's own task is its chat, and only its ask
 * is a card), plus their projects' work completed in the window. Main's: every VP's, and its own
 * asks.
 */
export function orgTaskTabs(row: ChannelRow, rows: readonly ChannelRow[], tasks: readonly Task[], now: number): OrgTaskTabs {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  if (row.kind === 'router') return { watching: [], needs: row.alerts, working: [], waiting: [], notstarted: [], done: [] };
  const nodes = row.kind === 'main' ? rows : [row];
  const open = new Map<string, Task>();
  const projects = new Set<string>();
  for (const r of nodes) {
    // The Inbox row ('') holds the Inbox's work.
    for (const p of [r.project, ...(r.led ?? []).map((l) => l.project)]) projects.add(projectKey(p));
    for (const id of flattenNodes(r.node?.teams ?? []).map((n) => n.id)) {
      const t = byId.get(id);
      if (t && userStateOf(t) !== 'done') open.set(id, t);
    }
  }
  const needs = row.kind === 'main'
    ? dedupe([...row.alerts, ...rows.flatMap((r) => r.alerts)])
    : row.alerts;
  const newest = (a: Task, b: Task) => taskTime(b) - taskTime(a);
  const of = (state: 'working' | 'waiting') => [...open.values()].filter((t) => userStateOf(t) === state).sort(newest);
  const cutoff = now - ORG_DONE_WINDOW_DAYS * 24 * 60 * 60_000;
  const done = tasks
    .filter((t) => userStateOf(t) === 'done' && !t.plugin_only && projects.has(projectKey(t.project)) && doneAt(t) >= cutoff)
    .sort((a, b) => doneAt(b) - doneAt(a));
  // Watched, done or not: on the CEO every one Home's Watching lists, on a VP those of its projects.
  const watching = sortSectionTasks('watching', tasks.filter((t) => isWatched(t) && !t.plugin_only
    && (row.kind === 'main' || projects.has(projectKey(t.project)))));
  const waits = of('waiting');
  return { watching, needs, working: of('working'), waiting: waits.filter((t) => !isNotStarted(t)), notstarted: waits.filter((t) => isNotStarted(t)), done };
}

/**
 * Whether a node keeps Threads (the CEO, a VP): what the node IS, never whether its own task exists
 * yet. Its header then leads with its threads and draws no Needs you pill, and its side bar holds
 * Threads and the Brief (2026-11-03, the user: "the little red should be thread instead of need u,
 * also, even if no thread, show 0 thread"). Keyed on the row, so a CEO not started yet (no Main task,
 * no contactId) reads the same as once it runs, and its "1 Needs you" never vanishes on start
 * (2026-11-20). A router keeps none.
 */
export function nodeKeepsThreads(row: Pick<ChannelRow, 'kind' | 'isLead'>, contact?: Pick<Task, 'org_role'>): boolean {
  if (row.kind === 'router') return false;
  return row.kind === 'main' || row.isLead || contact?.org_role === 'main' || contact?.org_role === 'lead';
}

/** One count of a node's header: a tab and how many it counts (each opens its tab). */
export interface HeaderPill { tab: OrgTaskTab; n: number }

/**
 * The node header's state counts, from the same tabs the side bar's sections are made of, so the two
 * never disagree. Needs you counts asks only (a card only to read is no ask), approvals included, as
 * the Needs you section's own count does (`sectionCount`); a node that keeps Threads has no Needs
 * you pill (its threads lead its header instead, `nodeKeepsThreads`), its tasks' asks are in its Tasks.
 */
export function headerPills(tabs: OrgTaskTabs, approvals: number, keepsThreads: boolean): HeaderPill[] {
  const needs = askCount(tabs.needs) + approvals;
  const out: HeaderPill[] = [];
  if (!keepsThreads && needs > 0) out.push({ tab: 'needs', n: needs });
  for (const tab of ['working', 'waiting', 'notstarted'] as const) if (tabs[tab].length > 0) out.push({ tab, n: tabs[tab].length });
  return out;
}

/** The count a side-bar section's heading shows: Needs you counts asks and approvals (as the header
 *  does, `headerPills`), every other section what it lists. */
export function sectionCount(sec: OrgTaskSection, approvals: number): number {
  return sec.tab === 'needs' ? askCount(sec.alerts) + approvals : sec.tasks.length + sec.alerts.length;
}

function dedupe(alerts: readonly OrgAlertView[]): OrgAlertView[] {
  const seen = new Set<string>();
  return alerts.filter((a) => (seen.has(a.taskId) ? false : (seen.add(a.taskId), true)));
}

/** The task one panel of a strip shows (`task:<id>`, `session:<id>` or a bare session id), if known. */
export function slotTask(id: string, tasks: readonly Task[]): Task | undefined {
  const taskId = slotTaskIds([{ id, locked: false }], tasks)[0];
  return taskId ? tasks.find((t) => t.id === taskId) : undefined;
}

/** The tasks a strip's panels show, locked or not, in strip order (layout-record.ts): a Home column
 *  names a session, an Org panel `task:<id>` or `session:<id>`. A session id leads to the task holding
 *  it in any of its session fields; a placeholder or an unknown id names none. */
export function slotTaskIds(slots: readonly LayoutSlot[], tasks: readonly Task[]): string[] {
  if (!slots.length) return [];
  const bySession = new Map<string, string>();
  const ids = new Set<string>();
  for (const t of tasks) {
    ids.add(t.id);
    for (const sid of [t.session_id, t.exec_session_id, t.plan_session_id, ...(t.session_ids ?? []), ...(t.legacy_session_ids ?? [])]) {
      if (sid && !bySession.has(sid)) bySession.set(sid, t.id);
    }
  }
  const out: string[] = [];
  for (const s of slots) {
    if (isPlaceholderColumnId(s.id)) continue;
    const id = s.id.startsWith('task:') ? (ids.has(s.id.slice(5)) ? s.id.slice(5) : undefined)
      : bySession.get(s.id.startsWith('session:') ? s.id.slice(8) : s.id);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The row of the Org list a task belongs to: the VP whose work holds its project (its own or one it
 *  leads), else the CEO. */
export function taskRowKey(main: ChannelRow | null, rows: readonly ChannelRow[]): (t: Pick<Task, 'project'>) => string | undefined {
  const rowOf = new Map<string, string>();
  for (const r of rows) for (const p of [r.project, ...(r.led ?? []).map((l) => l.project)]) {
    const k = projectKey(p);
    if (!rowOf.has(k)) rowOf.set(k, r.key);
  }
  return (t) => rowOf.get(projectKey(t.project)) ?? main?.key;
}

/** The status tab a task's own state belongs to (a watched row wears its dot and its line): To
 *  read is under Needs you (shownState). */
export const stateTab = (task: Task): OrgStateTab => shownState(userStateOf(task));

/** The line under a task in its tab: what it does, or what it waits on, in its status's words. */
export function taskTabNote(task: Task, tab: OrgTaskTab): string {
  const s = task.user_status;
  // The task's own line for the state it is in (user_status.line), when it has one.
  const own = readStatusLine(s);
  if (own && tab !== 'done') return own.text;
  // Under Needs you (a watched row): what to do with it, then what it asks or has to read.
  if (tab === 'needs') return task.user_status ? needsRowText(task) : '';
  if (tab === 'working') return s?.now?.trim() ?? '';
  if (tab === 'waiting') return (s?.waitingOn ?? s?.now ?? '').trim();
  // The tab says it was never started; a failed start says why.
  if (tab === 'notstarted') return notStartedReason(task);
  return '';
}

/** Which stored words taskTabNote showed, so a path in them opens where those words were written. */
export function taskTabNoteField(task: Task, tab: OrgTaskTab): TaskTextField | null {
  const s = task.user_status;
  if (readStatusLine(s) && tab !== 'done') return 'line';
  if (tab === 'needs') return 'needs';
  if (tab === 'working') return 'report';
  if (tab === 'waiting') return s?.waitingOn != null ? 'waiting' : 'report';
  return null;
}

/** The node's own ask first, the rest in their order: every ask the Needs you tab counts is a card. */
export const ownAskFirst = (alerts: readonly OrgAlertView[], ownId: string | undefined): OrgAlertView[] =>
  [...alerts.filter((a) => a.taskId === ownId), ...alerts.filter((a) => a.taskId !== ownId)];

/**
 * All tasks: the node's work as one list, a section per tab in the rail's order (2026-11-12, the
 * user: "under tasks, just show all taks, and then board"; Status and Team were two views of it).
 * The phone's Org Tasks draws the same sections (OrgNodeTasksModel.statusSections). A watched task
 * is drawn in Watching only, as on Home and the phone, except that an ask stays its card under Needs
 * you (the card answers it in place) and one finished this week is under Completed. Sections with
 * nothing in them are left out.
 */
export interface OrgTaskSection { tab: OrgRailTab; tasks: Task[]; alerts: OrgAlertView[] }
/** Open on a node's first look: what is in front of the user now; what waits and what is done fold. */
export const ORG_SECTION_OPEN_BY_DEFAULT: ReadonlySet<OrgRailTab> = new Set<OrgRailTab>(['watching', 'needs', 'working']);
export function allTasksSections(tabs: OrgTaskTabs, alerts: readonly OrgAlertView[], approvals = 0): OrgTaskSection[] {
  const asks = new Set(alerts.map((a) => a.taskId));
  const doneIds = new Set(tabs.done.map((t) => t.id));
  // A watched task finished this week is under Completed; one finished before stays in Watching.
  const watching = tabs.watching.filter((t) => !asks.has(t.id) && (userStateOf(t) !== 'done' || !doneIds.has(t.id)));
  const inWatching = new Set(watching.map((t) => t.id));
  const rest = (list: readonly Task[]) => list.filter((t) => !inWatching.has(t.id) && !asks.has(t.id));
  const out: OrgTaskSection[] = [
    { tab: 'watching', tasks: watching, alerts: [] },
    { tab: 'needs', tasks: [], alerts: [...alerts] },
    { tab: 'working', tasks: rest(tabs.working), alerts: [] },
    { tab: 'waiting', tasks: rest(tabs.waiting), alerts: [] },
    { tab: 'notstarted', tasks: rest(tabs.notstarted), alerts: [] },
    { tab: 'done', tasks: tabs.done, alerts: [] },
  ];
  return out.filter((s) => s.tasks.length + s.alerts.length + (s.tab === 'needs' ? approvals : 0) > 0);
}
/** The section a header count leads to: its own, else Watching when every task of it is watched there. */
export function sectionFor(tab: OrgRailTab, sections: readonly OrgTaskSection[]): OrgRailTab | null {
  if (sections.some((s) => s.tab === tab)) return tab;
  return sections.some((s) => s.tab === 'watching') ? 'watching' : null;
}
/** A section is open by its default unless the user flipped it on this node. */
export const sectionOpen = (tab: OrgRailTab, flipped: readonly string[]): boolean =>
  ORG_SECTION_OPEN_BY_DEFAULT.has(tab) !== flipped.includes(tab);
export const isSectionFlips = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= ORG_RAIL_TABS.length && v.every((x) => (ORG_RAIL_TABS as readonly unknown[]).includes(x));
