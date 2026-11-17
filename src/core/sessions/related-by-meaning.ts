/**
 * The related-tasks check's second leg (related-open-tasks.ts): tasks search finds BY MEANING for a
 * new task a lead or Main is about to create, open ones and ones finished lately.
 *
 * Why (2026-11-17, the user: find the owner by searching and reading, not by matching words or
 * formats): the first leg ranks open titles by shared words, so it never sees an owner titled in
 * another language (an English-titled "Irrigation Contract Renewal" for a new task about the same
 * garden's watering, written in Chinese) or a finished task whose delivered work regressed (four of the week's missed owners were
 * COMPLETE). Search matches meaning across languages and covers finished tasks.
 *
 * Its scores do not tell an owner from a neighbour (measured 2026-11-17 on the real board: unrelated
 * tasks scored 0.86 to 0.96 beside an owner at 0.92, and one owner ranked 11th), so nothing here is
 * judged by score: the few best rows are SHOWN, each with its deliverable, first request and latest
 * report, and the creator decides by meaning. That is why only a lead or Main meets it: a dispatcher
 * creates a few tasks a day and owes this look on each; a worker's subtask (a reviewer, a split) is
 * its own team's and already passes the first leg.
 *
 * Fails open: an error or a slow search gives no rows, and the create is judged by the first leg alone.
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { isAskTask } from './caller-placement.js';

/** How long the leg may take; past it the create goes ahead on the first leg alone. */
export const BY_MEANING_DEADLINE_MS = 3000;
/** How long search waits for the query's embedding (the meaning lane). */
export const BY_MEANING_SEMANTIC_WAIT_MS = 2000;
/** A finished task counts while it finished this recently: its delivered work may have come back. */
export const DONE_WITHIN_DAYS = 60;
/** Rows shown from this leg. */
export const BY_MEANING_MAX = 3;
/** The new task's words searched: its title and the head of its description. */
const QUERY_CHARS = 300;

export interface MeaningCandidate {
  task: Task;
  done: boolean;
}

export interface MeaningInput {
  title: string;
  description?: string;
  /** The caller and everything above it, and ids already listed: never shown. */
  skip: ReadonlySet<string>;
  nowMs?: number;
}

type SearchFn = (q: string, opts: { types: Array<'task'>; limit: number; semanticDeadlineMs: number }) =>
  Promise<Array<{ type: string; taskId?: string; isAutoExpanded?: boolean }>>;
type ReadFn = (ids: string[]) => Promise<Task[]>;

let injected: { search?: SearchFn; read?: ReadFn } | null = null;
/** Tests: replace the search and the task read. */
export function _injectMeaningDepsForTesting(deps: { search?: SearchFn; read?: ReadFn } | null): void { injected = deps; }

/** The text searched for a new task: its title, then its description's head. */
export function meaningQuery(title: string, description?: string): string {
  const head = (description ?? '').replace(/\s+/g, ' ').trim().slice(0, QUERY_CHARS);
  return [title.trim(), head].filter(Boolean).join(' ');
}

/** Whether a task may be listed: one that owns work (no conversation, lead or plugin row), open or lately finished. */
export function listable(t: Task, nowMs: number): boolean {
  // The same rows the first leg leaves out (related-open-tasks.ts findRelatedOpenTasks).
  if (t.org_role || t.plugin_only || isAskTask(t)) return false;
  if (t.phase !== 'COMPLETE') return true;
  const at = Date.parse(t.completed_at ?? t.phase_changed_at ?? t.updated_at ?? '');
  return Number.isFinite(at) && nowMs - at <= DONE_WITHIN_DAYS * 86_400_000;
}

/** The best few tasks search finds by meaning, in its order. Throws on a store or search error. */
export async function findByMeaning(input: MeaningInput): Promise<MeaningCandidate[]> {
  const q = meaningQuery(input.title, input.description);
  if (!q) return [];
  const search: SearchFn = injected?.search ?? (async (query, opts) => (await import('../search.js')).search(query, opts));
  const read: ReadFn = injected?.read ?? (async (ids) => (await import('../task-manager.js')).listTasksByIds(ids));
  const rows = await search(q, { types: ['task'], limit: 12, semanticDeadlineMs: BY_MEANING_SEMANTIC_WAIT_MS });
  // A child row search added because its parent matched is the parent's hit, not its own.
  const ids = [...new Set(rows.filter((r) => r.type === 'task' && r.taskId && !r.isAutoExpanded && !input.skip.has(r.taskId)).map((r) => r.taskId!))];
  if (!ids.length) return [];
  const byId = new Map((await read(ids)).map((t) => [t.id, t] as const));
  const now = input.nowMs ?? Date.now();
  const out: MeaningCandidate[] = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (t && listable(t, now)) out.push({ task: t, done: t.phase === 'COMPLETE' });
    if (out.length >= BY_MEANING_MAX) break;
  }
  return out;
}

/** findByMeaning within its deadline; [] when it is late or fails (logged). */
export async function findByMeaningInTime(input: MeaningInput, deadlineMs = BY_MEANING_DEADLINE_MS): Promise<MeaningCandidate[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), deadlineMs); timer.unref?.(); });
    const found = await Promise.race([findByMeaning(input), late]);
    if (found === 'late') {
      log.web.warn('related tasks by meaning: search was late; judging by shared words alone', { deadlineMs });
      return [];
    }
    return found;
  } catch (err) {
    log.web.warn('related tasks by meaning failed; judging by shared words alone', { error: err instanceof Error ? err.message : String(err) });
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

