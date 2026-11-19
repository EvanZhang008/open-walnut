/**
 * What the reflection remembers per node, so a restart never judges a message twice and the day's
 * budget holds: `WALNUT_HOME/org-reflection/<nodeTaskId>.json`, written under the file lock. Only
 * the primary keeps it (a replica runs no duty).
 */
import path from 'node:path';
import { WALNUT_HOME } from '../../../constants.js';
import { readJsonFile, updateJsonFile } from '../../../utils/fs.js';

export interface ReflectionState {
  version: 1;
  /** His messages (and asks) older than this are not looked at: set when the switch is first seen on. */
  since: string;
  /** Candidate keys judged, with when and the verdict, kept SEEN_KEEP_MS. */
  seen: Record<string, { at: string; verdict: string }>;
  /** Judge calls spent today (the server's local date). */
  day: { date: string; calls: number };
  /** Guidance lines the reflection wrote (normalized text), to see which ones the user deleted since. */
  written: string[];
  /** Guidance lines someone removed: never written again (normalized text). */
  removed: string[];
  /** Skills written today: at most SKILLS_PER_DAY_MAX. */
  skills: { date: string; count: number };
}

/** Longer than the user's messages are kept (user-asks: open 7 days, then closed 30), so one is never judged twice. */
export const SEEN_KEEP_MS = 45 * 24 * 3600_000;
export const SKILLS_PER_DAY_MAX = 1;
/** Judge calls one node may spend in a day; past it the rest wait for tomorrow. */
export const DAILY_CALLS_MAX = 40;

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const stateFileOf = (nodeId: string): string => {
  if (!TASK_ID_RE.test(nodeId)) throw new Error(`Invalid node id: ${nodeId}`);
  return path.join(WALNUT_HOME, 'org-reflection', `${nodeId}.json`);
};

export const localDate = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function normalize(raw: unknown, nowMs: number): ReflectionState {
  const r = (raw ?? {}) as Partial<ReflectionState>;
  const today = localDate(nowMs);
  return {
    version: 1,
    since: typeof r.since === 'string' ? r.since : new Date(nowMs).toISOString(),
    seen: r.seen && typeof r.seen === 'object' ? r.seen : {},
    day: r.day?.date === today && Number.isFinite(r.day.calls) ? r.day : { date: today, calls: 0 },
    written: Array.isArray(r.written) ? r.written.filter((s): s is string => typeof s === 'string') : [],
    removed: Array.isArray(r.removed) ? r.removed.filter((s): s is string => typeof s === 'string') : [],
    skills: r.skills?.date === today && Number.isFinite(r.skills.count) ? r.skills : { date: today, count: 0 },
  };
}

export async function readReflectionState(nodeId: string, nowMs = Date.now()): Promise<ReflectionState> {
  return normalize(await readJsonFile<unknown>(stateFileOf(nodeId), null), nowMs);
}

/** Read-modify-write under the file lock; old seen keys are dropped. Returns what `fn` returned. */
export async function updateReflectionState<T>(nodeId: string, fn: (s: ReflectionState) => T, nowMs = Date.now()): Promise<T> {
  let out!: T;
  await updateJsonFile<unknown>(stateFileOf(nodeId), null, (raw) => {
    const s = normalize(raw, nowMs);
    for (const [k, v] of Object.entries(s.seen)) if (nowMs - Date.parse(v.at) > SEEN_KEEP_MS) delete s.seen[k];
    out = fn(s);
    return s;
  });
  return out;
}

/**
 * Claim one candidate before judging it, in one write: one call from today's budget, and the key
 * marked seen (`pending`), so a pass that fails or a restart after the send never judges or sends it
 * again. 'seen' when another pass claimed it, 'budget' when today's calls are spent.
 */
export async function claimCandidate(nodeId: string, key: string, nowMs = Date.now(), max = DAILY_CALLS_MAX): Promise<'ok' | 'seen' | 'budget'> {
  return updateReflectionState(nodeId, (s) => {
    if (s.seen[key]) return 'seen';
    if (s.day.calls >= max) return 'budget';
    s.day.calls++;
    s.seen[key] = { at: new Date(nowMs).toISOString(), verdict: 'pending' };
    return 'ok';
  }, nowMs);
}

/** Mark keys seen with no judge call (a candidate the second look dropped). */
export async function markSeen(nodeId: string, keys: readonly string[], verdict: string, nowMs = Date.now()): Promise<void> {
  if (!keys.length) return;
  await updateReflectionState(nodeId, (s) => {
    for (const k of keys) s.seen[k] ??= { at: new Date(nowMs).toISOString(), verdict };
  }, nowMs);
}

/** Take one of today's skill writes; false when spent. */
export async function takeSkillWrite(nodeId: string, nowMs = Date.now()): Promise<boolean> {
  return updateReflectionState(nodeId, (s) => {
    if (s.skills.count >= SKILLS_PER_DAY_MAX) return false;
    s.skills.count++;
    return true;
  }, nowMs);
}
