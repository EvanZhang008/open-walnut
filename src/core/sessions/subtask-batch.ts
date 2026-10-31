/**
 * What is left of a parent's subtasks, for its subtask notices (2026-10-28, from the
 * multi-agent tracking research, point 1: "how many are left, and wake me once when all
 * are in").
 *
 *  1. Every `completed` notice says how many of the parent's subtasks are still open and
 *     names them with their status (`remainingLine`), so the parent never counts by hand
 *     (2026-09-30: a parent lost a subtask that way).
 *  2. A parent whose turn is over is woken ONCE, when its team settles, not per completion:
 *     a completion while another subtask is still Working is HELD (`holdNotices`), and goes
 *     out with the edge that leaves no subtask working (the last completion, an error, a
 *     stop, a park), or rides the parent's next turn when something else starts one
 *     (subtask-notices.ts). Settled means not Working: a subtask waiting on the user, a
 *     clock or its lead has nothing more to send on its own, and a standing routine (parked
 *     on a trigger for good) must never keep its leader from hearing the rest.
 *
 * Errors, replies and the request fallback keep their own rules (subtask-notices.ts header).
 * Held notices are kept on disk (WALNUT_HOME/subtask-notices-held.json), so a restart
 * delivers them instead of losing them.
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { fallbackUserState, stateWord, type UserStatus } from '../user-status.js';
import type { Task } from '../types.js';

/** One open subtask as a notice names it. */
export interface OpenSibling {
  id: string;
  title: string;
  state: 'needs' | 'working' | 'waiting';
  /** The status's words: what the user must do, on what it waits. */
  why?: string;
  /** Its start date is still to come. */
  snoozed?: boolean;
}

/** Names shown in one notice; the rest are counted. */
const NAMES_MAX = 8;
const WHY_MAX = 90;

function isOpen(t: Pick<Task, 'phase' | 'status'>): boolean {
  return t.phase !== 'COMPLETE' && t.status !== 'done';
}

function stateOf(t: Task): OpenSibling['state'] {
  const s: UserStatus | undefined = t.user_status;
  const state = s?.state ?? fallbackUserState(t.phase, t.status);
  return state === 'done' ? 'waiting' : state;
}

function whyOf(t: Task, state: OpenSibling['state']): string | undefined {
  const s = t.user_status;
  if (!s || s.state !== state) return undefined;
  const raw = state === 'needs' ? s.ask : state === 'waiting' ? s.waitingOn : undefined;
  const text = raw?.replace(/\s+/g, ' ').trim().replace(/[.;:]+$/, '');
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length > WHY_MAX ? `${chars.slice(0, WHY_MAX - 1).join('')}…` : text;
}

/**
 * The parent's direct subtasks that are still open, leaving out `exclude` (the batch's own).
 * Null when they could not be read: the notices then go as they did before (no count, no hold).
 */
export async function openSiblings(parentTaskId: string, exclude: ReadonlySet<string> = new Set()): Promise<OpenSibling[] | null> {
  let children: Task[];
  try {
    const { getChildTasks } = await import('../task-manager.js');
    const read = await getChildTasks(parentTaskId);
    if (!Array.isArray(read)) return null;
    children = read;
  } catch {
    return null;
  }
  return children
    .filter((t) => isOpen(t) && !exclude.has(t.id))
    .map((t) => {
      const state = stateOf(t);
      const why = whyOf(t, state);
      return { id: t.id, title: t.title || 'untitled', state, ...(why ? { why } : {}), ...(t.user_status?.snoozed ? { snoozed: true } : {}) };
    });
}

const ORDER: Record<OpenSibling['state'], number> = { needs: 0, working: 1, waiting: 2 };

/**
 * "Still open: 2 of your subtasks: "Bench Mac" (id, Working), "Bench iOS" (id, Needs you: approve the
 * TestFlight build)." or the line saying this was the last one.
 */
export function remainingLine(open: readonly OpenSibling[] | null): string | undefined {
  if (!open) return undefined;
  if (open.length === 0) return 'None of your subtasks is still open: this was the last one.';
  const sorted = [...open].sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const shown = sorted.slice(0, NAMES_MAX).map((s) => `"${s.title}" (${s.id}, ${stateWord(s.state, s.snoozed)}${s.why ? `: ${s.why}` : ''})`);
  const more = sorted.length - shown.length;
  const count = open.length === 1 ? '1 of your subtasks' : `${open.length} of your subtasks`;
  return `Still open: ${count}: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`;
}

/** No subtask left Working: the team has settled for now. */
export function teamSettled(open: readonly OpenSibling[] | null): boolean {
  return !open || !open.some((s) => s.state === 'working');
}

// ── Held completions ──

const FILE = () => path.join(WALNUT_HOME, 'subtask-notices-held.json');
/** A held notice older than this goes out at the next sweep whatever the team does. */
export const HOLD_MAX_MS = 24 * 60 * 60_000;
/** An idle parent session held this long is woken with what it holds: the daemon reaps an idle
 *  session after 2 h (SESSION_IDLE_KILL_MS), and a reaped one would never hear them. */
export const RELEASE_BEFORE_REAP_MS = 100 * 60_000;

export interface HeldEntry<N> { notices: N[]; since: string }
type HeldFile<N> = Record<string, HeldEntry<N>>;

let cache: HeldFile<unknown> | null = null;
let loading: Promise<HeldFile<unknown>> | null = null;
let writing: Promise<void> = Promise.resolve();

/** One read, shared by every caller that arrives before it lands (a boot resume racing a flush). */
async function load(): Promise<HeldFile<unknown>> {
  if (cache) return cache;
  loading ??= (async () => {
    let read: HeldFile<unknown> = {};
    try {
      const parsed = JSON.parse(await fsp.readFile(FILE(), 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) read = parsed as HeldFile<unknown>;
    } catch { /* none yet */ }
    cache ??= read;
    loading = null;
    return cache;
  })();
  return loading;
}

/** Written behind the in-memory copy, never awaited by a notice: a slow disk never holds one up. */
function save(): Promise<void> {
  const snapshot = JSON.stringify(cache ?? {});
  writing = writing.then(async () => {
    const { writeJsonFile } = await import('../../utils/fs.js');
    await writeJsonFile(FILE(), JSON.parse(snapshot));
  }).catch((err) => {
    log.session.warn('held subtask notices: write failed', { error: err instanceof Error ? err.message : String(err) });
  });
  return writing;
}

/** Keep notices for a parent until its team settles. */
export async function holdNotices<N>(parentTaskId: string, notices: readonly N[], now = Date.now()): Promise<void> {
  const file = await load();
  const prev = file[parentTaskId] as HeldEntry<N> | undefined;
  file[parentTaskId] = { notices: [...(prev?.notices ?? []), ...notices], since: prev?.since ?? new Date(now).toISOString() };
  void save();
}

/** Take (and forget) what is held for a parent. */
export async function takeHeld<N>(parentTaskId: string): Promise<N[]> {
  const file = await load();
  const entry = file[parentTaskId] as HeldEntry<N> | undefined;
  if (!entry) return [];
  delete file[parentTaskId];
  void save();
  return entry.notices;
}

/** Drop what is held for a parent (it completed: a closed leader hears nothing). */
export async function dropHeld(parentTaskId: string): Promise<number> {
  const file = await load();
  const n = (file[parentTaskId] as HeldEntry<unknown> | undefined)?.notices.length ?? 0;
  if (!n) return 0;
  delete file[parentTaskId];
  void save();
  return n;
}

export async function heldParents(): Promise<{ parentTaskId: string; since: string; count: number }[]> {
  const file = await load();
  return Object.entries(file).map(([parentTaskId, e]) => ({ parentTaskId, since: e.since, count: e.notices.length }));
}

export async function hasHeld(parentTaskId: string): Promise<boolean> {
  return !!(await load())[parentTaskId];
}

/** Test seam. */
export async function resetHeld(): Promise<void> {
  await writing;
  cache = {};
  loading = null;
  await fsp.rm(FILE(), { force: true }).catch(() => {});
}
