/**
 * The Task view of an Org node (OrgNodeDetail.tsx), 2026-10-31, the user, translated: "inside status, just
 * call it task ... with four small tabs: needs you, working, snooze waiting, completed", the same names and order
 * as the home panel's status sections. Pure: which of the node's tasks is in which tab, read from
 * each task's own user status (userStateOf), the one reading the node's counts and the Brief's
 * sections use too. The Needs you tab holds the node's asks (its row's alerts, the cards).
 */
import type { Task } from '@open-walnut/core';
import { projectKey, userStateOf } from '@open-walnut/org-tree';
import { STATUS_SECTION_LABELS, isWatched, sortSectionTasks } from '@/components/tasks/status-sections';
import { readStatusLine } from './org-ask-form';
import { flattenNodes, taskTime, type ChannelRow, type OrgAlertView } from './org-channels-model';

// To read sits right under Needs you (2026-11-02): nothing asked, only something to read.
export type OrgTaskTab = 'needs' | 'read' | 'working' | 'waiting' | 'done';
export const ORG_TASK_TABS: readonly OrgTaskTab[] = ['needs', 'read', 'working', 'waiting', 'done'];
export const ORG_TASK_TAB_LABELS: Record<OrgTaskTab, string> = {
  needs: STATUS_SECTION_LABELS.needs, read: STATUS_SECTION_LABELS.read, working: STATUS_SECTION_LABELS.working,
  waiting: STATUS_SECTION_LABELS.waiting, done: STATUS_SECTION_LABELS.done,
};

/** The rail's tabs: the tasks the user watches first, then the four status tabs, as on the home
 *  panel. Watching is Home's own list (Task.watched_at; 2026-11-02, the user: "if it watching then
 *  concideras pinnedl rename this to watching ... same wathcing as regular home pannel"): the
 *  node's tab holds the watched tasks of its work. A node still opens on Needs you. */
export type OrgRailTab = 'watching' | OrgTaskTab;
export const ORG_RAIL_TABS: readonly OrgRailTab[] = ['watching', ...ORG_TASK_TABS];
export const ORG_RAIL_TAB_LABELS: Record<OrgRailTab, string> = { watching: STATUS_SECTION_LABELS.watching, ...ORG_TASK_TAB_LABELS };

/** A kept tab (usePageViewOf): one of the tabs, or the Pinned tab an older build kept, which is
 *  Watching now (railTabShown). */
export type KeptRailTab = OrgRailTab | 'pinned';
export const isKeptRailTab = (v: unknown): v is KeptRailTab => v === 'pinned' || (ORG_RAIL_TABS as readonly unknown[]).includes(v);
export const railTabShown = (v: KeptRailTab): OrgRailTab => (v === 'pinned' ? 'watching' : v);

/** Each status tab's dot. */
export const TAB_DOT: Record<OrgTaskTab, string> = {
  needs: 'var(--error, #FF3B30)', read: '#6d5bd0', working: 'var(--success, #34C759)', waiting: 'var(--fg-muted, #86868B)', done: 'var(--accent, #0A84FF)',
};

/** Completed work stays listed this long (the Board's Status view and the phone use the same). */
export const ORG_DONE_WINDOW_DAYS = 7;

export interface OrgTaskTabs {
  /** The watched tasks of this node's work, in the order they were watched, whatever their state. */
  watching: Task[];
  /** The cards: every ask in the node's work. */
  needs: OrgAlertView[];
  /** Nothing asked, only something to read (its words in user_status.waitingOn). */
  read: Task[];
  working: Task[];
  waiting: Task[];
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
  const of = (state: 'read' | 'working' | 'waiting') => [...open.values()].filter((t) => userStateOf(t) === state).sort(newest);
  const cutoff = now - ORG_DONE_WINDOW_DAYS * 24 * 60 * 60_000;
  const done = tasks
    .filter((t) => userStateOf(t) === 'done' && !t.plugin_only && projects.has(projectKey(t.project)) && doneAt(t) >= cutoff)
    .sort((a, b) => doneAt(b) - doneAt(a));
  // Watched, done or not: on the CEO every one Home's Watching lists, on a VP those of its projects.
  const watching = sortSectionTasks('watching', tasks.filter((t) => isWatched(t) && !t.plugin_only
    && (row.kind === 'main' || projects.has(projectKey(t.project)))));
  return { watching, needs, read: of('read'), working: of('working'), waiting: of('waiting'), done };
}

function dedupe(alerts: readonly OrgAlertView[]): OrgAlertView[] {
  const seen = new Set<string>();
  return alerts.filter((a) => (seen.has(a.taskId) ? false : (seen.add(a.taskId), true)));
}

/**
 * The watched tasks under each row of the Org list, each under one row: the VP whose work holds its
 * project (its own or one it leads), else the CEO. In the order they were watched.
 */
export function watchedByRow(main: ChannelRow | null, rows: readonly ChannelRow[], tasks: readonly Task[]): Map<string, Task[]> {
  const rowOf = new Map<string, string>();
  for (const r of rows) for (const p of [r.project, ...(r.led ?? []).map((l) => l.project)]) {
    const k = projectKey(p);
    if (!rowOf.has(k)) rowOf.set(k, r.key);
  }
  const out = new Map<string, Task[]>();
  for (const t of sortSectionTasks('watching', tasks.filter((x) => isWatched(x) && !x.plugin_only))) {
    const key = rowOf.get(projectKey(t.project)) ?? main?.key;
    if (key) out.set(key, [...(out.get(key) ?? []), t]);
  }
  return out;
}

/** The status tab a task's own state belongs to (a watched row wears its dot and its line). */
export const stateTab = (task: Task): OrgTaskTab => userStateOf(task);

/** The line under a task in its tab: what it does, or what it waits on, in its status's words. */
export function taskTabNote(task: Task, tab: OrgTaskTab): string {
  const s = task.user_status;
  // The task's own line for the state it is in (user_status.line), when it has one.
  const own = readStatusLine(s);
  if (own && tab !== 'done') return own.text;
  if (tab === 'read') return s?.waitingOn?.trim() ?? '';
  if (tab === 'working') return s?.now?.trim() ?? '';
  if (tab === 'waiting') return (s?.waitingOn ?? s?.now ?? '').trim();
  return '';
}

/** The node's own ask first, the rest in their order: every ask the Needs you tab counts is a card. */
export const ownAskFirst = (alerts: readonly OrgAlertView[], ownId: string | undefined): OrgAlertView[] =>
  [...alerts.filter((a) => a.taskId === ownId), ...alerts.filter((a) => a.taskId !== ownId)];
