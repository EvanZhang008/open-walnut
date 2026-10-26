/**
 * The Org page's rows, pure (pages/OrgPage.tsx). One row per org node the user
 * talks to, like channels in a chat app: Main pinned on top, then one row per
 * project (its lead, else its one task, else the Inbox's tasks).
 *
 *   state   alert   a task in the project needs the user: its session waits on an answer
 *                   or approval or failed, or its status (src/core/user-status.ts) says so
 *           working a task in the project is Working
 *           quiet   open work, nothing running (Waiting)
 *           parked  every open task is parked (WAITING)
 *   order   alert, working, quiet, parked; inside one state the newest first
 *
 * Built from the task store and the org tree (@open-walnut/org-tree), so it
 * agrees with what Main reads; what waits on a prompt comes from the session
 * status store through the `probe` the page passes in.
 */

import type { Task } from '@open-walnut/core';
import type { OrgCounts, OrgProjectNode, OrgTaskNode, OrgTree } from '@open-walnut/org-tree';
import { projectKey, userStateOf } from '@open-walnut/org-tree';
import { USER_STATE_LABELS, type UserState, type UserStatus } from '@open-walnut/user-status';

export type ChannelState = 'alert' | 'working' | 'quiet' | 'parked';

export interface OrgAlertView {
  taskId: string;
  title: string;
  /** `needs`: the task's status says it needs the user (a decision letter, a Board choice,
   *  its session's own ask) with no prompt open in its session. */
  kind: 'question' | 'permission' | 'error' | 'needs';
  tool?: string;
  /** `needs`: what the user must do, in the session's words. */
  ask?: string;
  /** `needs`: where the ask is (its prompt, a letter, a Board choice, its failure, its own words). */
  source?: UserStatus['source'];
}

/** What waits on the user in one task's session right now, or null. */
export type AlertProbe = (task: Task) => { kind: Exclude<OrgAlertView['kind'], 'needs'>; tool?: string } | null;

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
  /** How many tasks here need the user: the alerts; on Main, every row's and its own. */
  needs: number;
  latest: string;
  /** Newest activity among the row's tasks (ms), 0 = unknown. */
  lastAt: number;
  unread: boolean;
  /** Led by another project's VP (the org chart): that VP's own project. */
  vp?: string;
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
    const status = task.user_status;
    const hit = probe(task);
    // A failed session its status reads as Waiting (its host gone a moment, a clock or a trigger
    // still armed to bring it back) does not need the user, here as on the Board.
    if (hit && !(hit.kind === 'error' && status && status.state !== 'needs')) {
      out.push({ taskId: id, title: task.title, kind: hit.kind, ...(hit.tool ? { tool: hit.tool } : {}) });
    } else if (userStateOf(task) === 'needs') {
      const ask = status?.ask?.trim();
      out.push({ taskId: id, title: task.title, kind: 'needs', ...(ask ? { ask } : {}), ...(status?.source ? { source: status.source } : {}) });
    }
  }
  return out;
}

/** `phases`: the row's open tasks. The counts are by the user's status now (src/core/user-status.ts),
 *  whose Waiting also holds a turn that ended and work not started, so "parked" reads the phases. */
export function channelState(counts: OrgCounts, alerts: readonly OrgAlertView[], phases?: readonly string[]): ChannelState {
  if (alerts.length) return 'alert';
  if (counts.running > 0) return 'working';
  if (phases ? phases.length > 0 && phases.every((ph) => ph === 'WAITING') : counts.open > 0 && counts.waiting === counts.open) return 'parked';
  return 'quiet';
}

export function alertText(a: OrgAlertView): string {
  if (a.kind === 'question') return `Asks you: ${a.title}`;
  if (a.kind === 'permission') return `Wants approval${a.tool ? ` (${a.tool})` : ''}: ${a.title}`;
  if (a.kind === 'needs') return `Needs you: ${a.title}`;
  return `Failed: ${a.title}`;
}

/** The row's one line: what needs the user, else what moves, else what waits (by the user's
 *  status, src/core/user-status.ts, the words every surface uses). */
function latestLine(nodes: readonly OrgTaskNode[], byId: ReadonlyMap<string, Task>, alerts: readonly OrgAlertView[]): string {
  if (alerts.length) return alertText(alerts[0]!);
  const newest = (state: UserState) => nodes
    .filter((n) => n.userState === state)
    .sort((a, b) => taskTime(byId.get(b.id)) - taskTime(byId.get(a.id)))[0];
  const running = newest('working');
  if (running) return `Working on: ${running.title}`;
  const waiting = newest('waiting');
  if (waiting) return `Waiting: ${waiting.title}`;
  return 'Nothing open';
}

function projectRow(p: OrgProjectNode, byId: ReadonlyMap<string, Task>, probe: AlertProbe): ChannelRow {
  const nodes = flattenNodes(p.teams);
  // A VP leading several projects waits on the user once, on its own project's row.
  const ids = [...(p.lead && !p.vp ? [p.lead.id] : []), ...nodes.map((n) => n.id)];
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
    state: channelState(p.counts, alerts, nodes.map((n) => n.phase)),
    alerts,
    needs: alerts.length,
    latest: latestLine(nodes, byId, alerts),
    lastAt: Math.max(0, ...ids.map((id) => taskTime(byId.get(id)))),
    unread: !!(lead ?? contact)?.unread,
    ...(p.vp ? { vp: p.vp } : {}),
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
  // Tasks, as Main's pills count them: what works, and what needs the user under every lead.
  const needYou = rows.reduce((n, r) => n + r.needs, 0);
  const working = tree.counts.running;
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
    needs: mainAlerts.length + needYou,
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

export type TeamColumnKey = Exclude<UserState, 'done'>;

export interface TeamItem {
  id: string;
  title: string;
  workers: number;
  lastAt: number;
  /** Where the task stands in its own status's words (what it asks, what it waits on, what it does). */
  note?: string;
  /** Main's Team: the project row this item selects. */
  rowKey?: string;
}

export interface TeamColumn {
  key: TeamColumnKey;
  label: string;
  items: TeamItem[];
}

const COLUMN_ORDER: readonly TeamColumnKey[] = ['needs', 'working', 'waiting'];

function columnsOf(items: readonly (TeamItem & { column: TeamColumnKey })[]): TeamColumn[] {
  return COLUMN_ORDER
    .map((key) => ({
      key,
      label: USER_STATE_LABELS[key],
      items: items.filter((i) => i.column === key).sort((a, b) => b.lastAt - a.lastAt).map(({ column: _c, ...rest }) => rest),
    }))
    .filter((c) => c.items.length > 0);
}

/** The task's own status line for its column: its ask, what it does, or what it waits on. */
function statusNote(task: Task | undefined, column: TeamColumnKey): string | undefined {
  const s = task?.user_status;
  if (!s || s.state !== column) return undefined;
  const text = column === 'needs' ? s.ask : column === 'working' ? s.now : (s.waitingOn ?? s.now);
  return text?.trim() || undefined;
}

/** The team's line for its column: the first of its tasks (itself, then its workers) in that
 *  state with words for it, named when it is a worker. */
function teamNote(all: readonly OrgTaskNode[], byId: ReadonlyMap<string, Task>, column: TeamColumnKey): string | undefined {
  for (const [i, x] of all.entries()) {
    const text = statusNote(byId.get(x.id), column);
    if (text) return i === 0 ? text : `${x.title}: ${text}`;
  }
  return undefined;
}

/** A project's teams by the user's status: a team with anything in it that needs the user sits
 *  under Needs you, else one with anything working under Working, else under Waiting. */
export function teamColumns(row: ChannelRow, tasks: readonly Task[]): TeamColumn[] {
  if (!row.node) return [];
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const alerted = new Set(row.alerts.map((a) => a.taskId));
  const items = row.node.teams.map((n) => {
    const all = [n, ...flattenNodes(n.workers)];
    const column: TeamColumnKey = all.some((x) => alerted.has(x.id) || x.userState === 'needs') ? 'needs'
      : all.some((x) => x.userState === 'working') ? 'working' : 'waiting';
    const note = teamNote(all, byId, column);
    return {
      id: n.id, title: n.title, workers: all.length - 1,
      lastAt: Math.max(...all.map((x) => taskTime(byId.get(x.id)))),
      ...(note ? { note } : {}),
      column,
    };
  });
  return columnsOf(items);
}

/** Main's Team: its leads by the same states, each with its row's line. */
export function mainTeamColumns(rows: readonly ChannelRow[]): TeamColumn[] {
  const column: Record<ChannelState, TeamColumnKey> = { alert: 'needs', working: 'working', quiet: 'waiting', parked: 'waiting' };
  return columnsOf(rows.map((r) => ({
    id: r.contactId ?? r.key, title: r.name, workers: r.counts.open,
    lastAt: r.lastAt, rowKey: r.key, note: r.latest, column: column[r.state],
  })));
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
