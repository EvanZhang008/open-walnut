/**
 * What moved in a lead's teams, told before its next message. 2026-10-26, the user: the VP
 * "should know the status of the task", reliably; workers are told not to send their lead
 * progress reports, so a lead that waits for one never hears. This note is built from
 * Walnut's own data only: each team task's status (src/core/user-status.ts) and its phase.
 *
 * Same shape as the main agent's org update (org-store.ts pendingOrgDigest): it rides the next
 * message that goes into the lead anyway, in the same row, so it never costs a turn. What needs
 * the user is the user's to see (the Org page shows it the moment the status says so,
 * team-news.ts); the lead hears it with its next message. One thing does wake the lead: a task
 * whose own status says it waits on this lead is the lead's work, so lead-waits.ts delivers the
 * note then (2026-10-26: three workers waited 21 hours on a lead that never heard).
 *
 *   first message   where its teams stand now: the projects it leads, what needs the user,
 *                   what waits on it, the newest news
 *   later           what moved since the last note: a project it now leads or no longer does,
 *                   a new ask for the user, a task that now waits on it, an ask that came
 *                   into a team task from outside the team (team-asks.ts: the user, the main
 *                   agent, another team), new status words, a task done, a new task.
 *                   Nothing moved, no note.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { createEnvelopeKit } from '../peers/envelope-kit.js';
import { buildOrgTree, projectKey, type OrgTaskNode } from './org-tree.js';
import { newsItem, shortTitle, teamNews, type TeamNewsItem, type TeamNewsTask } from './team-news.js';
import { askKey, readAsk } from './team-asks.js';

const kit = createEnvelopeKit();

/** What the lead was last told: when, each open team task's fingerprint then, and the projects it led. */
export interface TeamNoteState {
  at: string;
  seen: Record<string, string>;
  /** Project names ('Inbox' for ''); absent in a state an older Walnut wrote. */
  led?: string[];
}

/** An ask that went into a team task from outside the team (team-asks.ts). */
export interface TeamAsk {
  id: string;
  taskId: string;
  title: string;
  /** Who asked: "the user", or the asking task's title. */
  from: string;
  /** A person or another task; absent in a row an older Walnut wrote (from "the user" = a person). */
  by?: 'user' | 'peer';
  /** One line of what was asked: a question's own words. '' when the words are not known. */
  gist: string;
  at: string;
  /** The number of the task's question it is about (`[Question Q<n>]`), when it is in one, and the
   *  session that numbered it (each session numbers its own). */
  question?: number;
  sessionId?: string;
  /** `gist` is the question's own words, as its thread keeps them. */
  questionWords?: boolean;
  /** The newest message's words, when it is not the first (a person's chat). */
  latest?: string;
  /** Messages it stands for, when more than one: the same question or chat again. */
  count?: number;
  /** When the latest of them came. */
  lastAt?: string;
  /** The queue row it came in: a resend with the same id is the same ask. */
  messageId?: string;
  /** The rows of the later messages counted on it. */
  messageIds?: string[];
}

/** One line of the note: the pending asks that are one (team-asks.ts askKey), told once. */
export interface TeamAskLine extends TeamAsk {
  /** Every row it stands for, with the messages it counted on each, cleared once told. */
  rows: { id: string; count: number }[];
  count: number;
  lastAt: string;
}

/** The pending asks as the note tells them: one line per ask, in the order of its latest message. */
export function groupTeamAsks(asks: readonly TeamAsk[]): TeamAskLine[] {
  const lines = new Map<string, TeamAskLine>();
  for (const raw of asks) {
    const a = readAsk(raw);
    const key = askKey(a);
    const lastAt = a.lastAt ?? a.at;
    const line = lines.get(key);
    const count = a.count ?? 1;
    if (!line) { lines.set(key, { ...a, rows: [{ id: a.id, count }], count, lastAt }); continue; }
    line.rows.push({ id: a.id, count });
    line.count += count;
    if (a.questionWords && !line.questionWords) { line.gist = a.gist; line.questionWords = true; }
    else if (!line.gist && a.gist) line.gist = a.gist;
    else if (!line.question && lastAt >= line.lastAt && (a.latest || a.gist)) line.latest = a.latest || a.gist;
    if (lastAt > line.lastAt) line.lastAt = lastAt;
  }
  return [...lines.values()].sort((x, y) => x.lastAt.localeCompare(y.lastAt));
}

/** Everything asked of one task, as one line of the note (2026-10-27, the org's reflection: a
 *  task the user talks with filled the section one message a line). */
export interface TeamAskTaskLine {
  taskId: string;
  title: string;
  /** The user's messages in its chat, its questions included: how many, the latest, its words. */
  user?: { count: number; lastAt: string; words: string };
  /** Each other sender: how many messages, the latest, and what each ask said. */
  peers: { from: string; count: number; lastAt: string; gists: string[] }[];
  rows: { id: string; count: number }[];
  lastAt: string;
}

/** The asks, one line per task, in the order of each task's latest message. */
export function groupAsksByTask(lines: readonly TeamAskLine[]): TeamAskTaskLine[] {
  const out = new Map<string, TeamAskTaskLine>();
  for (const l of lines) {
    const g = out.get(l.taskId) ?? { taskId: l.taskId, title: l.title, peers: [], rows: [], lastAt: l.lastAt };
    out.set(l.taskId, g);
    g.rows.push(...l.rows);
    if (l.lastAt > g.lastAt) { g.lastAt = l.lastAt; g.title = l.title; }
    const words = l.question ? l.gist : l.latest || l.gist;
    if (l.by === 'user' || (!l.by && l.from === 'the user')) {
      const u = g.user ?? { count: 0, lastAt: '', words: '' };
      u.count += l.count;
      // The newest message's words; an older one's only while the newest says none.
      if (l.lastAt >= u.lastAt) { u.lastAt = l.lastAt; if (words) u.words = words; }
      else if (!u.words && words) u.words = words;
      g.user = u;
      continue;
    }
    let p = g.peers.find((x) => x.from === l.from);
    if (!p) { p = { from: l.from, count: 0, lastAt: l.lastAt, gists: [] }; g.peers.push(p); }
    p.count += l.count;
    if (l.lastAt > p.lastAt) p.lastAt = l.lastAt;
    if (l.gist && !p.gists.includes(l.gist)) p.gists.push(l.gist);
  }
  return [...out.values()].sort((x, y) => x.lastAt.localeCompare(y.lastAt));
}

/** The task lines a note shows (the newest), and so the asks it clears once told. */
export function shownAskTasks(asks: readonly TeamAskLine[]): TeamAskTaskLine[] {
  return groupAsksByTask(asks).slice(-TEAM_NOTE_MAX.asks);
}

/** A team task that waits on this lead, with what it waits for, in its status's words. */
export interface LeadWait extends TeamNewsItem {
  waitingOn: string;
}

export interface TeamNotePlan {
  /** 'none' = nothing moved; 'now' = the first note, where things stand; 'moved' = what changed. */
  kind: 'none' | 'now' | 'moved';
  needs: TeamNewsItem[];
  waits: LeadWait[];
  /** Team tasks the machine stopped, newly: Walnut resumes them, the lead restarts what it cannot. */
  machine: LeadWait[];
  moved: TeamNewsItem[];
  added: TeamNewsItem[];
  done: string[];
  asks: TeamAskLine[];
  /** The projects the lead leads now; and, against the last note, the ones it took over or let go. */
  led: string[];
  ledAdded: string[];
  ledRemoved: string[];
  next: TeamNoteState;
}

export interface TeamNoteContext {
  /** The lead the note is for: a task waiting on its leader waits on this lead when it is its leader. */
  leadId?: string;
  /** The projects it leads ('Inbox' for ''). */
  led?: readonly string[];
  /** Asks into its teams from outside them, not told yet. */
  asks?: readonly TeamAsk[];
}

/** The task's own status says it waits on its leader, and its leader is this lead. */
export function waitsOnLead(t: TeamNewsTask, leadId: string | undefined): boolean {
  return !!leadId && t.parent_task_id === leadId && t.user_status?.state === 'waiting' && t.user_status.kind === 'lead';
}

/** A seen value: the news fingerprint, marked while the task waits on this lead with when that
 *  wait began, so the same worker waiting again after another turn is a new wait. */
const LEAD_MARK = '+lead@';
function seenOf(t: TeamNewsTask, leadId: string | undefined): string {
  return teamFingerprint(t) + (waitsOnLead(t, leadId) ? `${LEAD_MARK}${t.phase_changed_at ?? t.user_status?.at ?? ''}` : '');
}
/** [fingerprint, the wait it marks (undefined: not waiting on the lead)]. */
function splitSeen(v: string | undefined): [string | undefined, string | undefined] {
  if (v === undefined) return [undefined, undefined];
  const at = v.indexOf(LEAD_MARK);
  return at < 0 ? [v, undefined] : [v.slice(0, at), v.slice(at + LEAD_MARK.length)];
}
const clean = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** Stuck: it meant to carry on and nothing will wake it, so it is its lead's to unblock. */
function isStuck(t: TeamNewsTask): boolean {
  return t.user_status?.state === 'waiting' && t.user_status.kind === 'stuck';
}

/** Stopped by the machine (user-status.ts machineStop), or waiting on it by its own report: Walnut
 *  resumes it once the cause clears, and the lead is the one to restart it when that fails. The
 *  user is not told (2026-10-28: a host drop listed two tasks under "Needs the user now"). */
export function isMachineStop(t: TeamNewsTask): boolean {
  const s = t.user_status;
  return !!s && s.state !== 'needs' && (s.stoppedBy === 'machine' || (s.state === 'waiting' && s.kind === 'machine'));
}

/** What a lead is told about: an ask for the user, the session's own words, or being stuck.
 *  A turn that only started or ended, the same words reported again, or what Walnut says a
 *  task waits on after a phase move ("Its worker (1 open)") is not news. */
function newsKey(t: TeamNewsTask): string {
  const item = newsItem(t);
  if (item.state === 'needs') return `needs|${item.words}`;
  return `|${(t.user_status?.now ?? '').replace(/\s+/g, ' ').trim()}|${isStuck(t) ? 'stuck' : ''}${isMachineStop(t) ? `|machine:${clean(t.user_status?.waitingOn)}` : ''}`;
}

export function teamFingerprint(t: TeamNewsTask): string {
  const raw = newsKey(t);
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** What the lead's next message carries, given what it was told and its teams now. */
export function planTeamNote(
  prev: TeamNoteState | undefined,
  given: readonly TeamNewsTask[],
  completed: readonly Pick<Task, 'id' | 'title'>[],
  now: string,
  ctx: TeamNoteContext = {},
): TeamNotePlan {
  // A task the status sync has not read yet (it does within 1.5 s of a move) says nothing: its
  // phase alone would read NEED_ACTION as "needs the user", which a turn that only ended is not.
  const open = given.map((t) => (t.user_status ? t
    : { ...t, user_status: { state: t.phase === 'IN_PROGRESS' ? 'working' as const : 'waiting' as const } }));
  const seen: Record<string, string> = {};
  for (const t of open) seen[t.id] = seenOf(t, ctx.leadId);
  const led = [...new Set(ctx.led ?? [])].sort((a, b) => a.localeCompare(b));
  const next: TeamNoteState = { at: now, seen, ...(ctx.led ? { led } : {}) };
  const news = teamNews(open);
  const byId = new Map(open.map((t) => [t.id, t] as const));
  const waitOf = (i: TeamNewsItem): LeadWait => ({ ...i, waitingOn: clean(byId.get(i.taskId)?.user_status?.waitingOn) });
  const waiting = (i: TeamNewsItem) => waitsOnLead(byId.get(i.taskId)!, ctx.leadId);
  const stopped = (i: TeamNewsItem) => isMachineStop(byId.get(i.taskId)!);
  const asks = groupTeamAsks(ctx.asks ?? []);
  const none = { added: [] as TeamNewsItem[], done: [] as string[], ledAdded: [] as string[], ledRemoved: [] as string[] };
  if (!prev) {
    const needs = news.filter((i) => i.state === 'needs');
    const waits = news.filter((i) => i.state !== 'needs' && waiting(i)).map(waitOf);
    const machine = news.filter((i) => i.state !== 'needs' && !waiting(i) && stopped(i)).map(waitOf);
    const moved = news.filter((i) => i.state !== 'needs' && !waiting(i) && !stopped(i) && i.reported).slice(0, 5);
    const any = needs.length + waits.length + machine.length + moved.length + asks.length > 0;
    return { kind: any ? 'now' : 'none', needs, waits, machine, moved, asks, led, ...none, next };
  }
  const key = (names: readonly string[]) => new Set(names.map(projectKey));
  const ledBefore = prev.led;
  const ledAdded = ctx.led && ledBefore ? led.filter((p) => !key(ledBefore).has(projectKey(p))) : [];
  const ledRemoved = ctx.led && ledBefore ? ledBefore.filter((p) => !key(led).has(projectKey(p))) : [];
  // A project it just took over is told as one line ("New to you"), not task by task.
  const fresh = key(ledAdded);
  const needs: TeamNewsItem[] = [];
  const waits: LeadWait[] = [];
  const machine: LeadWait[] = [];
  const moved: TeamNewsItem[] = [];
  const added: TeamNewsItem[] = [];
  for (const item of news) {
    const before = prev.seen[item.taskId];
    if (before === seen[item.taskId]) continue;
    const [was, wasWaiting] = splitSeen(before);
    const [is, isWaiting] = splitSeen(seen[item.taskId]);
    const t = byId.get(item.taskId)!;
    // What needs the user is said first, a new task's ask included.
    if (item.state === 'needs') { if (was !== is) needs.push(item); }
    // Then what now waits on this lead: its to act on. A wait that ended is no news by itself.
    else if (isWaiting !== undefined && isWaiting !== wasWaiting) waits.push(waitOf(item));
    // Then what the machine stopped: Walnut's to resume, the lead's when Walnut cannot.
    else if (isMachineStop(t)) { if (was !== is) machine.push(waitOf(item)); }
    else if (before === undefined) { if (!fresh.has(projectKey(t.project || 'Inbox'))) added.push(item); }
    // Words that went away (a report with nothing new) are no news.
    else if (was !== is && (item.reported || isStuck(t))) moved.push(item);
  }
  const done = completed.filter((t) => prev.seen[t.id] !== undefined).map((t) => t.title);
  const any = needs.length + waits.length + machine.length + moved.length + added.length + done.length + asks.length
    + ledAdded.length + ledRemoved.length > 0;
  return { kind: any ? 'moved' : 'none', needs, waits, machine, moved, added, done, asks, led, ledAdded, ledRemoved, next };
}

/** Most lines a section carries; the rest are counted. */
export const TEAM_NOTE_MAX = { needs: 6, waits: 8, machine: 8, asks: 6, moved: 8, added: 6, done: 6 } as const;
const WORDS_MAX = 240;

function ago(at: number, nowMs: number): string {
  if (!Number.isFinite(at) || !at) return '';
  const mins = Math.max(0, Math.round((nowMs - at) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

const STATE_WORD: Record<TeamNewsItem['state'], string> = { needs: 'needs the user', working: 'working', waiting: 'waiting', done: 'done' };

/** The note's text, inside a Walnut notification the lead reads as background. */
export function buildTeamNoteText(
  lead: Pick<Task, 'id' | 'title'>, plan: TeamNotePlan, prevAt: string | undefined, nowMs: number,
  projectOf: (taskId: string) => string = () => '',
): string {
  const label = (i: TeamNewsItem) => {
    const project = projectOf(i.taskId);
    return `${project ? `[${project}] ` : ''}"${shortTitle(i.title, 80)}"`;
  };
  const words = (i: TeamNewsItem) => (i.words ? `: ${shortTitle(i.words, WORDS_MAX)}` : '');
  const when = (i: TeamNewsItem) => [STATE_WORD[i.state], ago(i.at, nowMs)].filter(Boolean).join(', ');
  const section = (head: string, items: readonly TeamNewsItem[], max: number, line: (i: TeamNewsItem) => string) => {
    if (!items.length) return '';
    const shown = items.slice(0, max).map((i) => `- ${line(i)}`);
    if (items.length > max) shown.push(`- and ${items.length - max} more`);
    return `${head}\n${shown.join('\n')}\n`;
  };
  const since = ago(Date.parse(prevAt ?? ''), nowMs);
  const names = (list: readonly string[]) => list.map((p) => `"${p}"`).join(', ');
  const ledLine = (plan.led.length ? `You lead ${names(plan.led)}.` : '')
    + (plan.ledAdded.length ? ` New to you: ${names(plan.ledAdded)}.` : '')
    + (plan.ledRemoved.length ? ` No longer yours: ${names(plan.ledRemoved)}.` : '');
  const head = (plan.kind === 'now' ? 'Your teams now, from their own status:\n'
    : `Team update${since ? ` (last note ${since})` : ''}, from your teams' own status:\n`)
    + (ledLine ? `${ledLine.trim()}\n` : '');
  const waitLine = (w: LeadWait) => `${label(w)} (${ago(w.at, nowMs) || 'waiting'})${w.waitingOn ? `: ${shortTitle(w.waitingOn, WORDS_MAX)}` : ''}`
    + (w.words ? `. It said: ${shortTitle(w.words, WORDS_MAX)}` : '');
  const count = (n: number, lastAt: string) => {
    const latest = ago(Date.parse(lastAt), nowMs) || 'just now';
    return n > 1 ? `${n} messages, the latest ${latest}` : latest;
  };
  const quoted = (w: string) => `"${shortTitle(w, WORDS_MAX)}"`;
  const READ_IT = 'read it in the task (task_history)';
  const askLine = (g: TeamAskTaskLine) => {
    const parts: string[] = [];
    if (g.user) parts.push(`the user is talking with it in its own chat (${count(g.user.count, g.user.lastAt)}): ${g.user.words ? quoted(g.user.words) : READ_IT}`);
    for (const p of g.peers) {
      const said = p.gists.slice(-3).map(quoted).join(', ') + (p.gists.length > 3 ? ` and ${p.gists.length - 3} more` : '');
      parts.push(`${p.from} added (${count(p.count, p.lastAt)}): ${said || READ_IT}`);
    }
    return `${projectOf(g.taskId) ? `[${projectOf(g.taskId)}] ` : ''}"${shortTitle(g.title, 80)}": ${parts.join('; ')}`;
  };
  const askTasks = groupAsksByTask(plan.asks);
  const asksSection = askTasks.length
    ? `Asked of your teams by others:\n${askTasks.slice(-TEAM_NOTE_MAX.asks).map((g) => `- ${askLine(g)}`).join('\n')}`
      + `${askTasks.length > TEAM_NOTE_MAX.asks ? `\n- and ${askTasks.length - TEAM_NOTE_MAX.asks} more tasks, in the next note` : ''}\n`
    : '';
  const doneLine = plan.done.length
    ? `Done: ${plan.done.slice(0, TEAM_NOTE_MAX.done).map((t) => `"${shortTitle(t, 80)}"`).join(', ')}${plan.done.length > TEAM_NOTE_MAX.done ? ` and ${plan.done.length - TEAM_NOTE_MAX.done} more` : ''}\n`
    : '';
  const body = head
    + section('Needs the user:', plan.needs, TEAM_NOTE_MAX.needs, (i) => `${label(i)}${words(i)}`)
    + section('Waiting on you:', plan.waits, TEAM_NOTE_MAX.waits, (i) => waitLine(i as LeadWait))
    + section('Stopped by the machine, not the work (Walnut resumes these once the cause clears):', plan.machine ?? [], TEAM_NOTE_MAX.machine, (i) => waitLine(i as LeadWait))
    + asksSection
    + section(plan.kind === 'now' ? 'Latest:' : 'Changed:', plan.moved, TEAM_NOTE_MAX.moved, (i) => `${label(i)} (${when(i)})${words(i)}`)
    + section('New:', plan.added, TEAM_NOTE_MAX.added, (i) => `${label(i)} (${when(i)})${words(i)}`)
    + doneLine
    + (plan.machine?.length
      ? 'A task the machine stopped is yours to bring back, not the user\'s: once its cause clears (the host answers, the disk has room), check it (task_get) and restart it (task_restart) or send it a message if Walnut has not. Tell the user only what you cannot fix yourself (a sign-in or a payment only they can give). '
      : '')
    + (plan.waits.length
      ? 'The tasks under "Waiting on you" wait for you: read each (task_get) and answer or close it. The rest is background. The user sees the same on the Org page.'
      : 'Background, not a request: use it when it matters to what you do next. The user sees the same on the Org page. Detail: org_get or task_get.');
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', about: kit.sessionHandle(lead.title, undefined) || 'lead', 'about-task': lead.id, outcome: 'org-update', note: 'automated Walnut status notice' },
    body,
  });
}

// ── State and the pending note ──

const NOTES_FILE = path.join(WALNUT_HOME, 'org', 'team-notes.json');

async function readAll(): Promise<Record<string, TeamNoteState>> {
  try {
    const all = JSON.parse(await fs.readFile(NOTES_FILE, 'utf8')) as Record<string, TeamNoteState>;
    return all && typeof all === 'object' ? all : {};
  } catch {
    return {};
  }
}

function validState(s: TeamNoteState | undefined): TeamNoteState | undefined {
  return s && typeof s.at === 'string' && s.seen && typeof s.seen === 'object' ? s : undefined;
}

/** Writes one lead's state at a time, so two leads told at once never drop each other's. */
let writing: Promise<unknown> = Promise.resolve();
function writeState(leadId: string, state: TeamNoteState): Promise<void> {
  const run = writing.then(async () => {
    const { writeFileAtomic } = await import('../config-manager.js');
    const { listTasks } = await import('../task-manager.js');
    const all = await readAll();
    // A lead that is gone (completed, deleted) keeps nothing here; read now, not when the note was built.
    const live = new Set((await listTasks()).filter((t) => t.org_role === 'lead' && t.phase !== 'COMPLETE').map((t) => t.id));
    for (const id of Object.keys(all)) if (id !== leadId && !live.has(id)) delete all[id];
    all[leadId] = state;
    await fs.mkdir(path.dirname(NOTES_FILE), { recursive: true });
    await writeFileAtomic(NOTES_FILE, JSON.stringify(all, null, 2));
  });
  writing = run.catch(() => undefined);
  return run;
}

function sameSeen(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

function walk(nodes: readonly OrgTaskNode[], out: OrgTaskNode[] = []): OrgTaskNode[] {
  for (const n of nodes) { out.push(n); walk(n.workers, out); }
  return out;
}

/** Notes handed out but not yet recorded: two sends racing into one lead carry one note. */
const claims = new Map<string, number>();
const CLAIM_MS = 60_000;

export interface PendingTeamNote {
  text: string;
  /** How many tasks in it now wait on the lead (lead-waits.ts wakes the lead for those). */
  waits: number;
  /** Those tasks' ids. */
  waitIds: string[];
  markTold(): Promise<void>;
  /** Not delivered after all: the next message may carry it. */
  release(): void;
}

/** The note the next message into this lead's session carries, or null. Never throws. */
export async function pendingTeamNote(lead: Task, sessionId: string, nowMs = Date.now()): Promise<PendingTeamNote | null> {
  const claimedAt = claims.get(lead.id);
  if (claimedAt && nowMs - claimedAt < CLAIM_MS) return null;
  claims.set(lead.id, nowMs);
  let handedOut = false;
  try {
    const { listTasks } = await import('../task-manager.js');
    const tasks = await listTasks();
    const tree = buildOrgTree(tasks);
    const led = tree.projects.filter((p) => p.lead?.id === lead.id);
    const projectById = new Map<string, string>();
    for (const p of led) for (const n of walk(p.teams)) projectById.set(n.id, p.project);
    // Its own workers too, wherever they live: what waits on it is its to hear.
    for (const t of tasks) {
      if (t.parent_task_id === lead.id && t.phase !== 'COMPLETE' && !t.plugin_only && !projectById.has(t.id)) projectById.set(t.id, t.project ?? '');
    }
    const open = tasks.filter((t) => projectById.has(t.id));
    const prev = validState((await readAll())[lead.id]);
    const { pendingTeamAsks, clearTeamAsks, answeredUserAsks } = await import('./team-asks.js');
    const pending = await pendingTeamAsks(lead.id);
    // What the user said in a task's own chat that the task already answered is no ask of the team.
    const answered = answeredUserAsks(tasks, pending);
    if (answered.length) await clearTeamAsks(lead.id, answered.map((a) => ({ id: a.id, count: a.count ?? 1 }))).catch(() => undefined);
    const gone = new Set(answered.map((a) => a.id));
    const asks = pending.filter((a) => !gone.has(a.id));
    // Done here: told about before, and finished in a project this lead still leads.
    const ledKeys = new Set(led.map((p) => projectKey(p.project)));
    const completed = prev
      ? tasks.filter((t) => t.phase === 'COMPLETE' && !t.plugin_only && prev.seen[t.id] !== undefined && ledKeys.has(projectKey(t.project)))
      : [];
    const now = new Date(nowMs).toISOString();
    const plan = planTeamNote(prev, open, completed, now, { leadId: lead.id, led: led.map((p) => p.project || 'Inbox'), asks });
    if (plan.kind === 'none') {
      // Nothing to say. A first look, or a team that changed only in ways that are no news (a task
      // left, words went away), is still recorded, so the next note starts from here.
      if (!prev || !sameSeen(prev.seen, plan.next.seen) || (prev.led ?? []).join('\n') !== (plan.next.led ?? []).join('\n')) {
        await writeState(lead.id, prev ? { ...plan.next, at: prev.at } : plan.next);
      }
      return null;
    }
    // One project needs no name on every line.
    const named = led.length > 1;
    handedOut = true;
    return {
      text: buildTeamNoteText(lead, plan, prev?.at, nowMs, (id) => (named ? projectById.get(id) || 'Inbox' : '')),
      waits: plan.waits.length,
      waitIds: plan.waits.map((w) => w.taskId),
      markTold: async () => {
        await writeState(lead.id, plan.next).catch((err) => log.session.warn('team note: state not recorded', {
          sessionId, taskId: lead.id, error: err instanceof Error ? err.message : String(err),
        }));
        // Only the asks the note showed; the earlier ones ride the next note.
        if (plan.asks.length) await clearTeamAsks(lead.id, shownAskTasks(plan.asks).flatMap((g) => g.rows)).catch(() => undefined);
        claims.delete(lead.id);
        log.session.info('team note queued', {
          sessionId, taskId: lead.id, kind: plan.kind,
          needs: plan.needs.length, waits: plan.waits.length, asks: plan.asks.length, moved: plan.moved.length,
          added: plan.added.length, done: plan.done.length, ledAdded: plan.ledAdded.length, ledRemoved: plan.ledRemoved.length,
        });
      },
      release: () => { claims.delete(lead.id); },
    };
  } catch (err) {
    log.session.warn('team note skipped', { sessionId, taskId: lead.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    if (!handedOut) claims.delete(lead.id);
  }
}

/**
 * Where a lead's teams stand now, in full, told after a compaction (sessions/open-items.ts):
 * a summary drops what earlier notes said, and a lead asked about its projects must still know.
 * Changes nothing: the next note still tells only what moved since the last one. '' when there
 * is nothing to say. Never throws.
 */
export async function teamSnapshotText(lead: Task, nowMs = Date.now()): Promise<string> {
  try {
    const { listTasks } = await import('../task-manager.js');
    const tasks = await listTasks();
    const led = buildOrgTree(tasks).projects.filter((p) => p.lead?.id === lead.id);
    const projectById = new Map<string, string>();
    for (const p of led) for (const n of walk(p.teams)) projectById.set(n.id, p.project);
    for (const t of tasks) {
      if (t.parent_task_id === lead.id && t.phase !== 'COMPLETE' && !t.plugin_only && !projectById.has(t.id)) projectById.set(t.id, t.project ?? '');
    }
    const open = tasks.filter((t) => projectById.has(t.id));
    const { pendingTeamAsks, answeredUserAsks } = await import('./team-asks.js');
    const pending = await pendingTeamAsks(lead.id);
    const gone = new Set(answeredUserAsks(tasks, pending).map((a) => a.id));
    const plan = planTeamNote(undefined, open, [], new Date(nowMs).toISOString(), {
      leadId: lead.id, led: led.map((p) => p.project || 'Inbox'), asks: pending.filter((a) => !gone.has(a.id)),
    });
    if (!plan.led.length && plan.kind === 'none') return '';
    const named = led.length > 1;
    return buildTeamNoteText(lead, { ...plan, kind: 'now' }, undefined, nowMs, (id) => (named ? projectById.get(id) || 'Inbox' : ''));
  } catch {
    return '';
  }
}

/** Tests: forget the claims (a crashed send's claim expires by itself in production). */
export function _resetTeamNoteClaimsForTesting(): void {
  claims.clear();
}
