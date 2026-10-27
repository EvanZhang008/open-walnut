/**
 * The org chart's cards, pure. Two levels, as an org chart reads:
 *
 *   Main (CEO)
 *   └ one VP per project by default: the project's own name, its news in its tasks' own words
 *     with its time (team-news.ts: what needs the user, else the newest status), its counts, and
 *     how many things need the user. The user may put a project under another VP (drag it there):
 *     that VP's card then lists both projects, each still its own project.
 *
 * The cards are the Org page's channel rows (org-channels-model.ts), so the chart and the page
 * always show the same names and numbers. No invented names: a VP is named after its project,
 * or what the user named it (its lead's title, "<name> lead"). A VP the user made only to put
 * projects under (Task.org_vp_only) lists its own project only while it has open work.
 */
import type { ChannelRow } from './org-channels-model';
import { projectKey } from '@open-walnut/org-tree';

/** One project on a VP card. */
export interface VpProject {
  key: string;
  /** The project ('' is the Inbox). */
  project: string;
  name: string;
  /** Its counts ("1 working · 3 waiting"). */
  line: string;
  /** Its news (the row's latest line), when it was written (ms, 0 = unknown), and the task it is about. */
  news: string;
  newsAt: number;
  newsTask?: string;
  needsYou: number;
  row: ChannelRow;
}

/** One VP card: its own project first, then the projects put under it. */
export interface VpCard {
  key: string;
  project: string;
  /** The VP's name: its project's, or the one the user gave it. */
  name: string;
  /** Its own project, listed in `projects` unless the VP was made only to put projects under. */
  home: VpProject;
  /** Its lead (the CEO's VP), when it has one: the one whose name and instructions the user sets. */
  leadId?: string;
  vpOnly: boolean;
  /** 'VP' for a project; the Inbox is no one's team. */
  role: 'VP' | 'Inbox';
  line: string;
  /** The card's news: its most urgent project's, else its newest. */
  news: string;
  newsAt: number;
  newsTask?: string;
  needsYou: number;
  projects: VpProject[];
  row: ChannelRow;
}

/** "18 working · 12 waiting": what moves and what waits, else what is open, else nothing. */
export function vpLine(c: ChannelRow['counts']): string {
  const parts: string[] = [];
  if (c.running) parts.push(`${c.running} working`);
  if (c.waiting) parts.push(`${c.waiting} waiting`);
  if (parts.length) return parts.join(' · ');
  return c.open ? `${c.open} open` : 'Nothing open';
}

function projectOf(row: ChannelRow): VpProject {
  return {
    key: row.key, project: row.project, name: row.project || 'Inbox', line: vpLine(row.counts),
    news: row.latest, newsAt: row.latestAt, ...(row.latestTask ? { newsTask: row.latestTask } : {}), needsYou: row.needs, row,
  };
}

/** A VP's name as the chart says it: what the user named its lead, else its project's name. */
export function vpNameOf(row: ChannelRow): string {
  if (!row.project) return 'Inbox';
  return (!row.vp && row.vpName) || row.project;
}

/** The VP cards, in the rows' order: a project under another VP joins that VP's card. */
export function vpCards(rows: readonly ChannelRow[]): VpCard[] {
  const home = new Map(rows.filter((r) => r.project).map((r) => [projectKey(r.project), r] as const));
  // A project whose VP's own row is missing (that VP has nothing open) stands alone.
  const vpOf = (r: ChannelRow) => (r.vp && home.has(projectKey(r.vp)) ? projectKey(r.vp) : '');
  const cards: VpCard[] = [];
  const byKey = new Map<string, VpCard>();
  for (const row of rows) {
    if (vpOf(row)) continue;
    const home = projectOf(row);
    const vpOnly = !!row.vpOnly;
    const card: VpCard = {
      key: row.key, project: row.project, name: vpNameOf(row), home, vpOnly, ...(row.leadId ? { leadId: row.leadId } : {}),
      role: row.project ? 'VP' : 'Inbox',
      line: '', news: '', newsAt: 0, needsYou: 0, projects: vpOnly && row.counts.open === 0 ? [] : [home], row,
    };
    cards.push(card);
    if (row.project) byKey.set(projectKey(row.project), card);
  }
  for (const row of rows) {
    const vp = vpOf(row);
    if (vp) byKey.get(vp)?.projects.push(projectOf(row));
  }
  for (const card of cards) {
    // A hidden home still speaks for the VP itself: its own ask of the user is on that row.
    const all = card.projects[0] === card.home ? card.projects : [card.home, ...card.projects];
    card.needsYou = all.reduce((n, p) => n + p.needsYou, 0);
    card.line = card.projects.length === 0 ? 'No projects yet: drag one here'
      : card.projects.length === 1 ? card.projects[0]!.line : groupLine(card.projects);
    const top = [...all].sort((a, b) => Number(b.needsYou > 0) - Number(a.needsYou > 0) || b.newsAt - a.newsAt)[0]!;
    const hiddenHome = !card.projects.includes(card.home);
    // A hidden home's line is the VP's own; with nothing listed and nothing asked, there is no news.
    card.news = hiddenHome && top === card.home
      ? (top.needsYou || card.projects.length ? top.news : '')
      : card.projects.length === 1 ? top.news : `${top.name} · ${top.news}`;
    card.newsAt = card.news ? top.newsAt : 0;
    if (card.news && top.newsTask) card.newsTask = top.newsTask;
  }
  return cards;
}

function groupLine(projects: readonly VpProject[]): string {
  const sum = (k: 'running' | 'waiting') => projects.reduce((n, p) => n + p.row.counts[k], 0);
  const parts = [`${projects.length} projects`];
  if (sum('running')) parts.push(`${sum('running')} working`);
  if (sum('waiting')) parts.push(`${sum('waiting')} waiting`);
  return parts.join(' · ');
}

/** The CEO card's line: how many VPs, and how many of them have work moving. */
export function ceoLine(cards: readonly VpCard[]): string {
  const vps = cards.filter((c) => c.role === 'VP').length;
  const working = cards.filter((c) => c.projects.some((p) => p.row.counts.running > 0)).length;
  return `${vps} ${vps === 1 ? 'VP' : 'VPs'}${working ? ` · ${working} working` : ''}`;
}

/** The card a project sits on now. */
export function cardOf(cards: readonly VpCard[], projectKeyValue: string): VpCard | undefined {
  return cards.find((c) => c.projects.some((p) => p.key === projectKeyValue));
}

/** What a drop would do, said before it happens; null = nothing would change. */
export interface DropPlan {
  /** The project that moves, and the project whose VP leads it after ('' = its own). */
  project: string;
  vp: string;
  /** One line under the card while dragging. */
  hint: string;
  title: string;
  lines: string[];
  confirm: string;
}

/** A VP named in a sentence (2026-10-26, the user: "Routines's VP" reads badly): "the Routines VP". */
export const theVp = (name: string): string => `the ${name} VP`;
const TheVp = (name: string): string => `The ${name} VP`;

/** Drop `project` (a project on some card) onto `target` (a VP card, or null = a dedicated VP of its own). */
export function dropPlan(cards: readonly VpCard[], project: VpProject, target: VpCard | null): DropPlan | null {
  if (!project.project) return null; // the Inbox has no VP
  const from = cardOf(cards, project.key);
  if (!from) return null;
  const isHome = from.key === project.key;
  if (target === null) {
    if (isHome) return null; // already its own
    return {
      project: project.project,
      vp: '',
      hint: `Drop: ${project.name} gets a dedicated VP`,
      title: `Create a dedicated VP for ${project.name}?`,
      lines: [
        `${project.name} gets a dedicated VP again${from.projects.includes(from.home) ? `; ${theVp(from.name)} keeps ${from.home.name}` : ''}.`,
        `${TheVp(from.name)} sums up its work on ${project.name} for it.`,
        'No task changes project.',
      ],
      confirm: 'Create a dedicated VP',
    };
  }
  if (target.role !== 'VP' || target.key === from.key) return null;
  const carried = isHome ? from.projects.filter((p) => p !== from.home).map((p) => p.name) : [];
  const names = [project.name, ...carried];
  // Who lets go: the project's own lead (it steps down), or the VP it is under now (it stays).
  const letsGo = isHome ? project.row.node?.lead : from.row.node?.lead;
  const leaving = from.name;
  const handover = !letsGo
    ? null
    : !isHome
      ? `${TheVp(leaving)} sums up its work on ${project.name} for ${theVp(target.name)}.`
      : letsGo.hasSession
        ? `${TheVp(leaving)} sums up its work for ${theVp(target.name)}, then steps down.`
        : `${TheVp(leaving)} steps down; it never started, so there is nothing to hand over.`;
  return {
    project: project.project,
    vp: target.project,
    hint: `Drop: ${theVp(target.name)} takes over ${project.name}`,
    title: `Put ${project.name} under ${theVp(target.name)}?`,
    lines: [
      `${TheVp(target.name)} leads ${listNames(names)} from now on. ${names.length > 1 ? 'Each stays its own project' : `${project.name} stays its own project`}; no task changes project.`,
      ...(handover ? [handover] : []),
      'Drag it out again to undo.',
    ],
    confirm: `Put under ${theVp(target.name)}`,
  };
}

function listNames(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';
}
