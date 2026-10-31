/**
 * The Org page's rows, pure (pages/OrgPage.tsx). One row per org node the user
 * talks to, like channels in a chat app: Main pinned on top, then one row per
 * project (its lead, else its one task, else the Inbox's tasks).
 *
 *   state   alert   a task in the project needs the user: its session waits on an answer
 *                   or approval or failed, or its status (src/core/user-status.ts) says so
 *           working a task in the project is Working
 *           quiet   open work, nothing running (Waiting)
 *           parked  every open task is parked (WAITING) or snoozed
 *   order   alert, working, quiet, parked; inside one state the newest first
 *
 * Built from the task store and the org tree (@open-walnut/org-tree), so it
 * agrees with what Main reads; what waits on a prompt comes from the session
 * status store through the `probe` the page passes in.
 */

import type { Task } from '@open-walnut/core';
import type { OrgCounts, OrgProjectNode, OrgTaskNode, OrgTree } from '@open-walnut/org-tree';
import { CEO_LABEL, VP_LABEL, newsItem, newsLine, newsSubject, orgDisplayTitle, projectKey, teamNews, userStateOf, type TeamNewsTask } from '@open-walnut/org-tree';
import { USER_STATE_LABELS, checkedLine, stateCountLabel, type UserState, type UserStatus } from '@open-walnut/user-status';

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
  /** `needs` from its session: when the ask was last checked, or that it is not verified. */
  checked?: { text: string; unverified: boolean };
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
  /** The row's news in its tasks' own words: what needs the user, else the newest status (team-news.ts). */
  latest: string;
  /** When `latest` was written (ms), 0 = unknown. */
  latestAt: number;
  /** The task `latest` is about, when the line does not name it. */
  latestTask?: string;
  /** Newest activity among the row's tasks (ms), 0 = unknown. */
  lastAt: number;
  unread: boolean;
  /** Led by another project's VP (the org chart): that VP's own project. */
  vp?: string;
  /** The lead that leads the row's project now (its own, or the VP it is under). */
  leadId?: string;
  /** Its own lead was made as a VP to put projects under (Task.org_vp_only): the project is only its home. */
  vpOnly?: boolean;
  /** The name the user gave its own lead (Task.org_name), when it has one. */
  vpName?: string;
  /** A VP's row: the projects it leads besides its own, each its own row (the chart lists them).
   *  The row itself already counts their work: their teams, alerts and news are its own. */
  led?: ChannelRow[];
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
    // The task's own status decides what counts (the same one the Board and the counts read); a
    // live prompt only names how it needs the user.
    if (userStateOf(task) !== 'needs') continue;
    const hit = probe(task);
    // A failed session its status reads as Waiting (its host gone a moment, a clock or a trigger
    // still armed to bring it back) does not need the user, here as on the Board.
    if (hit && !(hit.kind === 'error' && status && status.state !== 'needs')) {
      out.push({ taskId: id, title: orgDisplayTitle(task), kind: hit.kind, ...(hit.tool ? { tool: hit.tool } : {}) });
    } else if (userStateOf(task) === 'needs') {
      const ask = status?.ask?.trim();
      const checked = checkedLine(status);
      out.push({ taskId: id, title: orgDisplayTitle(task), kind: 'needs', ...(ask ? { ask } : {}), ...(status?.source ? { source: status.source } : {}), ...(checked ? { checked } : {}) });
    }
  }
  return out;
}

/** A task put away on purpose: parked (WAITING) or snoozed (its start date still to come, which
 *  the server marks on its status, src/core/user-status.ts). Not every Waiting: the user's status
 *  Waiting also holds a turn that ended and work not started, which read as quiet. */
export function isParkedTask(t: Pick<Task, 'phase' | 'user_status'>): boolean {
  return t.phase === 'WAITING' || !!t.user_status?.snoozed;
}

/** `parked`: for each of the row's open tasks, whether it is parked (isParkedTask). */
export function channelState(counts: OrgCounts, alerts: readonly OrgAlertView[], parked?: readonly boolean[]): ChannelState {
  if (alerts.length) return 'alert';
  if (counts.running > 0) return 'working';
  if (parked ? parked.length > 0 && parked.every(Boolean) : counts.open > 0 && counts.waiting === counts.open) return 'parked';
  return 'quiet';
}

export function alertText(a: OrgAlertView): string {
  if (a.kind === 'question') return `Asks you: ${a.title}`;
  if (a.kind === 'permission') return `Wants approval${a.tool ? ` (${a.tool})` : ''}: ${a.title}`;
  if (a.kind === 'needs') return `Needs you: ${a.title}`;
  return `Failed: ${a.title}`;
}

/** The row's one line: what needs the user (with its ask), else the newest news of its tasks in
 *  their own status words (team-news.ts, the rule a lead's note uses too), with its time. */
function latestOf(nodes: readonly OrgTaskNode[], byId: ReadonlyMap<string, Task>, alerts: readonly OrgAlertView[]): { text: string; at: number; task?: string } {
  if (alerts.length) {
    const a = alerts[0]!;
    const task = byId.get(a.taskId);
    // A live prompt or a failure is as new as the task's last move; a status ask has its own time.
    const at = a.kind === 'needs' && task ? newsItem(task as TeamNewsTask).at : taskTime(task);
    return a.kind === 'needs' && a.ask ? { text: `Needs you: ${a.ask}`, at, task: a.title } : { text: alertText(a), at };
  }
  const top = teamNews(nodes.map((n) => byId.get(n.id)).filter((t): t is Task => !!t) as TeamNewsTask[])[0];
  if (!top) return { text: 'Nothing open', at: 0 };
  const task = newsSubject(top);
  return { text: newsLine(top), at: top.at, ...(task ? { task } : {}) };
}

function projectRow(p: OrgProjectNode, byId: ReadonlyMap<string, Task>, probe: AlertProbe): ChannelRow {
  const nodes = flattenNodes(p.teams);
  // A VP leading several projects waits on the user once, on its own project's row.
  const ids = [...(p.lead && !p.vp ? [p.lead.id] : []), ...nodes.map((n) => n.id)];
  const alerts = collectAlerts(ids, byId, probe);
  const lead = p.lead ? byId.get(p.lead.id) : undefined;
  const contact = p.contactId ? byId.get(p.contactId) : undefined;
  const name = p.project || 'Inbox';
  const latest = latestOf(nodes, byId, alerts);
  return {
    key: projectRowKey(p.project),
    kind: 'project',
    project: p.project,
    name,
    ...(p.contactId ? { contactId: p.contactId } : {}),
    contactTitle: lead ? orgDisplayTitle(lead) : p.lead ? orgDisplayTitle({ title: p.lead.title, org_role: 'lead' }) : contact?.title ?? (p.needsLead ? `${name} ${VP_LABEL}` : name),
    isLead: !!p.lead,
    counts: p.counts,
    state: channelState(p.counts, alerts, nodes.map((n) => isParkedTask(byId.get(n.id) ?? n))),
    alerts,
    needs: alerts.length,
    latest: latest.text,
    latestAt: latest.at,
    ...(latest.task ? { latestTask: latest.task } : {}),
    lastAt: Math.max(0, ...ids.map((id) => taskTime(byId.get(id)))),
    unread: !!(lead ?? contact)?.unread,
    ...(p.vp ? { vp: p.vp } : {}),
    ...(p.lead ? { leadId: p.lead.id } : {}),
    ...(lead?.org_vp_only && !p.vp ? { vpOnly: true } : {}),
    ...(lead?.org_name?.trim() && !p.vp ? { vpName: lead.org_name.trim() } : {}),
    node: p,
  };
}

/** By state, then by the time each row shows (its line's, else its last move), newest first. */
export function sortChannels(rows: readonly ChannelRow[]): ChannelRow[] {
  return [...rows].sort((a, b) =>
    STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || (b.latestAt || b.lastAt) - (a.latestAt || a.lastAt)
    || a.name.localeCompare(b.name));
}

export interface OrgChannels {
  main: ChannelRow;
  /** One row per VP: a project under another VP is part of that VP's row, not a row of its own. */
  rows: ChannelRow[];
  /** One row per project, each with its own work (the org chart's cards and their project lines). */
  projects: ChannelRow[];
}

function addCounts(a: OrgCounts, b: OrgCounts): OrgCounts {
  return { open: a.open + b.open, running: a.running + b.running, needsYou: a.needsYou + b.needsYou, waiting: a.waiting + b.waiting };
}

/** The projects a VP leads, folded into its own: the VP's row covers all their teams. A project
 *  whose VP's own project is not in the tree (nothing open there) keeps a row of its own. */
function vpNodes(projects: readonly OrgProjectNode[]): { node: OrgProjectNode; led: OrgProjectNode[] }[] {
  const own = new Map(projects.filter((p) => p.project && !p.vp).map((p) => [projectKey(p.project), p] as const));
  const led = new Map<string, OrgProjectNode[]>();
  for (const p of projects) {
    const vp = p.vp ? projectKey(p.vp) : '';
    if (vp && own.has(vp)) led.set(vp, [...(led.get(vp) ?? []), p]);
  }
  return projects
    .filter((p) => !(p.vp && own.has(projectKey(p.vp))))
    .map((p) => {
      const under = p.project && !p.vp ? led.get(projectKey(p.project)) ?? [] : [];
      if (!under.length) return { node: p, led: [] };
      return {
        node: { ...p, teams: [...p.teams, ...under.flatMap((u) => u.teams)], counts: under.reduce((c, u) => addCounts(c, u.counts), p.counts) },
        led: under,
      };
    });
}

export function buildChannels(tree: OrgTree, tasks: readonly Task[], probe: AlertProbe): OrgChannels {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const projects = sortChannels(tree.projects.map((p) => projectRow(p, byId, probe)));
  const rows = sortChannels(vpNodes(tree.projects).map(({ node, led }) => {
    const row = projectRow(node, byId, probe);
    return led.length ? { ...row, led: sortChannels(led.map((p) => projectRow(p, byId, probe))) } : row;
  }));
  const mainTask = tree.main ? byId.get(tree.main.id) : undefined;
  const mainAlerts = collectAlerts(tree.main ? [tree.main.id] : [], byId, probe);
  // Tasks, as Main's pills count them: what works, and what needs the user under every lead.
  const needYou = rows.reduce((n, r) => n + r.needs, 0);
  const working = tree.counts.running;
  const summary = [`${rows.length} ${rows.length === 1 ? VP_LABEL : `${VP_LABEL}s`}`];
  if (working) summary.push(stateCountLabel('working', working));
  if (needYou) summary.push(stateCountLabel('needs', needYou));
  const main: ChannelRow = {
    key: MAIN_KEY,
    kind: 'main',
    project: '',
    // Shown as the CEO (display only: the task stays "Main").
    name: CEO_LABEL,
    ...(tree.main ? { contactId: tree.main.id } : {}),
    contactTitle: CEO_LABEL,
    isLead: false,
    counts: tree.counts,
    // Main's own state: a prompt it waits on, else whether any lead works.
    state: mainAlerts.length ? 'alert' : working ? 'working' : 'quiet',
    alerts: mainAlerts,
    needs: mainAlerts.length + needYou,
    latest: mainAlerts.length ? alertText(mainAlerts[0]!) : summary.join(' · '),
    latestAt: taskTime(mainTask),
    lastAt: taskTime(mainTask),
    unread: !!mainTask?.unread,
  };
  return { main, rows, projects };
}

/** Rows whose project, contact or latest line holds every word of `q` (case-insensitive). */
export function filterChannels(rows: readonly ChannelRow[], q: string): ChannelRow[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((r) => {
    const hay = `${r.name}\n${r.contactTitle}\n${r.latest}\n${r.latestTask ?? ''}\n${(r.led ?? []).map((l) => l.name).join('\n')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The row that shows `key`: its own, or its VP's when the project is under another VP. */
export function rowOf(channels: OrgChannels, key: string | null): ChannelRow | undefined {
  if (!key) return undefined;
  if (key === MAIN_KEY) return channels.main;
  return channels.rows.find((r) => r.key === key || !!r.led?.some((l) => l.key === key));
}

/** The selected row: the URL's (a project under another VP selects that VP), else the first lead
 *  (the most urgent), else Main. */
export function pickChannel(channels: OrgChannels, key: string | null): ChannelRow {
  return rowOf(channels, key) || channels.rows[0] || channels.main;
}

/** A project another VP took over: listed under "Archived", with where it went. */
export interface MovedRow {
  key: string;
  project: string;
  /** The VP's row, and its name (the VP's own project). */
  vpKey: string;
  vpName: string;
  /** The project's own lead before: still open while it hands over, else closed. */
  from?: { id: string; title: string; open: boolean };
}

/** Every project a VP took over (its lead's `org_leads`), whether or not it has open work now. */
export function movedProjects(channels: OrgChannels, tasks: readonly Task[]): MovedRow[] {
  const out: MovedRow[] = [];
  const seen = new Set<string>();
  for (const lead of tasks) {
    if (lead.org_role !== 'lead' || lead.phase === 'COMPLETE' || !lead.org_leads?.length) continue;
    const home = projectKey(lead.project ?? '');
    const vp = rowOf(channels, projectRowKey(lead.project ?? ''));
    for (const name of lead.org_leads) {
      const key = projectKey(name);
      if (!name || key === home || seen.has(key)) continue;
      seen.add(key);
      const olds = tasks
        .filter((t) => t.org_role === 'lead' && t.id !== lead.id && projectKey(t.project ?? '') === key)
        .sort((a, b) => Number(a.phase === 'COMPLETE') - Number(b.phase === 'COMPLETE') || taskTime(b) - taskTime(a));
      const old = olds[0];
      out.push({
        key: projectRowKey(name),
        project: name,
        vpKey: vp?.key ?? projectRowKey(lead.project ?? ''),
        vpName: lead.org_name?.trim() || vp?.name || lead.project || 'Inbox',
        ...(old ? { from: { id: old.id, title: orgDisplayTitle(old), open: old.phase !== 'COMPLETE' } } : {}),
      });
    }
  }
  return out.sort((a, b) => a.project.localeCompare(b.project));
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
  /** The team's running tasks (itself first, then its workers, with their titles), whose
   *  live action the row shows (core/live-activity.ts). */
  live?: { id: string; title?: string }[];
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
    // Every running task of the team, also under Needs you (its ask leads; what runs shows below).
    const live = all.flatMap((x, i) => (x.userState === 'working' ? [i === 0 ? { id: x.id } : { id: x.id, title: x.title }] : []));
    return {
      id: n.id, title: n.title, workers: all.length - 1,
      lastAt: Math.max(...all.map((x) => taskTime(byId.get(x.id)))),
      ...(note ? { note } : {}),
      ...(live.length ? { live } : {}),
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
