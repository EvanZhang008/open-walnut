/**
 * What moved in a lead's teams, told before its next message. 2026-10-26, the user: the VP
 * "should know the status of the task", reliably; workers are told not to send their lead
 * progress reports, so a lead that waits for one never hears. This note is built from
 * Walnut's own data only: each team task's status (src/core/user-status.ts) and its phase.
 *
 * Same shape as the main agent's org update (org-store.ts pendingOrgDigest): it rides the next
 * message that goes into the lead anyway, in the same row, so it never costs a turn and never
 * wakes the lead. What needs the user is the user's to see (the Org page shows it the moment
 * the status says so, team-news.ts); the lead hears it with its next message.
 *
 *   first message   where its teams stand now: what needs the user, the newest news
 *   later           what moved since the last note: a new ask for the user, new status
 *                   words, a task done, a new task. Nothing moved, no note.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { createEnvelopeKit } from '../peers/envelope-kit.js';
import { buildOrgTree, projectKey, type OrgTaskNode } from './org-tree.js';
import { newsItem, shortTitle, teamNews, type TeamNewsItem, type TeamNewsTask } from './team-news.js';

const kit = createEnvelopeKit();

/** What the lead was last told: when, and each open team task's fingerprint then. */
export interface TeamNoteState {
  at: string;
  seen: Record<string, string>;
}

export interface TeamNotePlan {
  /** 'none' = nothing moved; 'now' = the first note, where things stand; 'moved' = what changed. */
  kind: 'none' | 'now' | 'moved';
  needs: TeamNewsItem[];
  moved: TeamNewsItem[];
  added: TeamNewsItem[];
  done: string[];
  next: TeamNoteState;
}

/** Stuck: it meant to carry on and nothing will wake it, so it is its lead's to unblock. */
function isStuck(t: TeamNewsTask): boolean {
  return t.user_status?.state === 'waiting' && t.user_status.kind === 'stuck';
}

/** What a lead is told about: an ask for the user, the session's own words, or being stuck.
 *  A turn that only started or ended, the same words reported again, or what Walnut says a
 *  task waits on after a phase move ("Its worker (1 open)") is not news. */
function newsKey(t: TeamNewsTask): string {
  const item = newsItem(t);
  if (item.state === 'needs') return `needs|${item.words}`;
  return `|${(t.user_status?.now ?? '').replace(/\s+/g, ' ').trim()}|${isStuck(t) ? 'stuck' : ''}`;
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
  open: readonly TeamNewsTask[],
  completed: readonly Pick<Task, 'id' | 'title'>[],
  now: string,
): TeamNotePlan {
  const seen: Record<string, string> = {};
  for (const t of open) seen[t.id] = teamFingerprint(t);
  const next: TeamNoteState = { at: now, seen };
  const news = teamNews(open);
  if (!prev) {
    const needs = news.filter((i) => i.state === 'needs');
    const moved = news.filter((i) => i.state !== 'needs' && i.reported).slice(0, 5);
    return { kind: needs.length || moved.length ? 'now' : 'none', needs, moved, added: [], done: [], next };
  }
  const needs: TeamNewsItem[] = [];
  const moved: TeamNewsItem[] = [];
  const added: TeamNewsItem[] = [];
  const byId = new Map(open.map((t) => [t.id, t] as const));
  for (const item of news) {
    const before = prev.seen[item.taskId];
    if (before === seen[item.taskId]) continue;
    const t = byId.get(item.taskId)!;
    // What needs the user is said first, a new task's ask included.
    if (item.state === 'needs') needs.push(item);
    else if (before === undefined) added.push(item);
    // Words that went away (a report with nothing new) are no news.
    else if (item.reported || isStuck(t)) moved.push(item);
  }
  const done = completed.filter((t) => prev.seen[t.id] !== undefined).map((t) => t.title);
  const any = needs.length + moved.length + added.length + done.length > 0;
  return { kind: any ? 'moved' : 'none', needs, moved, added, done, next };
}

/** Most lines a section carries; the rest are counted. */
export const TEAM_NOTE_MAX = { needs: 6, moved: 8, added: 6, done: 6 } as const;
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
  const head = plan.kind === 'now' ? 'Your teams now, from their own status:\n'
    : `Team update${since ? ` (last note ${since})` : ''}, from your teams' own status:\n`;
  const doneLine = plan.done.length
    ? `Done: ${plan.done.slice(0, TEAM_NOTE_MAX.done).map((t) => `"${shortTitle(t, 80)}"`).join(', ')}${plan.done.length > TEAM_NOTE_MAX.done ? ` and ${plan.done.length - TEAM_NOTE_MAX.done} more` : ''}\n`
    : '';
  const body = head
    + section('Needs the user:', plan.needs, TEAM_NOTE_MAX.needs, (i) => `${label(i)}${words(i)}`)
    + section(plan.kind === 'now' ? 'Latest:' : 'Changed:', plan.moved, TEAM_NOTE_MAX.moved, (i) => `${label(i)} (${when(i)})${words(i)}`)
    + section('New:', plan.added, TEAM_NOTE_MAX.added, (i) => `${label(i)} (${when(i)})${words(i)}`)
    + doneLine
    + 'Background, not a request: use it when it matters to what you do next. The user sees the same on the Org page. Detail: org_get or task_get.';
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
  markTold(): Promise<void>;
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
    const open = tasks.filter((t) => projectById.has(t.id));
    const prev = validState((await readAll())[lead.id]);
    // Done here: told about before, and finished in a project this lead still leads.
    const ledKeys = new Set(led.map((p) => projectKey(p.project)));
    const completed = prev
      ? tasks.filter((t) => t.phase === 'COMPLETE' && prev.seen[t.id] !== undefined && ledKeys.has(projectKey(t.project)))
      : [];
    const now = new Date(nowMs).toISOString();
    const plan = planTeamNote(prev, open, completed, now);
    if (plan.kind === 'none') {
      // Nothing to say. A first look, or a team that changed only in ways that are no news (a task
      // left, words went away), is still recorded, so the next note starts from here.
      if (!prev || !sameSeen(prev.seen, plan.next.seen)) {
        await writeState(lead.id, prev ? { at: prev.at, seen: plan.next.seen } : plan.next);
      }
      return null;
    }
    // One project needs no name on every line.
    const named = led.length > 1;
    handedOut = true;
    return {
      text: buildTeamNoteText(lead, plan, prev?.at, nowMs, (id) => (named ? projectById.get(id) || 'Inbox' : '')),
      markTold: async () => {
        await writeState(lead.id, plan.next).catch((err) => log.session.warn('team note: state not recorded', {
          sessionId, taskId: lead.id, error: err instanceof Error ? err.message : String(err),
        }));
        claims.delete(lead.id);
        log.session.info('team note queued', {
          sessionId, taskId: lead.id, kind: plan.kind,
          needs: plan.needs.length, moved: plan.moved.length, added: plan.added.length, done: plan.done.length,
        });
      },
    };
  } catch (err) {
    log.session.warn('team note skipped', { sessionId, taskId: lead.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    if (!handedOut) claims.delete(lead.id);
  }
}

/** Tests: forget the claims (a crashed send's claim expires by itself in production). */
export function _resetTeamNoteClaimsForTesting(): void {
  claims.clear();
}
