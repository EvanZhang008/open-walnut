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
}

/** Picks older than this no longer count toward the shares. */
export const SPLIT_WINDOW_MS = 14 * 24 * 3600_000;
const KEEP_PICKS = 2000;

/** The split's entries, or [] when it is off. Bad entries are skipped, never fatal. */
export function splitBuilders(config: { defaults?: { engine_split?: unknown } } | null | undefined): SplitBuilder[] {
  const raw = config?.defaults?.engine_split;
  if (!Array.isArray(raw)) return [];
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

/** The entry furthest below its share (fewest picks per unit of weight); ties go to the earlier entry. */
export function chooseBuilder(builders: readonly SplitBuilder[], counts: ReadonlyMap<string, number>): SplitBuilder | null {
  let best: SplitBuilder | null = null;
  let bestScore = Infinity;
  for (const b of builders) {
    const score = (counts.get(b.key) ?? 0) / b.weight;
    if (score < bestScore) { best = b; bestScore = score; }
  }
  return best;
}

/** A display name for an entry: "Codex", "Claude Code · gpt-6.1-sol". */
export function builderLabel(b: Pick<SplitBuilder, 'engine' | 'model'>): string {
  const name = engineCaps(b.engine).displayName.replace(/^Claude\b(?! Code)/, 'Claude Code');
  return b.model ? `${name} · ${b.model}` : name;
}

/** Does this task's start take part in the split at all? */
export function splitApplies(
  task: { org_role?: string; walnut_agent?: boolean; project?: string; routine_start?: unknown; plugin_only?: string },
  params: { engine?: string; model?: string; effort?: string; source?: string },
): boolean {
  if (params.engine !== undefined || params.effort) return false;
  if (params.model && params.model !== 'default') return false;
  if (task.org_role || task.walnut_agent || task.routine_start || task.plugin_only) return false;
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

/** Picks per entry key within the window. */
export async function recentPickCounts(nowMs = Date.now()): Promise<Map<string, number>> {
  const file = normalizePicks(await readJsonFile<unknown>(picksFile(), null));
  const counts = new Map<string, number>();
  for (const p of file.picks) {
    if (nowMs - Date.parse(p.at) > SPLIT_WINDOW_MS) continue;
    counts.set(p.key, (counts.get(p.key) ?? 0) + 1);
  }
  return counts;
}

/** Keep one pick (the start that made it was recorded on its task). */
export async function recordPick(key: string, taskId: string, at: string, nowMs = Date.now()): Promise<void> {
  await updateJsonFile<unknown>(picksFile(), null, (raw) => {
    const file = normalizePicks(raw);
    const picks = file.picks.filter((p) => nowMs - Date.parse(p.at) <= SPLIT_WINDOW_MS && p.taskId !== taskId);
    picks.push({ key, taskId, at });
    return { version: 1, picks: picks.slice(-KEEP_PICKS) };
  });
}

/**
 * The split's pick for one start, or null (off, the start is an override, nothing usable).
 * `available` says whether an engine runs on the launch host: true, false, or null when the
 * host has not said (an ACP engine with no answer is not offered; Claude Code always is).
 */
export async function pickSplitEngine(
  builders: readonly SplitBuilder[],
  available: (engine: SessionEngine) => Promise<boolean | null>,
  nowMs = Date.now(),
): Promise<EnginePick | null> {
  if (builders.length < 2) return null;
  const usable: SplitBuilder[] = [];
  for (const b of builders) {
    if (!isAcpEngine(b.engine) || (await available(b.engine).catch(() => null)) === true) usable.push(b);
  }
  const counts = await recentPickCounts(nowMs);
  const chosen = chooseBuilder(usable, counts);
  if (!chosen) return null;
  return {
    key: chosen.key, engine: chosen.engine, ...(chosen.model ? { model: chosen.model } : {}), at: new Date(nowMs).toISOString(),
    shares: Object.fromEntries(builders.map((b) => [b.key, counts.get(b.key) ?? 0])),
  };
}
