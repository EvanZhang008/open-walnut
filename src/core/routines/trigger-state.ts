/**
 * Watcher routine state — the memory that turns a poll into a trigger.
 *
 * A watcher runs on a schedule and looks at the same place every time, so
 * without memory it re-acts on the same email/CR/message forever. This module
 * is that memory, and it is deliberately split in two:
 *
 *   - `seen`  — "I have looked at this item". ADVISORY: the watcher calls
 *               trigger_seen to learn what is new so it can skip the rest
 *               cheaply. A model that ignores it wastes tokens, nothing worse.
 *   - `acted` — "I already produced an outcome under this key". The GUARANTEE:
 *               every outcome tool refuses a key that is already here, so a
 *               model that forgets trigger_seen still cannot create the same
 *               task twice. Same split the hook system uses (inject is advice,
 *               deny is the rule) — an instruction to the model is never the
 *               safety mechanism.
 *
 * MACHINE-LOCAL, one file per job, next to cron-state.json and gitignored for
 * the same reason (2026-08-04 storm): job DEFINITIONS sync between machines,
 * runtime state must not. An LWW echo of another box's older `acted` map would
 * un-remember outcomes and re-fire them here.
 *
 * Write ORDER is load-bearing: callers perform the outcome, THEN record it. A
 * crash in between costs one duplicate task the user can see and delete; the
 * other order costs a silent miss nobody ever notices.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { WALNUT_HOME } from '../../constants.js';
import { readJsonFile, writeJsonFile } from '../../utils/fs.js';
import { withFileLock } from '../../utils/file-lock.js';
import { log } from '../../logging/index.js';

// ── Caps ──
// Sized so one job's file stays a few tens of KB: it is rewritten on every
// outcome, and a watcher on a 10-minute schedule writes ~144 times a day.

const SEEN_CAP = 2000;
const SEEN_MAX_AGE_MS = 30 * 24 * 60 * 60_000;   // 30d
const ACTED_CAP = 1000;
const ACTED_MAX_AGE_MS = 90 * 24 * 60 * 60_000;  // 90d — outlives `seen` on
// purpose: forgetting that we acted is the expensive direction.
export const NOTES_MAX_CHARS = 2000;

export interface TriggerState {
  version: 1;
  /** item id → first-seen ms. */
  seen: Record<string, number>;
  /** outcome key → ms it was acted on. */
  acted: Record<string, number>;
  /** Free-form cursor the watcher writes for its next run. */
  notes: string;
  /** Per-day budget counters, reset when `dayKey` rolls. */
  day: { key: string; sessions: number };
  /** Singleton key → task id. The task is the durable home; its session is
   *  restarted when dead, so the conversation has one place on the board. */
  singletons: Record<string, string>;
  lastRunAtMs?: number;
}

export function emptyTriggerState(nowMs: number = Date.now()): TriggerState {
  return {
    version: 1,
    seen: {},
    acted: {},
    notes: '',
    day: { key: dayKeyOf(nowMs), sessions: 0 },
    singletons: {},
  };
}

/** Local calendar day — budgets are what a human means by "today". */
export function dayKeyOf(nowMs: number): string {
  const d = new Date(nowMs);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Reset the per-day counters when the calendar day moved. Mutates + returns. */
export function rollDay(state: TriggerState, nowMs: number): TriggerState {
  const key = dayKeyOf(nowMs);
  if (state.day?.key !== key) state.day = { key, sessions: 0 };
  return state;
}

/** Drop entries by age first, then by count (oldest first). Mutates + returns. */
export function pruneTriggerState(state: TriggerState, nowMs: number): TriggerState {
  state.seen = prune(state.seen, nowMs, SEEN_MAX_AGE_MS, SEEN_CAP);
  state.acted = prune(state.acted, nowMs, ACTED_MAX_AGE_MS, ACTED_CAP);
  if (state.notes.length > NOTES_MAX_CHARS) state.notes = state.notes.slice(0, NOTES_MAX_CHARS);
  return state;
}

function prune(
  map: Record<string, number>,
  nowMs: number,
  maxAgeMs: number,
  cap: number,
): Record<string, number> {
  let entries = Object.entries(map).filter(([, ms]) => nowMs - ms < maxAgeMs);
  if (entries.length > cap) {
    entries.sort((a, b) => a[1] - b[1]);
    entries = entries.slice(entries.length - cap);
  }
  return Object.fromEntries(entries);
}

/**
 * Mark ids as seen and report which were NEW. Pure so the dedup rule is
 * unit-testable without touching disk. Duplicates inside one call collapse.
 */
export function markSeen(
  state: TriggerState,
  ids: string[],
  nowMs: number,
): { state: TriggerState; newIds: string[] } {
  const newIds: string[] = [];
  for (const raw of ids) {
    const id = String(raw).trim();
    if (!id) continue;
    if (state.seen[id] !== undefined) continue;
    state.seen[id] = nowMs;
    newIds.push(id);
  }
  return { state, newIds };
}

/** True when an outcome key was already acted on (the hard dedup check). */
export function hasActed(state: TriggerState, key: string): boolean {
  return state.acted[key.trim()] !== undefined;
}

// ── Persistence ──

/** Directory holding one state file per watcher job. */
export function triggerStateDir(): string {
  return path.join(WALNUT_HOME, 'routine-state');
}

export function triggerStatePath(jobId: string): string {
  // jobIds are generated ids, but this path is built from a stored value —
  // flatten any separator so a crafted id can never escape the directory.
  const safe = jobId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(triggerStateDir(), `${safe}.json`);
}

/** Read a job's state, degrading to empty on a corrupt file (it is all
 *  recomputable-by-observation, and failing the run would be worse). */
export async function loadTriggerState(jobId: string, nowMs = Date.now()): Promise<TriggerState> {
  const file = triggerStatePath(jobId);
  try {
    const raw = await readJsonFile<TriggerState>(file, emptyTriggerState(nowMs));
    if (!raw || typeof raw !== 'object' || raw.version !== 1) return emptyTriggerState(nowMs);
    const state: TriggerState = {
      version: 1,
      seen: typeof raw.seen === 'object' && raw.seen ? raw.seen : {},
      acted: typeof raw.acted === 'object' && raw.acted ? raw.acted : {},
      notes: typeof raw.notes === 'string' ? raw.notes : '',
      day: raw.day && typeof raw.day.key === 'string'
        ? { key: raw.day.key, sessions: Number(raw.day.sessions) || 0 }
        : { key: dayKeyOf(nowMs), sessions: 0 },
      singletons: typeof raw.singletons === 'object' && raw.singletons ? raw.singletons : {},
      ...(typeof raw.lastRunAtMs === 'number' ? { lastRunAtMs: raw.lastRunAtMs } : {}),
    };
    return rollDay(state, nowMs);
  } catch (err) {
    log.cron.warn('watcher state unreadable — starting from empty', {
      jobId, error: err instanceof Error ? err.message : String(err),
    });
    return emptyTriggerState(nowMs);
  }
}

/**
 * Locked read-modify-write. The lock is on the job's own file, so two watcher
 * jobs never wait on each other, and a single job's outcomes are serialized
 * even though its tools run inside one agent turn.
 */
export async function updateTriggerState(
  jobId: string,
  mutate: (state: TriggerState) => void | Promise<void>,
  nowMs = Date.now(),
): Promise<TriggerState> {
  const file = triggerStatePath(jobId);
  return await withFileLock(file, async () => {
    const state = await loadTriggerState(jobId, nowMs);
    await mutate(state);
    pruneTriggerState(state, nowMs);
    await writeJsonFile(file, state);
    return state;
  });
}

/** Forget a job's state (called when the routine itself is deleted). */
export async function deleteTriggerState(jobId: string): Promise<void> {
  try {
    await fs.rm(triggerStatePath(jobId), { force: true });
  } catch (err) {
    log.cron.debug('watcher state delete failed', {
      jobId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
