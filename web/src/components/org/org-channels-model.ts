/**
 * The Org page's rows, pure (pages/OrgPage.tsx). One row per org node the user
 * talks to, like channels in a chat app: Main pinned on top, then one row per
 * project (its lead, else its one task, else the Inbox's tasks).
 *
 *   state   alert   a task in the project waits on the user's answer or approval,
 *                   or its session failed (what really needs the user)
 *           working a task in the project is In Progress
 *           quiet   open work, nothing running (handed back, to do)
 *           parked  every open task is parked (WAITING)
 *   order   alert, working, quiet, parked; inside one state the newest first
 *
 * Built from the task store and the org tree (@open-walnut/org-tree), so it
 * agrees with what Main reads; what waits on a prompt comes from the session
 * status store through the `probe` the page passes in.
 */

import type { Task } from '@open-walnut/core';
import type { OrgCounts, OrgProjectNode, OrgTaskNode, OrgTree } from '@open-walnut/org-tree';
import { projectKey } from '@open-walnut/org-tree';

export type ChannelState = 'alert' | 'working' | 'quiet' | 'parked';

export interface OrgAlertView {
  taskId: string;
  title: string;
  kind: 'question' | 'permission' | 'error';
  tool?: string;
}

/** What waits on the user in one task right now, or null. */
export type AlertProbe = (task: Task) => { kind: OrgAlertView['kind']; tool?: string } | null;

export interface ChannelRow {
  /** 'main' | `project:<key>`: the page's selection and URL value. */
  key: string;
  kind: 'main' | 'project';
  /** '' = the Inbox. */
  project: string;
  name: string;
  /** Who the user talks to here: Main, the lead, or the project's one task. Absent = no one yet. */
  contactId?: string;
  contactTitle: string;
  isLead: boolean;
  counts: OrgCounts;
  state: ChannelState;
  alerts: OrgAlertView[];
  latest: string;
  /** Newest activity among the row's tasks (ms), 0 = unknown. */
  lastAt: number;
  unread: boolean;
  node?: OrgProjectNode;
}

export const MAIN_KEY = 'main';
export const projectRowKey = (project: string) => `project:${projectKey(project)}`;

const STATE_ORDER: Record<ChannelState, number> = { alert: 0, working: 1, quiet: 2, parked: 3 };

export function taskTime(task: Pick<Task, 'updated_at' | 'last_session_update'> | undefined): number {
  if (!task) return 0;
  const a = Date.parse(task.updated_at ?? '');
  const b = Date.parse(task.last_session_update ?? '');
  return Math.max(Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0);
}

/** Every task node under `nodes`, workers included, depth first. */
export function flattenNodes(nodes: readonly OrgTaskNode[]): OrgTaskNode[] {
  const out: OrgTaskNode[] = [];
  const walk = (list: readonly OrgTaskNode[]) => { for (const n of list) { out.push(n); walk(n.workers); } };
  walk(nodes);
  return out;
}

function collectAlerts(ids: readonly string[], byId: ReadonlyMap<string, Task>, probe: AlertProbe): OrgAlertView[] {
  const out: OrgAlertView[] = [];
  for (const id of ids) {
    const task = byId.get(id);
    if (!task) continue;
    const hit = probe(task);
    if (hit) out.push({ taskId: id, title: task.title, kind: hit.kind, ...(hit.tool ? { tool: hit.tool } : {}) });
  }
  return out;
}

export function channelState(counts: OrgCounts, alerts: readonly OrgAlertView[]): ChannelState {
  if (alerts.length) return 'alert';
  if (counts.running > 0) return 'working';
  if (counts.open > 0 && counts.waiting === counts.open) return 'parked';
  return 'quiet';
}

export function alertText(a: OrgAlertView): string {
  if (a.kind === 'question') return `Asks you: ${a.title}`;
  if (a.kind === 'permission') return `Wants approval${a.tool ? ` (${a.tool})` : ''}: ${a.title}`;
  return `Failed: ${a.title}`;
}

/** The row's one line: what needs the user, else what moves, else what waits. */
function latestLine(nodes: readonly OrgTaskNode[], byId: ReadonlyMap<string, Task>, alerts: readonly OrgAlertView[]): string {
  if (alerts.length) return alertText(alerts[0]!);
  const newest = (phase: Task['phase']) => nodes
    .filter((n) => n.phase === phase)
    .sort((a, b) => taskTime(byId.get(b.id)) - taskTime(byId.get(a.id)))[0];
  const running = newest('IN_PROGRESS');
  if (running) return `Working on: ${running.title}`;
  const handed = newest('NEED_ACTION');
  if (handed) return `Handed back: ${handed.title}`;
  const todo = newest('TODO');
  if (todo) return `To do: ${todo.title}`;
  const parked = newest('WAITING');
  if (parked) return `Parked: ${parked.title}`;
  return 'Nothing open';
}

function projectRow(p: OrgProjectNode, byId: ReadonlyMap<string, Task>, probe: AlertProbe): ChannelRow {
  const nodes = flattenNodes(p.teams);
  const ids = [...(p.lead ? [p.lead.id] : []), ...nodes.map((n) => n.id)];
  const alerts = collectAlerts(ids, byId, probe);
  const lead = p.lead ? byId.get(p.lead.id) : undefined;
  const contact = p.contactId ? byId.get(p.contactId) : undefined;
  const name = p.project || 'Inbox';
  return {
    key: projectRowKey(p.project),
    kind: 'project',
    project: p.project,
    name,
    ...(p.contactId ? { contactId: p.contactId } : {}),
    contactTitle: p.lead?.title ?? contact?.title ?? (p.needsLead ? `${name} lead` : name),
    isLead: !!p.lead,
    counts: p.counts,
    state: channelState(p.counts, alerts),
    alerts,
    latest: latestLine(nodes, byId, alerts),
    lastAt: Math.max(0, ...ids.map((id) => taskTime(byId.get(id)))),
    unread: !!(lead ?? contact)?.unread,
    node: p,
  };
}

export function sortChannels(rows: readonly ChannelRow[]): ChannelRow[] {
  return [...rows].sort((a, b) =>
    STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || b.lastAt - a.lastAt
    || a.name.localeCompare(b.name));
}

export interface OrgChannels {
  main: ChannelRow;
  rows: ChannelRow[];
}

export function buildChannels(tree: OrgTree, tasks: readonly Task[], probe: AlertProbe): OrgChannels {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const rows = sortChannels(tree.projects.map((p) => projectRow(p, byId, probe)));
  const mainTask = tree.main ? byId.get(tree.main.id) : undefined;
  const mainAlerts = collectAlerts(tree.main ? [tree.main.id] : [], byId, probe);
  const needYou = rows.filter((r) => r.state === 'alert').length;
  // Leads with work running, red ones too: "working" and "needs you" are not exclusive here.
  const working = rows.filter((r) => r.counts.running > 0).length;
  const summary = [`${rows.length} ${rows.length === 1 ? 'lead' : 'leads'}`];
  if (working) summary.push(`${working} working`);
  if (needYou) summary.push(`${needYou} ${needYou === 1 ? 'needs' : 'need'} you`);
  const main: ChannelRow = {
    key: MAIN_KEY,
    kind: 'main',
    project: '',
    name: 'Main',
    ...(tree.main ? { contactId: tree.main.id } : {}),
    contactTitle: 'Main',
    isLead: false,
    counts: tree.counts,
    // Main's own state: a prompt it waits on, else whether any lead works.
    state: mainAlerts.length ? 'alert' : working ? 'working' : 'quiet',
    alerts: mainAlerts,
    latest: mainAlerts.length ? alertText(mainAlerts[0]!) : summary.join(' · '),
    lastAt: taskTime(mainTask),
    unread: !!mainTask?.unread,
  };
  return { main, rows };
}

/** Rows whose project, contact or latest line holds every word of `q` (case-insensitive). */
export function filterChannels(rows: readonly ChannelRow[], q: string): ChannelRow[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((r) => {
    const hay = `${r.name}\n${r.contactTitle}\n${r.latest}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The selected row: the URL's, else the first lead (the most urgent), else Main. */
export function pickChannel(channels: OrgChannels, key: string | null): ChannelRow {
  if (key === MAIN_KEY) return channels.main;
  return (key && channels.rows.find((r) => r.key === key)) || channels.rows[0] || channels.main;
}

// ── The Team tab: the row's work, one column per state ──

export type TeamColumnKey = 'alert' | 'working' | 'handed' | 'todo' | 'parked';

export interface TeamItem {
  id: string;
  title: string;
  phase: Task['phase'];
  workers: number;
  lastAt: number;
  /** Main's Team: the project row this item selects. */
  rowKey?: string;
}

export interface TeamColumn {
  key: TeamColumnKey;
  label: string;
  items: TeamItem[];
}

const COLUMN_LABEL: Record<TeamColumnKey, string> = {
  alert: 'Needs you', working: 'Working', handed: 'Handed back', todo: 'To do', parked: 'Parked',
};
const PHASE_COLUMN: Record<Task['phase'], TeamColumnKey | null> = {
  IN_PROGRESS: 'working', NEED_ACTION: 'handed', TODO: 'todo', WAITING: 'parked', COMPLETE: null,
};

function columnsOf(items: readonly (TeamItem & { column: TeamColumnKey })[]): TeamColumn[] {
  const order: TeamColumnKey[] = ['alert', 'working', 'handed', 'todo', 'parked'];
  return order
    .map((key) => ({
      key,
      label: COLUMN_LABEL[key],
      items: items.filter((i) => i.column === key).sort((a, b) => b.lastAt - a.lastAt).map(({ column: _c, ...rest }) => rest),
    }))
    .filter((c) => c.items.length > 0);
}

/** A project's teams by state; a team with a prompt waiting anywhere in it sits under Needs you. */
export function teamColumns(row: ChannelRow, tasks: readonly Task[]): TeamColumn[] {
  if (!row.node) return [];
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const alerted = new Set(row.alerts.map((a) => a.taskId));
  const items = row.node.teams.flatMap((n) => {
    const inAlert = alerted.has(n.id) || flattenNodes(n.workers).some((w) => alerted.has(w.id));
    const column = inAlert ? 'alert' : PHASE_COLUMN[n.phase];
    if (!column) return [];
    return [{
      id: n.id, title: n.title, phase: n.phase, workers: flattenNodes(n.workers).length,
      lastAt: Math.max(taskTime(byId.get(n.id)), ...flattenNodes(n.workers).map((w) => taskTime(byId.get(w.id)))),
      column,
    }];
  });
  return columnsOf(items);
}

/** Main's Team: its leads, by the same states as the list. */
export function mainTeamColumns(rows: readonly ChannelRow[]): TeamColumn[] {
  const column: Record<ChannelState, TeamColumnKey> = { alert: 'alert', working: 'working', quiet: 'handed', parked: 'parked' };
  return columnsOf(rows.map((r) => ({
    id: r.contactId ?? r.key, title: r.name, phase: 'IN_PROGRESS' as const, workers: r.counts.open,
    lastAt: r.lastAt, rowKey: r.key, column: column[r.state],
  }))).map((c) => (c.key === 'handed' ? { ...c, label: 'Quiet' } : c));
}

// ── Avatars ──

const PALETTE = ['#5B8DEF', '#E8833A', '#3BAA75', '#A35CDB', '#D9534F', '#2AA7B8', '#C69214', '#6C7A89', '#E05297', '#4F6BD8'];

export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function initials(name: string): string {
  const words = name.replace(/[-_.]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = Array.from(words[0]!);
  if (words.length === 1) return first.slice(0, 2).join('').toUpperCase();
  return (first[0]! + Array.from(words[1]!)[0]!).toUpperCase();
}
