/**
 * What the reflection remembers per node, so a restart never judges a message twice and the day's
 * budget holds: `WALNUT_HOME/org-reflection/<nodeTaskId>.json`, written under the file lock. Only
 * the primary keeps it (a replica runs no duty).
 */
import path from 'node:path';
import { WALNUT_HOME } from '../../../constants.js';
import { readJsonFile, updateJsonFile } from '../../../utils/fs.js';
import { TASK_ID_RE } from '../../artifacts/paths.js';

export interface ReflectionState {
  version: 1;
  /** His messages (and asks) older than this are not looked at: set when the switch is first seen on. */
  since: string;
  /** Candidate keys judged, with when and the verdict, kept SEEN_KEEP_MS. */
  seen: Record<string, { at: string; verdict: string }>;
  /**
   * Today (the server's local date; the whole object resets when the date changes):
   * - `calls`: judge calls spent.
   * - `budgetLeft`: keys of today's moments the spent budget left unjudged (at most BUDGET_LEFT_KEPT;
   *   `budgetLeftCount` counts them all). They stay unseen: any later pass judges them, today or
   *   tomorrow, while they are under MOMENT_MAX_AGE_MS old (candidates.ts).
   * - `budgetDropped`: moments of an earlier date the budget left unjudged: marked seen
   *   ('skipped_dropped'), so never judged.
   * - `chatSends`: on a Main or lead task's own state, the corrections sent to its chat today (the
   *   user's own chat), from any node's reflection: at most CHAT_SENDS_PER_DAY_MAX, one an hour.
   */
  day: { date: string; calls: number; budgetLeft?: string[]; budgetLeftCount?: number; budgetDropped?: number; chatSends?: number };
  /** Guidance lines the reflection wrote (normalized text), to see which ones the user deleted since. */
  written: string[];
  /** Guidance lines someone removed: never written again (normalized text). */
  removed: string[];
  /** Skills written today: at most SKILLS_PER_DAY_MAX. */
  skills: { date: string; count: number };
  /** The last local date whose record went to the node's own session (nightly.ts). */
  nightly?: string;
  /** The pain registry's part of the last nightly note that carried one (a hash): an unchanged part is not sent again. */
  painsNote?: string;
  /** Lessons a full day or file once dropped that were taken up again (guidance-merge.ts), normalized: each once. */
  /** Of `backfilled`, the lessons its tries gave up on: never placed, so they wait for the node's tidy. */
  backfillGaveUp?: string[];
  backfilled?: string[];
  /** Today's merge calls (guidance-merge.ts): at most MERGE_CALLS_PER_DAY_MAX. */
  merges?: { date: string; count: number };
  /** Lessons merged into a line (guidance-merge.ts), normalized, and the line that holds each now: the same lesson again needs no call. */
  mergedLessons?: Array<{ lesson: string; line: string }>;
  /** Failed tries of a dropped lesson the backfill has not settled yet (normalized lesson: count). */
  backfillTries?: Record<string, number>;
  /** The user's standing rules (USER.md) the guidance was last checked against, line by line (guidance-align.ts). */
  aligned?: { rules: string[]; short?: number };
  /** Today's align calls: at most ALIGN_CALLS_PER_DAY_MAX. */
  aligns?: { date: string; count: number };
  /** Guidance lines named to the node as going against a changed rule of his, newest last. */
  alignLog?: Array<{ at: string; line: string; rule: string }>;
  /** The local date the node was last asked to tidy a full guidance (guidance-tidy.ts): once a day. */
  tidyAsked?: string;
  /** When the node's high judge days began (dailyCallsMax). */
  callsFrom?: string;
  /** Corrections this node held for a later send (one a pass per task, a lead chat's spacing), oldest first (held-corrections.ts). */
  held?: HeldCorrection[];
  /** On a Main or lead task's own state: when a reflection's correction last went to its chat. */
  lastChatSendAt?: string;
}

/** One correction held for a later send: its task, its day entry (date and time) and the point it makes. */
export interface HeldCorrection {
  taskId: string; at: string; date: string; entryAt: string; text: string;
  /** Entries whose point this one makes too (the same point held again): marked with it. */
  merged?: Array<{ date: string; entryAt: string }>;
}

/** Longer than the user's messages are kept (user-asks: open 7 days, then closed 30), so one is never judged twice. */
export const SEEN_KEEP_MS = 45 * 24 * 3600_000;
export const SKILLS_PER_DAY_MAX = 1;
/** Judge calls one node may spend in a day once it is settled; past it the rest wait for a later pass. */
export const DAILY_CALLS_MAX = 40;
/**
 * A node starts with more: DAILY_CALLS_START a day, falling evenly to DAILY_CALLS_MAX over
 * DAILY_CALLS_EASE_DAYS from `callsFrom` (the first pass that read this rule; 2026-11-23, the user:
 * "At elast for now we need to do it more frequence over time cna be slower"). Raise or lower both
 * here; a node's `callsFrom` set again starts its high days over.
 */
export const DAILY_CALLS_START = 80;
export const DAILY_CALLS_EASE_DAYS = 28;

/** Today's judge calls for a node whose high days began at `fromIso`. Pure. */
export function dailyCallsMax(fromIso: string | undefined, nowMs: number): number {
  const from = fromIso ? Date.parse(fromIso) : NaN;
  if (!Number.isFinite(from)) return DAILY_CALLS_START;
  const days = Math.max(0, (nowMs - from) / (24 * 3600_000));
  if (days >= DAILY_CALLS_EASE_DAYS) return DAILY_CALLS_MAX;
  return Math.round(DAILY_CALLS_START - (DAILY_CALLS_START - DAILY_CALLS_MAX) * (days / DAILY_CALLS_EASE_DAYS));
}
/** Of those, the calls only the specific signals (asks, defects, not his to answer, overrules) may spend. */
export const DAILY_CALLS_RESERVED = 15;
/**
 * Corrections a Main or lead task's chat (the user's own) may get a day from reflections, at most one
 * an hour; what waits is held and goes with the next one (held-corrections.ts). 2026-11-24 audit: at
 * 2 a day, 14 of 16 different corrections about the lead's own chat in 35 minutes were never sent.
 */
export const CHAT_SENDS_PER_DAY_MAX = 12;
export const CHAT_SEND_GAP_MS = 60 * 60_000;
/** Keys of `budgetLeft` kept; past it a pass that meets one counts it again. */
export const BUDGET_LEFT_KEPT = 200;

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
    ...(typeof r.nightly === 'string' ? { nightly: r.nightly } : {}),
    ...(typeof r.painsNote === 'string' ? { painsNote: r.painsNote } : {}),
    ...(Array.isArray(r.backfilled) ? { backfilled: r.backfilled.filter((s): s is string => typeof s === 'string').slice(-500) } : {}),
    ...(Array.isArray(r.backfillGaveUp) ? { backfillGaveUp: r.backfillGaveUp.filter((s): s is string => typeof s === 'string').slice(-500) } : {}),
    ...(r.merges?.date === today && Number.isFinite(r.merges.count) ? { merges: r.merges } : {}),
    ...(Array.isArray(r.mergedLessons) ? { mergedLessons: r.mergedLessons.filter((m): m is { lesson: string; line: string } => !!m && typeof m.lesson === 'string' && typeof m.line === 'string').slice(-500) } : {}),
    ...(r.aligned && Array.isArray(r.aligned.rules) ? { aligned: { rules: r.aligned.rules.filter((k): k is string => typeof k === 'string').slice(0, 1000), ...(Number.isFinite(r.aligned.short) ? { short: r.aligned.short } : {}) } } : {}),
    ...(r.aligns?.date === today && Number.isFinite(r.aligns.count) ? { aligns: r.aligns } : {}),
    ...(Array.isArray(r.alignLog) ? { alignLog: r.alignLog.filter((x) => !!x && typeof x.line === 'string').slice(-50) } : {}),
    ...(typeof r.tidyAsked === 'string' ? { tidyAsked: r.tidyAsked } : {}),
    ...(typeof r.callsFrom === 'string' ? { callsFrom: r.callsFrom } : {}),
    ...(Array.isArray(r.held) ? { held: r.held.filter((h): h is HeldCorrection => !!h && typeof h.taskId === 'string' && typeof h.at === 'string' && typeof h.text === 'string' && typeof h.date === 'string' && typeof h.entryAt === 'string').slice(-100) } : {}),
    ...(typeof r.lastChatSendAt === 'string' ? { lastChatSendAt: r.lastChatSendAt } : {}),
    ...(r.backfillTries && typeof r.backfillTries === 'object' ? { backfillTries: Object.fromEntries(Object.entries(r.backfillTries).filter(([, n]) => Number.isFinite(n))) } : {}),
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
export async function claimCandidate(
  nodeId: string, key: string, nowMs = Date.now(), max = DAILY_CALLS_MAX, opts: { free?: boolean } = {},
): Promise<'ok' | 'seen' | 'budget'> {
  return updateReflectionState(nodeId, (s) => {
    if (s.seen[key]) return 'seen';
    // A check with no model call (wrong_language) spends nothing of the budget.
    if (!opts.free) {
      if (s.day.calls >= max) return 'budget';
      s.day.calls++;
    }
    s.seen[key] = { at: new Date(nowMs).toISOString(), verdict: 'pending' };
    return 'ok';
  }, nowMs);
}

/**
 * Record what the spent budget left unjudged this pass: today's moments in `budgetLeft` (unseen,
 * judged by a later pass while young enough), an earlier day's counted in `budgetDropped` and marked
 * seen. Answers today's left count.
 */
/** `first`: the first time today the budget left any (the day's record says it once). */
export async function recordBudgetLeft(nodeId: string, left: readonly string[], dropped: readonly string[], nowMs = Date.now()): Promise<{ count: number; first: boolean }> {
  if (!left.length && !dropped.length) return { count: 0, first: false };
  return updateReflectionState(nodeId, (s) => {
    const first = s.day.budgetLeftCount === undefined && s.day.budgetDropped === undefined;
    const kept = s.day.budgetLeft ?? [];
    let count = s.day.budgetLeftCount ?? kept.length;
    for (const k of left) {
      if (kept.includes(k)) continue;
      count++;
      if (kept.length < BUDGET_LEFT_KEPT) kept.push(k);
    }
    s.day.budgetLeft = kept;
    s.day.budgetLeftCount = count;
    if (dropped.length) s.day.budgetDropped = (s.day.budgetDropped ?? 0) + dropped.length;
    for (const k of dropped) s.seen[k] ??= { at: new Date(nowMs).toISOString(), verdict: 'skipped_dropped' };
    return { count, first };
  }, nowMs);
}

/** Mark keys seen with no judge call (a candidate the second look dropped). */
export async function markSeen(nodeId: string, keys: readonly string[], verdict: string, nowMs = Date.now()): Promise<void> {
  if (!keys.length) return;
  await updateReflectionState(nodeId, (s) => {
    for (const k of keys) s.seen[k] ??= { at: new Date(nowMs).toISOString(), verdict };
  }, nowMs);
}

/** Take one of today's corrections to a Main or lead task's chat, kept on that task's own state; false when spent or sent less than an hour ago. */
export async function takeChatSend(targetId: string, nowMs = Date.now(), max = CHAT_SENDS_PER_DAY_MAX): Promise<boolean> {
  return updateReflectionState(targetId, (s) => {
    if ((s.day.chatSends ?? 0) >= max) return false;
    if (s.lastChatSendAt && nowMs - Date.parse(s.lastChatSendAt) < CHAT_SEND_GAP_MS) return false;
    s.day.chatSends = (s.day.chatSends ?? 0) + 1;
    s.lastChatSendAt = new Date(nowMs).toISOString();
    return true;
  }, nowMs);
}

/** A chat send taken at `nowMs` that did not go: given back, so the chat's next correction need not wait the hour. */
export async function giveBackChatSend(targetId: string, nowMs: number): Promise<void> {
  await updateReflectionState(targetId, (s) => {
    if (s.lastChatSendAt !== new Date(nowMs).toISOString()) return;
    delete s.lastChatSendAt;
    s.day.chatSends = Math.max(0, (s.day.chatSends ?? 1) - 1);
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
