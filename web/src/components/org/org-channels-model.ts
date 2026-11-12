/**
 * The Org page's rows, pure (pages/OrgPage.tsx). One row per org node the user
 * talks to, like channels in a chat app: Main pinned on top, then one row per
 * project (its lead, else its one task, else the Inbox's tasks).
 *
 *   state   alert   a task in the project needs the user: its session waits on an answer
 *                   or approval or failed, or its status (src/core/user-status.ts) says so,
 *                   or it has a result or an answer to look at (To read, shownState).
 *                   On the CEO's and a VP's own row only its Threads do (2026-11-03, the user:
 *                   "the little red should be thread instead of need u ... even if no thread,
 *                   show 0 thread"): the badge counts them, 0 in grey, and a task's ask there
 *                   is in its Tasks, never the node's red
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
import { threadCountLabel, threadLine, type ThreadCounts } from '@open-walnut/thread-view';
import { readAskForm, type AskForm } from './org-ask-form';
import {
  NEEDS_CATEGORY_LABELS, USER_STATE_LABELS, checkedLine, needsLineOf, shownState, stateCountLabel, storedUserState,
  type NeedsCategory, type ToRead, type UserState, type UserStatus,
} from '@open-walnut/user-status';

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
  /** `needs`: the shape its task gave the ask (user_status.askForm): a summary, More, how to answer. */
  form?: AskForm;
  /** `needs`: what the user does with it, the head of its line (NEEDS_CATEGORY_LABELS). */
  category?: NeedsCategory;
  /** `needs` with nothing asked, only this to read (To read, drawn under Needs you): no check line. */
  toRead?: ToRead;
  /** A subtask's ask: the top-level task it rolls up to (topLevelOf), shown first on the card,
   *  so a VP's or Main's Task view reads by top-level task. Answering it answers the subtask. */
  via?: { id: string; title: string };
}

/** The top-level task above a subtask (its root below Main or a VP), or undefined for a top-level one. */
export function topLevelOf(task: Task, byId: ReadonlyMap<string, Task>): Task | undefined {
  let cur = task;
  for (let hops = 0; hops < 12; hops++) {
    const parent = cur.parent_task_id ? byId.get(cur.parent_task_id) : undefined;
    if (!parent || parent.org_role || parent.phase === 'COMPLETE') break;
    cur = parent;
  }
  return cur.id === task.id ? undefined : cur;
}

/** What every ask card says about how fresh its ask is (2026-10-31, the user: every card shows when
 *  it was checked): its session's check, a prompt open in its session now, or Not verified. */
export function cardChecked(a: OrgAlertView): { text: string; unverified: boolean } | null {
  if (a.checked) return a.checked;
  // Nothing asked, only a result or an answer to look at: there is no ask to check.
  if (a.toRead) return null;
  if (a.kind === 'question' || a.kind === 'permission') return { text: 'Open in its session now', unverified: false };
  if (a.kind === 'error') return { text: 'Failed in its session now', unverified: false };
  return { text: 'Not verified', unverified: true };
}

/** A Needs you task's one line, "<Category>: <words>" ("Take a look: It answered your question"),
 *  or '' for a status with no category (needsLineOf). */
export function needsRowText(task: Pick<Task, 'user_status'>): string {
  const line = task.user_status ? needsLineOf(task.user_status) : null;
  if (!line) return '';
  const label = NEEDS_CATEGORY_LABELS[line.category];
  return line.text ? `${label}: ${line.text}` : label;
}

/** The head of a card's line: its category's word (Decide, Take a look, Review, Can close). */
export const alertCategoryLabel = (a: Pick<OrgAlertView, 'category'>): string | null => (a.category ? NEEDS_CATEGORY_LABELS[a.category] : null);

/** What waits on the user in one task's session right now, or null. */
export type AlertProbe = (task: Task) => { kind: Exclude<OrgAlertView['kind'], 'needs'>; tool?: string } | null;

export interface ChannelRow {
  /** 'main' | `project:<key>`: the page's selection and URL value. */
  key: string;
  kind: 'main' | 'project' | 'router';
  /** A router row for a task that routes by itself (Task.self_router), not an area router. */
  selfRouter?: boolean;
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
  /** How many things here need the user: its threads waiting on him, then the alerts; on Main,
   *  every row's and its own. */
  needs: number;
  /** Main's or a VP's own Threads (user_status.threads): shown first, before any task's ask. */
  threads?: ThreadCounts;
  /** The CEO's and a VP's own row: its badge is its threads his view shows, 0 included
   *  (absent on a row with no node that keeps Threads, whose badge counts its tasks' asks). */
  threadsBadge?: number;
  /** The row's news in its tasks' own words: what needs the user, else the newest status (team-news.ts). */
  latest: string;
  /** When `latest` was written (ms), 0 = unknown. */
  latestAt: number;
  /** The task `latest` is about, when the line does not name it. */
  latestTask?: string;
  /** `latest` names a thread he (or the node) pinned: the row marks it. */
  latestPinned?: boolean;
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
  const out = collectFlatAlerts(ids, byId, probe);
  // By top-level task: its own ask first, then the ones its subtasks roll up to it, in list order.
  const order = new Map<string, number>();
  out.forEach((a, i) => { const k = a.via?.id ?? a.taskId; if (!order.has(k)) order.set(k, i); });
  return out
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (order.get(x.a.via?.id ?? x.a.taskId)! - order.get(y.a.via?.id ?? y.a.taskId)!) || (x.a.via ? 1 : 0) - (y.a.via ? 1 : 0) || x.i - y.i)
    .map(({ a }) => a);
}

function collectFlatAlerts(ids: readonly string[], byId: ReadonlyMap<string, Task>, probe: AlertProbe): OrgAlertView[] {
  const out: OrgAlertView[] = [];
  for (const id of ids) {
    const task = byId.get(id);
    if (!task) continue;
    const status = task.user_status;
    // The task's own status decides what counts (the same one the Board and the counts read); a
    // live prompt only names how it needs the user. A task with only something to read is a card
    // too, under Needs you (shownState, 2026-11-03).
    if (shownState(userStateOf(task)) !== 'needs') continue;
    // A node waiting on him through its Threads is counted and drawn as its threads, not a card.
    if (status?.source === 'thread') continue;
    const hit = probe(task);
    // A failed session its status reads as Waiting (its host gone a moment, a clock or a trigger
    // still armed to bring it back) does not need the user, here as on the Board.
    const top = topLevelOf(task, byId);
    const via = top ? { via: { id: top.id, title: orgDisplayTitle(top) } } : {};
    if (hit && !(hit.kind === 'error' && status && status.state !== 'needs')) {
      out.push({ taskId: id, title: orgDisplayTitle(task), kind: hit.kind, ...(hit.tool ? { tool: hit.tool } : {}), ...via });
    } else {
      const read = userStateOf(task) === 'read' ? status?.toRead ?? 'turn' : undefined;
      const line = status ? needsLineOf(status) : null;
      // To read: its words (what there is to read) are the card's line.
      const ask = (read ? line?.text : status?.ask)?.trim();
      const checked = read ? null : checkedLine(status);
      const form = read ? undefined : readAskForm(status);
      out.push({
        taskId: id, title: orgDisplayTitle(task), kind: 'needs', ...(ask ? { ask } : {}), ...(status?.source ? { source: status.source } : {}),
        ...(checked ? { checked } : {}), ...(form ? { form } : {}), ...(line ? { category: line.category } : {}), ...(read ? { toRead: read } : {}), ...via,
      });
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

/** Main's or a VP's own Threads that hold something for the user (the server's status counts them). */
export function threadsOf(t: Pick<Task, 'user_status'> | undefined): ThreadCounts | undefined {
  const c = t?.user_status?.threads;
  return c && c.shown > 0 ? c : undefined;
}

/** `parked`: for each of the row's open tasks, whether it is parked (isParkedTask). `keepsThreads`:
 *  the row is the CEO's or a VP's own, red only for its threads. */
export function channelState(counts: OrgCounts, alerts: readonly OrgAlertView[], parked?: readonly boolean[], threads?: ThreadCounts, keepsThreads = false): ChannelState {
  if (keepsThreads ? (threads?.shown ?? 0) > 0 : alerts.length > 0) return 'alert';
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
function latestOf(nodes: readonly OrgTaskNode[], byId: ReadonlyMap<string, Task>, alerts: readonly OrgAlertView[], threads?: ThreadCounts, node?: Task): { text: string; at: number; task?: string; pinned?: boolean } {
  // His own requests come first (2026-11-03, the user: "thread is better than need u ... thread
  // should be the first one in the list"); one that only shows an answer never hides a task's ask.
  if (threads?.shown) return { text: threadLine(threads), at: taskTime(node), ...(threads.titlePinned ? { pinned: true } : {}) };
  if (alerts.length) {
    const a = alerts[0]!;
    const task = byId.get(a.taskId);
    // A live prompt or a failure is as new as the task's last move; a status ask has its own time.
    const at = a.kind === 'needs' && task ? newsItem(task as TeamNewsTask).at : taskTime(task);
    return a.kind === 'needs' && a.ask ? { text: `${alertCategoryLabel(a) ?? 'Needs you'}: ${a.ask}`, at, task: a.title } : { text: alertText(a), at };
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
  // A VP's own Threads, on its own project's row (one leading several waits on him once).
  const keepsThreads = !!p.lead && !p.vp;
  const threads = lead && keepsThreads ? threadsOf(lead) : undefined;
  const latest = latestOf(nodes, byId, alerts, threads, lead);
  return {
    key: projectRowKey(p.project),
    kind: 'project',
    project: p.project,
    name,
    ...(p.contactId ? { contactId: p.contactId } : {}),
    contactTitle: lead ? orgDisplayTitle(lead) : p.lead ? orgDisplayTitle({ title: p.lead.title, org_role: 'lead' }) : contact?.title ?? (p.needsLead ? `${name} ${VP_LABEL}` : name),
    isLead: !!p.lead,
    counts: p.counts,
    state: channelState(p.counts, alerts, nodes.map((n) => isParkedTask(byId.get(n.id) ?? n)), threads, keepsThreads),
    alerts,
    needs: (threads?.needs ?? 0) + alerts.length,
    ...(threads ? { threads } : {}),
    ...(keepsThreads ? { threadsBadge: threads?.shown ?? 0 } : {}),
    latest: latest.text,
    latestAt: latest.at,
    ...(latest.task ? { latestTask: latest.task } : {}),
    ...(latest.pinned ? { latestPinned: true } : {}),
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
  /** One row per open router node (Task.org_role 'router'): its own nodes, never VPs. */
  routers: ChannelRow[];
  /** One row per VP: a project under another VP is part of that VP's row, not a row of its own. */
  rows: ChannelRow[];
  /** One row per project, each with its own work (the org chart's cards and their project lines). */
  projects: ChannelRow[];
}

/** What the channel helpers read: `routers` may be missing (a hand-made fixture, an older caller). */
export type OrgChannelsLike = Omit<OrgChannels, 'routers'> & { routers?: readonly ChannelRow[] };

/** A router's state in a word or two. Never claims collection runs: an unpaused router is only
 *  ready for the items routed to its area (some source accounts may not be readable yet). */
export function routerStateWord(paused: boolean, short = false): string {
  return paused ? 'Paused' : short ? 'Ready' : 'Ready for assigned items';
}

export function vpLinkCount(n: number): string {
  return `${n} VP ${n === 1 ? 'link' : 'links'}`;
}

/** An area's id read as words ("native_fixture" -> "Native fixture"), shown until the areas list names it. */
export function areaIdWords(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : id;
}

/** A router row's line: its area (by name once known), Paused or Ready, how many VPs it works with first. */
export function routerLine(task: Pick<Task, 'router_area_id' | 'router_paused' | 'router_links'>, areaNames: Readonly<Record<string, string>> = {}): string {
  const area = task.router_area_id ? areaNames[task.router_area_id] || areaIdWords(task.router_area_id) : 'Area not configured';
  return `${area} · ${routerStateWord(task.router_paused !== false, true)} · ${vpLinkCount(new Set(task.router_links ?? []).size)}`;
}

/** A row's line for a task that routes by itself (Task.self_router): it runs its own loop, how many VPs it works with. */
export function selfRouterLine(task: Pick<Task, 'self_router'>): string {
  return `Runs its own loop · ${vpLinkCount(new Set(task.self_router?.links ?? []).size)}`;
}

/** A task listed among the routers because it routes by itself: open, no org role, no plugin's own. */
export function isSelfRouterTask(task: Pick<Task, 'self_router' | 'org_role' | 'phase' | 'plugin_only'>): boolean {
  return !!task.self_router && !task.org_role && task.phase !== 'COMPLETE' && !task.plugin_only;
}

function addCounts(a: OrgCounts, b: OrgCounts): OrgCounts {
  // `toRead` may be missing from an older server's counts; it is shown under Needs you.
  return { open: a.open + b.open, running: a.running + b.running, needsYou: a.needsYou + b.needsYou, toRead: (a.toRead ?? 0) + (b.toRead ?? 0), waiting: a.waiting + b.waiting };
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

/**
 * How many VPs the rows are: every project's row. The Inbox row (tasks in no project) has no VP, so
 * it is never counted (review 2026-11-08: "VPs · 6" with five VPs); the chart and the phone count the
 * same way (`ceoLine`, `ChatOrgModel`).
 */
export function vpCount(rows: readonly ChannelRow[]): number {
  return rows.filter((row) => row.kind === 'project' && row.project !== '').length;
}

export function buildChannels(tree: OrgTree, tasks: readonly Task[], probe: AlertProbe, areaNames: Readonly<Record<string, string>> = {}): OrgChannels {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const projects = sortChannels(tree.projects.map((p) => projectRow(p, byId, probe)));
  const rows = sortChannels(vpNodes(tree.projects).map(({ node, led }) => {
    const row = projectRow(node, byId, probe);
    return led.length ? { ...row, led: sortChannels(led.map((p) => projectRow(p, byId, probe))) } : row;
  }));
  const mainTask = tree.main ? byId.get(tree.main.id) : undefined;
  const mainAlerts = collectAlerts(tree.main ? [tree.main.id] : [], byId, probe);
  // Tasks, as Main's pills count them: what works, and what needs the user under every lead.
  // The tasks' asks under every VP (Main's Needs you tab holds these cards); a VP's own threads are
  // counted as threads on its row, never as a Needs you here.
  const needYou = rows.reduce((n, r) => n + r.alerts.length, 0);
  const working = tree.counts.running;
  const mainThreads = threadsOf(mainTask);
  // Its own Threads lead the line, 0 included; the teams' asks are in its Tasks, never a Needs you here.
  const vps = vpCount(rows);
  const summary = [threadCountLabel(mainThreads?.shown ?? 0), `${vps} ${vps === 1 ? VP_LABEL : `${VP_LABEL}s`}`];
  if (working) summary.push(stateCountLabel('working', working));
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
    // Main's own state: its threads, else whether any lead works.
    state: mainThreads?.shown ? 'alert' : working ? 'working' : 'quiet',
    alerts: mainAlerts,
    needs: (mainThreads?.needs ?? 0) + mainAlerts.length + needYou,
    ...(mainThreads ? { threads: mainThreads } : {}),
    threadsBadge: mainThreads?.shown ?? 0,
    // Its threads name the newest one, then the rest of the line (summary[0] is their count).
    ...(mainThreads?.shown && mainThreads.titlePinned ? { latestPinned: true } : {}),
    latest: mainThreads?.shown ? [threadLine(mainThreads), ...summary.slice(1)].join(' · ') : summary.join(' · '),
    latestAt: taskTime(mainTask),
    lastAt: taskTime(mainTask),
    unread: !!mainTask?.unread,
  };
  const routers: ChannelRow[] = tasks.filter((task) => task.org_role === 'router' && task.phase !== 'COMPLETE').map((task) => ({
    key: `router:${task.id}`, kind: 'router', project: '', name: task.org_name || task.title,
    contactId: task.id, contactTitle: task.title, isLead: false,
    counts: { open: 1, running: task.user_status?.state === 'working' ? 1 : 0, needsYou: 0, toRead: 0, waiting: 0 },
    state: task.router_paused !== false ? 'parked' : task.user_status?.state === 'working' ? 'working' : 'quiet',
    alerts: collectAlerts([task.id], byId, probe), needs: 0,
    latest: routerLine(task, areaNames),
    latestAt: taskTime(task), lastAt: taskTime(task), unread: !!task.unread,
  }));
  // A task that routes by itself keeps its own state: Walnut never pauses it.
  for (const task of tasks) {
    if (!isSelfRouterTask(task)) continue;
    const state = task.user_status?.state;
    routers.push({
      key: `router:${task.id}`, kind: 'router', project: '', name: task.self_router?.name || task.title,
      contactId: task.id, contactTitle: task.title, isLead: false, selfRouter: true,
      counts: { open: 1, running: state === 'working' ? 1 : 0, needsYou: 0, toRead: 0, waiting: 0 },
      state: state === 'working' ? 'working' : 'quiet',
      alerts: collectAlerts([task.id], byId, probe), needs: 0,
      latest: selfRouterLine(task),
      latestAt: taskTime(task), lastAt: taskTime(task), unread: !!task.unread,
    });
  }
  return { main, rows, projects, routers };
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
export function rowOf(channels: OrgChannelsLike, key: string | null): ChannelRow | undefined {
  if (!key) return undefined;
  if (key === MAIN_KEY) return channels.main;
  return [...channels.rows, ...(channels.routers ?? [])].find((r) => r.key === key || !!r.led?.some((l) => l.key === key));
}

/** The selected row: the URL's (a project under another VP selects that VP), else the first lead
 *  (the most urgent), else Main. */
export function pickChannel(channels: OrgChannelsLike, key: string | null): ChannelRow {
  return rowOf(channels, key) || channels.rows[0] || channels.main;
}

/**
 * The node a page with no node named shows, decided ONCE the tasks are in and then kept while
 * its row lives. pickChannel's default is the most urgent lead, so read on every render it moved
 * under the user: Main while the tasks loaded, then the first VP a moment later, then another
 * whenever the order changed (2026-11-07, seen with a full screen sheet open on Main). Null
 * while the tasks load: the page shows no node rather than one it is about to leave.
 */
export function settleDefaultNode(prev: string | null, channels: OrgChannels, loading: boolean): string | null {
  if (prev && rowOf(channels, prev)) return prev;
  if (loading) return null;
  return pickChannel(channels, null).key;
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
export function movedProjects(channels: OrgChannelsLike, tasks: readonly Task[]): MovedRow[] {
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

/** To read is under Needs you (shownState): no column of its own. */
export type TeamColumnKey = Exclude<UserState, 'done' | 'read'>;

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

/** The task's own status line for its column: its ask or what it has to read (with what to do
 *  with it, its category), what it does, or what it waits on. */
function statusNote(task: Task | undefined, column: TeamColumnKey): { text: string; label?: string } | undefined {
  const s = task?.user_status;
  if (!s || shownState(storedUserState(s)) !== column) return undefined;
  if (column === 'needs') {
    const line = needsLineOf(s);
    return line?.text ? { text: line.text, label: NEEDS_CATEGORY_LABELS[line.category] } : undefined;
  }
  const text = (column === 'working' ? s.now : (s.waitingOn ?? s.now))?.trim();
  return text ? { text } : undefined;
}

/** The team's line for its column: the first of its tasks (itself, then its workers) in that
 *  state with words for it, named when it is a worker; under Needs you led by what to do with it
 *  ("Decide: <worker>: <ask>"). */
function teamNote(all: readonly OrgTaskNode[], byId: ReadonlyMap<string, Task>, column: TeamColumnKey): string | undefined {
  for (const [i, x] of all.entries()) {
    const note = statusNote(byId.get(x.id), column);
    if (!note) continue;
    const words = i === 0 ? note.text : `${x.title}: ${note.text}`;
    return note.label ? `${note.label}: ${words}` : words;
  }
  return undefined;
}

/** A project's teams by the user's status: a team with anything in it that needs the user (an
 *  ask, or a result or an answer to look at) sits under Needs you, else one with anything working
 *  under Working, else under Waiting. */
export function teamColumns(row: ChannelRow, tasks: readonly Task[]): TeamColumn[] {
  if (!row.node) return [];
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const alerted = new Set(row.alerts.map((a) => a.taskId));
  const items = row.node.teams.map((n) => {
    const all = [n, ...flattenNodes(n.workers)];
    const column: TeamColumnKey = all.some((x) => alerted.has(x.id) || shownState(x.userState) === 'needs') ? 'needs'
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

/** Every router wears this one colour, whatever its name, so a renamed router never looks like a VP. */
export const ROUTER_AVATAR_COLOR = '#64748b';

/** A row's avatar colour: a router's fixed one, else one picked from its name. */
export function rowAvatarColor(row: Pick<ChannelRow, 'kind' | 'name'>): string {
  return row.kind === 'router' ? ROUTER_AVATAR_COLOR : avatarColor(row.name);
}

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
