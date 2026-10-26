/**
 * The org chart's cards, pure. Two levels, as an org chart reads:
 *
 *   Main (CEO)
 *   └ one VP per project by default: the project's own name, one line of status, how many
 *     things need the user. The user may put a project under another VP (drag it there):
 *     that VP's card then lists both projects, each still its own project.
 *
 * The cards are the Org page's channel rows (org-channels-model.ts), so the chart and the page
 * always show the same names and numbers. No invented names: a VP is named after its project.
 */
import type { ChannelRow } from './org-channels-model';
import { projectKey } from '@open-walnut/org-tree';

/** One project on a VP card. */
export interface VpProject {
  key: string;
  /** The project ('' is the Inbox). */
  project: string;
  name: string;
  line: string;
  needsYou: number;
  row: ChannelRow;
}

/** One VP card: its own project first, then the projects put under it. */
export interface VpCard {
  key: string;
  project: string;
  name: string;
  /** 'VP' for a project; the Inbox is no one's team. */
  role: 'VP' | 'Inbox';
  line: string;
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
  return { key: row.key, project: row.project, name: row.project || 'Inbox', line: vpLine(row.counts), needsYou: row.alerts.length, row };
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
    const card: VpCard = {
      key: row.key, project: row.project, name: row.project || 'Inbox', role: row.project ? 'VP' : 'Inbox',
      line: '', needsYou: 0, projects: [projectOf(row)], row,
    };
    cards.push(card);
    if (row.project) byKey.set(projectKey(row.project), card);
  }
  for (const row of rows) {
    const vp = vpOf(row);
    if (vp) byKey.get(vp)?.projects.push(projectOf(row));
  }
  for (const card of cards) {
    card.needsYou = card.projects.reduce((n, p) => n + p.needsYou, 0);
    card.line = card.projects.length === 1 ? card.projects[0]!.line : groupLine(card.projects);
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

/** Drop `project` (a project on some card) onto `target` (a VP card, or null = its own VP). */
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
      hint: `Drop: ${project.name} gets its own VP`,
      title: `Give ${project.name} its own VP?`,
      lines: [
        `${project.name} gets its own VP again; ${from.name}'s VP keeps ${from.name}.`,
        `${from.name}'s VP sums up its work on ${project.name} for it.`,
        'No task changes project.',
      ],
      confirm: 'Give it its own VP',
    };
  }
  if (target.role !== 'VP' || target.key === from.key) return null;
  const carried = isHome ? from.projects.slice(1).map((p) => p.name) : [];
  const names = [project.name, ...carried];
  // Who lets go: the project's own lead (it steps down), or the VP it is under now (it stays).
  const letsGo = isHome ? project.row.node?.lead : from.row.node?.lead;
  const leaving = isHome ? project.name : from.name;
  const handover = !letsGo
    ? null
    : !isHome
      ? `${leaving}'s VP sums up its work on ${project.name} for ${target.name}'s VP.`
      : letsGo.hasSession
        ? `${leaving}'s VP sums up its work for ${target.name}'s VP, then steps down.`
        : `${leaving}'s VP steps down; it never started, so there is nothing to hand over.`;
  return {
    project: project.project,
    vp: target.project,
    hint: `Drop: ${target.name}'s VP takes over ${project.name}`,
    title: `Put ${project.name} under ${target.name}'s VP?`,
    lines: [
      `${target.name}'s VP leads ${listNames(names)} from now on. ${names.length > 1 ? 'Each stays its own project' : `${project.name} stays its own project`}; no task changes project.`,
      ...(handover ? [handover] : []),
      'Drag it out again to undo.',
    ],
    confirm: `Put under ${target.name}`,
  };
}

function listNames(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';
}
