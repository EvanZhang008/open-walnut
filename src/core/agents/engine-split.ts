/**
 * The engine split: new task work shared between coding engines by a rule, so it does
 * not all run on one (config `defaults.engine_split`).
 *
 * A task start that names no engine, model or effort, for a task that is ordinary work
 * (not Main, a VP or a lead, not a Personal AI ask, not a routine's run), takes the entry
 * furthest below its share of the recent picks: with weights 1 and 1 that alternates, with
 * 2 and 1 the first gets two of every three. Only entries that can run where the start
 * goes are offered: an engine the launch host has not reported installed is skipped, and
 * Claude Code always can. A start that names its own engine (or a Claude model or effort)
 * is the per-task override and never consults the split.
 *
 * Each pick is kept on the task (`engine_pick`) and in a small file of recent picks
 * (`WALNUT_HOME/cache/engine-split.json`), which is what the shares are counted from.
 * Absent, empty or one-entry config = off: every start inherits the default engine as before.
 */
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import type { EngineSplitEntry, SessionEngine } from '../types.js';
import { engineCaps, isAcpEngine, isKnownEngine, resolveEngine } from './engine-registry.js';

/** One usable entry of the split, normalized. */
export interface SplitBuilder {
  /** `engine`, or `engine:model` when the entry names a model. */
  key: string;
  engine: SessionEngine;
  /** A Claude Code model id; ACP engines take their model from `engines.<id>.model`. */
  model?: string;
  weight: number;
}

/** What a start that took the split records (on the task as `engine_pick`). */
export interface EnginePick {
  key: string;
  engine: SessionEngine;
  model?: string;
  at: string;
  /** How many of the recent picks each entry had before this one, for the outcome line. */
  shares?: Record<string, number>;
  /** Entries left out of this pick, and why. */
  skipped?: { key: string; reason: string }[];
  /** A start that waited (queued, a workspace) runs on the pick its first try made. */
  reused?: boolean;
}

/** Picks older than this no longer count toward the shares. */
export const SPLIT_WINDOW_MS = 14 * 24 * 3600_000;
const KEEP_PICKS = 2000;

/** The split's entries, or [] when it is off. Bad entries are skipped, never fatal. */
export function splitBuilders(config: { defaults?: { engine_split?: unknown; engine_split_off?: unknown } } | null | undefined): SplitBuilder[] {
  const raw = config?.defaults?.engine_split;
  // Switched off: the entries are kept for when it is switched on again.
  if (!Array.isArray(raw) || config?.defaults?.engine_split_off === true) return [];
  const out: SplitBuilder[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = (typeof item === 'string' ? { engine: item } : item) as Partial<EngineSplitEntry> | null;
    if (!entry || typeof entry !== 'object' || !isKnownEngine(entry.engine)) continue;
    const engine = resolveEngine(entry.engine);
    let model = typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : undefined;
    if (model && isAcpEngine(engine)) {
      log.session.warn('engine split: a model on an ACP engine is ignored (set engines.<id>.model)', { engine, model });
      model = undefined;
    }
    const weight = typeof entry.weight === 'number' && Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 1;
    const key = model ? `${engine}:${model}` : engine;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, engine, ...(model ? { model } : {}), weight });
  }
  return out.length >= 2 ? out : [];
}

/** How many turns an entry may run ahead of or behind its share. */
export const MAX_BEHIND = 2;

/**
 * Each entry's turns owed, from the recent picks in the order they were made: every pick of a
 * listed entry hands each entry its share of one turn and takes one turn from the entry picked.
 * No entry is ever more than MAX_BEHIND turns behind or ahead, so an entry added later, or one
 * a host could not run for a while, catches up by at most that much and then takes turns
 * (2026-11-05 review: a new entry took every task until its 14-day count caught up).
 */
export function splitCredits(builders: readonly SplitBuilder[], sequence: readonly string[]): Map<string, number> {
  const total = builders.reduce((a, b) => a + b.weight, 0);
  const credit = new Map(builders.map((b) => [b.key, 0]));
  for (const key of sequence) {
    if (!credit.has(key)) continue;
    for (const b of builders) {
      let c = credit.get(b.key)! + b.weight / total - (b.key === key ? 1 : 0);
      c = Math.max(-MAX_BEHIND, Math.min(MAX_BEHIND, c));
      credit.set(b.key, c);
    }
  }
  return credit;
}

/** The entry owed the most turns (splitCredits); ties go to the earlier entry. */
export function chooseBuilder(builders: readonly SplitBuilder[], credits: ReadonlyMap<string, number>): SplitBuilder | null {
  let best: SplitBuilder | null = null;
  let bestScore = -Infinity;
  for (const b of builders) {
    const score = credits.get(b.key) ?? 0;
    if (score > bestScore + 1e-9) { best = b; bestScore = score; }
  }
  return best;
}

/** A display name for an entry: "Codex", "Claude Code · gpt-6.1-sol". */
export function builderLabel(b: Pick<SplitBuilder, 'engine' | 'model'>): string {
  const name = engineCaps(b.engine).displayName.replace(/^Claude\b(?! Code)/, 'Claude Code');
  return b.model ? `${name} · ${b.model}` : name;
}

/**
 * A reviewer subtask: its title starts with "review" or "reviewer" (after a bracketed tag and a
 * kind such as "code"), never a title that only mentions one ("Fix the reviewer assignment bug").
 */
export const REVIEW_RE = /^\s*(?:\[[^\]]*\]\s*)?(?:(?:code|ui|ux|design|final|second|independent|fresh|claude|gpt)\s+)*review(?:er)?\b/i;

/** A reviewer subtask counts toward its parent's work (engine-compare.ts), so it takes no turn of the split. */
export function isReviewerTask(task: { parent_task_id?: string; title?: string }): boolean {
  return !!task.parent_task_id && REVIEW_RE.test(task.title ?? '');
}

/** Does this task's start take part in the split at all? */
export function splitApplies(
  task: { org_role?: string; walnut_agent?: boolean; project?: string; routine_start?: unknown; plugin_only?: string; parent_task_id?: string; title?: string },
  params: { engine?: string; model?: string; effort?: string; source?: string },
): boolean {
  if (params.engine !== undefined || params.effort) return false;
  if (params.model && params.model !== 'default') return false;
  if (task.org_role || task.walnut_agent || task.routine_start || task.plugin_only) return false;
  // A lead's reviewers alternate with its work tasks: given turns, they would put all the work on one engine.
  if (isReviewerTask(task)) return false;
  // A Personal AI ask (caller-placement.ts isAskTask): its agent's persona picks its engine.
  if (/^ask /i.test((task.project ?? '').trim())) return false;
  // Starts that continue, replace or recover a session keep the engine they had.
  return !REPLAY_SOURCES.has(params.source ?? '');
}

const REPLAY_SOURCES = new Set(['engine-switch', 'transfer', 'auto-recover', 'recovery', 'restart', 'folder-gone', 'workspace', 'start-queue']);

// ── The recent picks ──

interface PicksFile { version: 1; picks: { key: string; taskId: string; at: string }[] }

const picksFile = () => path.join(WALNUT_HOME, 'cache', 'engine-split.json');

function normalizePicks(raw: unknown): PicksFile {
  const picks = Array.isArray((raw as PicksFile | null)?.picks) ? (raw as PicksFile).picks : [];
  return { version: 1, picks: picks.filter((p) => p && typeof p.key === 'string' && typeof p.at === 'string') };
}

/**
 * Picks made in this process, kept for RESERVE_MS: two starts at once both read the file
 * before either writes, and would otherwise take the same entry. A reservation whose task the
 * file already lists is not counted again, so nothing is counted twice or not at all.
 */
const reserved: { key: string; taskId: string; at: number }[] = [];
const RESERVE_MS = 120_000;

/** Tests only. */
export function _resetSplitReservations(): void { reserved.length = 0; }

/** Drop a start's reservation that will never run (it lost the race to keep its task's pick). */
export function releaseSplitReservation(taskId: string, key: string): void {
  for (let i = reserved.length - 1; i >= 0; i--) if (reserved[i].taskId === taskId && reserved[i].key === key) reserved.splice(i, 1);
}

/** `tasks`: the entry the file holds for each task. */
type Recent = { counts: Map<string, number>; tasks: Map<string, string>; sequence: string[] };

/** Adds this process's picks the file does not hold yet. Synchronous on purpose (see pickSplitEngine). */
function withReserved(file: Recent, nowMs: number): Recent {
  for (let i = reserved.length - 1; i >= 0; i--) if (nowMs - reserved[i].at > RESERVE_MS) reserved.splice(i, 1);
  const counts = new Map(file.counts);
  const sequence = [...file.sequence];
  for (const r of reserved) {
    // The file already holds this pick; a task picked again (its old entry was removed) still counts its new one.
    if (file.tasks.get(r.taskId) === r.key) continue;
    counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
    sequence.push(r.key);
  }
  return { counts, tasks: file.tasks, sequence };
}

/** Picks per entry key within the window, this process's unrecorded picks included. */
export async function recentPickCounts(nowMs = Date.now()): Promise<Map<string, number>> {
  return withReserved(await filePicks(nowMs), nowMs).counts;
}

async function filePicks(nowMs: number): Promise<Recent> {
  const file = normalizePicks(await readJsonFile<unknown>(picksFile(), null));
  const counts = new Map<string, number>();
  const tasks = new Map<string, string>();
  const recent = file.picks.filter((p) => nowMs - Date.parse(p.at) <= SPLIT_WINDOW_MS).sort((a, b) => a.at.localeCompare(b.at));
  for (const p of recent) {
    counts.set(p.key, (counts.get(p.key) ?? 0) + 1);
    tasks.set(p.taskId, p.key);
  }
  return { counts, tasks, sequence: recent.map((p) => p.key) };
}

/** Keep one pick (one per task: a task picked again replaces its earlier pick). */
export async function recordPick(key: string, taskId: string, at: string, nowMs = Date.now()): Promise<void> {
  await updateJsonFile<unknown>(picksFile(), null, (raw) => {
    const file = normalizePicks(raw);
    const picks = file.picks.filter((p) => nowMs - Date.parse(p.at) <= SPLIT_WINDOW_MS && p.taskId !== taskId);
    picks.push({ key, taskId, at });
    return { version: 1, picks: picks.slice(-KEEP_PICKS) };
  });
}

/**
 * The split's pick for one start, or null (off, nothing usable).
 * `available` says whether an engine runs on the launch host: true, false, or null when the
 * host has not said (an ACP engine with no answer is not offered; Claude Code always is).
 * The pick is reserved for `taskId` at once, so a start running at the same time sees it.
 */
export async function pickSplitEngine(
  builders: readonly SplitBuilder[],
  available: (engine: SessionEngine) => Promise<boolean | null>,
  nowMs = Date.now(),
  taskId = '',
): Promise<EnginePick | null> {
  if (builders.length < 2) return null;
  const usable: SplitBuilder[] = [];
  const skipped: { key: string; reason: string }[] = [];
  for (const b of builders) {
    if (!isAcpEngine(b.engine)) { usable.push(b); continue; }
    const ok = await available(b.engine).catch(() => null);
    if (ok === true) usable.push(b);
    else skipped.push({ key: b.key, reason: ok === false ? 'not installed on the host this start runs on' : 'the host has not said whether it runs it' });
  }
  // Reading the reservations, choosing and reserving happen with no await in between,
  // so a start running at the same time always sees this one.
  const { counts, sequence } = withReserved(await filePicks(nowMs), nowMs);
  const chosen = chooseBuilder(usable, splitCredits(builders, sequence));
  if (!chosen) return null;
  reserved.push({ key: chosen.key, taskId, at: nowMs });
  return {
    key: chosen.key, engine: chosen.engine, ...(chosen.model ? { model: chosen.model } : {}), at: new Date(nowMs).toISOString(),
    shares: Object.fromEntries(builders.map((b) => [b.key, counts.get(b.key) ?? 0])),
    ...(skipped.length ? { skipped } : {}),
  };
}
