/**
 * The Task view of an Org node (OrgNodeDetail.tsx), 2026-10-31, the user, translated: "inside status, just
 * call it task ... with four small tabs: needs you, working, snooze waiting, completed", the same names and order
 * as the home panel's status sections. Pure: which of the node's tasks is in which tab, read from
 * each task's own user status (userStateOf), the one reading the node's counts and the Brief's
 * sections use too. The Needs you tab holds the node's asks (its row's alerts, the cards).
 */
import type { Task } from '@open-walnut/core';
import { nodePins, projectKey, userStateOf } from '@open-walnut/org-tree';
import { STATUS_SECTION_LABELS } from '@/components/tasks/status-sections';
import { readStatusLine } from './org-ask-form';
import { flattenNodes, taskTime, type ChannelRow, type OrgAlertView } from './org-channels-model';

export type OrgTaskTab = 'needs' | 'working' | 'waiting' | 'done';
export const ORG_TASK_TABS: readonly OrgTaskTab[] = ['needs', 'working', 'waiting', 'done'];
export const ORG_TASK_TAB_LABELS: Record<OrgTaskTab, string> = {
  needs: STATUS_SECTION_LABELS.needs, working: STATUS_SECTION_LABELS.working,
  waiting: STATUS_SECTION_LABELS.waiting, done: STATUS_SECTION_LABELS.done,
};

/** The rail's tabs: the tasks the user pinned to the node first (2026-10-31, the user picked "B: a
 *  Pinned tab first"; org-pins.ts), then the four status tabs. A node still opens on Needs you. */
export type OrgRailTab = 'pinned' | OrgTaskTab;
export const ORG_RAIL_TABS: readonly OrgRailTab[] = ['pinned', ...ORG_TASK_TABS];
export const ORG_RAIL_TAB_LABELS: Record<OrgRailTab, string> = { pinned: 'Pinned', ...ORG_TASK_TAB_LABELS };

/** Each status tab's dot. */
export const TAB_DOT: Record<OrgTaskTab, string> = {
  needs: 'var(--error, #FF3B30)', working: 'var(--success, #34C759)', waiting: 'var(--fg-muted, #86868B)', done: 'var(--accent, #0A84FF)',
};

/** Completed work stays listed this long (the Board's Status view and the phone use the same). */
export const ORG_DONE_WINDOW_DAYS = 7;

export interface OrgTaskTabs {
  /** The tasks pinned to this node, in the order they were pinned, whatever their state. */
  pinned: Task[];
  /** The cards: every ask in the node's work. */
  needs: OrgAlertView[];
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
  const of = (state: 'working' | 'waiting') => [...open.values()].filter((t) => userStateOf(t) === state).sort(newest);
  const cutoff = now - ORG_DONE_WINDOW_DAYS * 24 * 60 * 60_000;
  const done = tasks
    .filter((t) => userStateOf(t) === 'done' && !t.plugin_only && projects.has(projectKey(t.project)) && doneAt(t) >= cutoff)
    .sort((a, b) => doneAt(b) - doneAt(a));
  // A pin is the user's: it shows whatever project the task is in now, done or not.
  const pinned = nodePins(tasks.filter((t) => !t.plugin_only), rowPinNodes(row));
  return { pinned, needs, working: of('working'), waiting: of('waiting'), done };
}

function dedupe(alerts: readonly OrgAlertView[]): OrgAlertView[] {
  const seen = new Set<string>();
  return alerts.filter((a) => (seen.has(a.taskId) ? false : (seen.add(a.taskId), true)));
}

/** The nodes a row shows the pins of: its own, and each project its VP leads (a project put under
 *  this VP after a task was pinned to it keeps that pin in view). */
export const rowPinNodes = (row: Pick<ChannelRow, 'key' | 'led'>): string[] => [row.key, ...(row.led ?? []).map((l) => l.key)];

/** The status tab a task's own state belongs to (a pinned row wears its dot and its line). */
export const stateTab = (task: Task): OrgTaskTab => userStateOf(task);

/** The line under a task in its tab: what it does, or what it waits on, in its status's words. */
export function taskTabNote(task: Task, tab: OrgTaskTab): string {
  const s = task.user_status;
  // The task's own line for the state it is in (user_status.line), when it has one.
  const own = readStatusLine(s);
  if (own && tab !== 'done') return own.text;
  if (tab === 'working') return s?.now?.trim() ?? '';
  if (tab === 'waiting') return (s?.waitingOn ?? s?.now ?? '').trim();
  return '';
}
