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
import { flattenNodes, needsRowText, taskTime, type ChannelRow, type OrgAlertView } from './org-channels-model';
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

/** The rail's tabs: the tasks the user watches first, then the four status tabs, as on the home
 *  panel. Watching is Home's own list (Task.watched_at; 2026-11-02, the user: "if it watching then
 *  concideras pinnedl rename this to watching ... same wathcing as regular home pannel"): the
 *  node's tab holds the watched tasks of its work. A node still opens on Needs you. */
export type OrgRailTab = 'watching' | OrgTaskTab;
export const ORG_RAIL_TABS: readonly OrgRailTab[] = ['watching', ...ORG_TASK_TABS];
export const ORG_RAIL_TAB_LABELS: Record<OrgRailTab, string> = { watching: STATUS_SECTION_LABELS.watching, ...ORG_TASK_TAB_LABELS };

/** A kept tab (usePageViewOf): one of the tabs, the Pinned tab an older build kept, which is
 *  Watching now, or the To read tab one kept, which is Needs you now (railTabShown). */
export type KeptRailTab = OrgRailTab | 'pinned' | 'read';
export const isKeptRailTab = (v: unknown): v is KeptRailTab => v === 'pinned' || v === 'read' || (ORG_RAIL_TABS as readonly unknown[]).includes(v);
export const railTabShown = (v: KeptRailTab): OrgRailTab => (v === 'pinned' ? 'watching' : v === 'read' ? 'needs' : v);

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

function dedupe(alerts: readonly OrgAlertView[]): OrgAlertView[] {
  const seen = new Set<string>();
  return alerts.filter((a) => (seen.has(a.taskId) ? false : (seen.add(a.taskId), true)));
}

/**
 * The tasks whose session panel a strip keeps locked (layout-record.ts): a Home column names a session,
 * an Org panel `task:<id>` or `session:<id>`. A session id leads to the task holding it in any of its
 * session fields. In the order the strips hold them; a placeholder or an unknown id names none.
 */
export function lockedTaskIds(slots: readonly LayoutSlot[], tasks: readonly Task[]): string[] {
  return slotTaskIds(slots.filter((s) => s.locked), tasks);
}

/** The tasks a strip's panels show, locked or not, in strip order (the same id rules as lockedTaskIds). */
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

/** A task hung under a row of the Org list, and why: the user watches it, its session panel is locked, or both. */
export interface KeptTask { task: Task; watched: boolean; locked: boolean }

/**
 * The tasks hung under each row of the Org list (2026-11-02, the user: "if a taks is lock also show here,
 * show icon of watch or lock"), each under one row: the VP whose work holds its project (its own or one
 * it leads), else the CEO. The watched ones first in the order they were watched, then the ones only
 * locked, in their lock order. A lead's or Main's own task is its row already, so a lock alone never
 * hangs it under one.
 */
export function keptByRow(main: ChannelRow | null, rows: readonly ChannelRow[], tasks: readonly Task[], locked: readonly string[] = []): Map<string, KeptTask[]> {
  const rowOf = new Map<string, string>();
  for (const r of rows) for (const p of [r.project, ...(r.led ?? []).map((l) => l.project)]) {
    const k = projectKey(p);
    if (!rowOf.has(k)) rowOf.set(k, r.key);
  }
  const lockedSet = new Set(locked);
  const byId = locked.length ? new Map(tasks.map((t) => [t.id, t])) : new Map<string, Task>();
  const watched = sortSectionTasks('watching', tasks.filter((x) => isWatched(x) && !x.plugin_only));
  const lockedOnly = locked.map((id) => byId.get(id))
    .filter((t): t is Task => !!t && !isWatched(t) && !t.plugin_only && !t.org_role);
  const out = new Map<string, KeptTask[]>();
  for (const t of [...watched, ...lockedOnly]) {
    const key = rowOf.get(projectKey(t.project)) ?? main?.key;
    if (key) out.set(key, [...(out.get(key) ?? []), { task: t, watched: isWatched(t), locked: lockedSet.has(t.id) }]);
  }
  return out;
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
