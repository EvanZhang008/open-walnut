/**
 * Engines compared on finished work (Usage & Costs, "Engines compared"): for each coding
 * engine and the company whose model it ran, the tasks it finished in a period, how long
 * they took, what they cost, how many review subtasks they needed, and how much rework
 * followed (the user's own messages into the task, reopens after completion, errors).
 *
 * A task belongs to the engine and model family that carried most of its spend (a task
 * that switched engines counts where its money went), else to its session's engine; counting
 * only the split's tasks (the fair test), it stays where the split put it. A task with no
 * usage recorded has an unknown cost, never a zero one. Counted:
 * ordinary work with a session; not Main, a VP or a lead, a Personal AI ask, a routine's
 * run or a plugin's own task. Reviewer subtasks are their own rows (their title says
 * "review"); a task's review count is how many it had.
 */
import type { SessionEngine, Task } from '../types.js';
import { SCORE_DIMENSIONS, type ReviewScore } from '../peers/structured-reply.js';
import { builderLabel, REVIEW_RE, splitBuilders } from '../agents/engine-split.js';
import { resolveEngine } from '../agents/engine-registry.js';
import type { CostRollup } from './cost-rollup.js';
import { CostPricer } from './cost-report.js';
import { ensurePriceBook, priceThresholds, type UserPriceRates } from './price-book.js';
import { columnLabelOf, ENGINE_FAMILY, modelFamily, modelLineLabel, modelTier, type ModelFamily } from './model-line.js';

export { modelFamily, modelTier, type ModelFamily } from './model-line.js';

/** What one task's usage summed to. */
export interface TaskSpend {
  costUsd: number;
  tokens: number;
  outputTokens: number;
  /** Requests with no price: costUsd leaves them out. */
  unpriced: number;
  /** Requests whose token counts were not recorded: cost and tokens both leave them out. */
  unknown: number;
  /** The engine and model that carried most of the cost (or tokens, when nothing was priced). */
  engine: string;
  model: string;
}

export interface EngineCompareTask {
  taskId: string;
  title: string;
  project: string;
  key: string;
  done: boolean;
  hours: number | null;
  costUsd: number;
  /** Some of its requests have no price, or none of its usage was recorded, so costUsd is a floor. */
  partialCost: boolean;
  /** No usage of it was recorded (an engine Walnut does not read usage from, or requests with no token counts): cost and tokens are unknown. */
  noUsage: boolean;
  /** Some of its requests have no token counts (or none were recorded): tokens are a floor. */
  partialTokens: boolean;
  tokens: number;
  reviews: number;
  /** What its reviewer subtasks cost. */
  reviewCostUsd: number;
  /** A reviewer used a model with no price, so reviewCostUsd is a floor. */
  reviewPartialCost: boolean;
  /** A reviewer subtask on another company's model than the one that did the work gave a verdict;
   *  absent when none of its reviewers ran on a known company's model (or its own is unknown). */
  crossReviewed?: boolean;
  /** Its reviewers' latest verdict out of 10: each company's latest score, the lower on each of
   *  function / UX / UI (the bar both must clear); absent when no reviewer gave one. */
  score?: ReviewScore;
  /** How many reviewers that verdict rests on (one per company). */
  scoredBy?: number;
  /** Their companies ("Claude", "GPT"; "unknown" for a reviewer whose model is not known). */
  scoredFamilies?: string[];
  /** No reviewer scored all three: `score` holds the parts given, and the engine's medians leave it out. */
  scorePartial?: boolean;
  followUps: number;
  reopens: number;
  errored: boolean;
  /** The engine split chose its engine. */
  split: boolean;
  /** Closed after a start that never ran a turn: neither finished nor open. */
  notStarted?: boolean;
  /** The split assigned it one engine and most of its cost ran on another (an engine switch, a rescue). */
  switched: boolean;
}

export interface EngineCompareRow {
  key: string;
  engine: string;
  family: ModelFamily;
  label: string;
  done: number;
  open: number;
  /** Of done + open, how many the engine split assigned. */
  split: number;
  medianHours: number | null;
  costUsd: number;
  /** Tasks whose cost leaves out requests with no price, or that have no usage recorded. */
  partialCost: number;
  /** Tasks with no usage recorded: their tokens are unknown too. */
  noUsage: number;
  /** Tasks whose tokens leave out requests with no token counts (noUsage ones included). */
  partialTokens: number;
  /** Of the finished tasks with usage (the medians'), those whose cost or tokens are a floor. */
  partialCostDone: number;
  partialTokensDone: number;
  /** Finished tasks with no usage recorded: left out of the medians. */
  noUsageDone: number;
  /** Closed tasks that never ran a session (their start failed): neither finished nor open. */
  notStarted: number;
  /** Finished tasks with a known time (the time median's samples). */
  timedDone: number;
  /** Tasks the split assigned whose cost mostly ran on another engine. */
  switched: number;
  medianCostUsd: number | null;
  tokens: number;
  medianTokens: number | null;
  /** Review subtasks per finished task. */
  reviewsPerTask: number | null;
  /** What those reviewers cost, per finished task. */
  reviewCostPerTask: number | null;
  /** Finished tasks whose review cost leaves out unpriced requests (the per-task review cost is of finished tasks). */
  reviewPartialCost: number;
  /** Share of the finished tasks whose reviewers' companies are known that a reviewer on another
   *  company's model checked (0..1); null when no finished task has such a reviewer. */
  crossReviewedShare: number | null;
  /** Its share's samples: finished tasks with a reviewer of a known company. */
  crossKnownDone: number;
  /** Finished tasks with at least one reviewer subtask (the review cost's samples). */
  reviewedDone: number;
  /** Median reviewer score of its finished tasks, per dimension (out of 10); null when none was scored. */
  reviewScore: ReviewScore | null;
  /** Finished tasks with a reviewer score (the medians' samples). */
  scoredDone: number;
  /** The user's messages per finished task. */
  followUpsPerTask: number | null;
  reopens: number;
  errored: number;
  /** Share of finished tasks reopened at least once (0..1). */
  reopenedShare: number | null;
  /** Share of all its tasks whose session had an error (0..1). */
  erroredShare: number | null;
}

export interface EngineCompare {
  range: { start: string | null; end: string | null };
  rows: EngineCompareRow[];
  /** The tasks behind the rows, newest finished first, at most TASKS_MAX. */
  tasks: EngineCompareTask[];
  projects: { project: string; tasks: number }[];
  split: { on: boolean; entries: { key: string; label: string; weight: number }[] };
  /** How many tasks the rows count (the list holds the latest TASKS_MAX of them). */
  taskCount: number;
  /** Only tasks the engine split assigned were counted. */
  splitOnly: boolean;
  /** Tasks in the period (and project) the split assigned, whichever tasks are counted. */
  splitTasks: number;
  /** What 'auto' counts in this period: true = only the split's tasks. */
  auto: boolean;
}

/** 'auto' counts only the split's tasks once it assigned this many: two columns of five finished. */
export const AUTO_SPLIT_MIN = 10;

export const TASKS_MAX = 60;
/** Of those, at most this many open or never-started ones, always shown even when finished ones would fill the list. */
export const TASKS_OTHERS_MAX = 20;


export interface CompareInput {
  tasks: readonly Task[];
  /** By session id: what Walnut's record says. */
  sessions: ReadonlyMap<string, { engine?: SessionEngine; startedAt?: string; model?: string; cliModel?: string; acpModel?: string;
    process_status?: string; status_history?: { process_status?: string; reason?: string; timestamp?: string }[]; errorCount?: number;
    contextTokens?: number | null; lastCompactUuid?: string; summary?: string; messageCount?: number;
    promptCache?: { requestAt?: string }; firstTurnAt?: string }>;
  spend: ReadonlyMap<string, TaskSpend>;
  followUps: (taskId: string) => number;
  range: { start?: string; end?: string };
  project?: string;
  /** Count only tasks the engine split assigned (a fair test: no engine was picked by hand); 'auto' decides. */
  splitOnly?: boolean | 'auto';
  config?: { defaults?: { engine_split?: unknown; engine_split_off?: unknown } } | null;
  /** YYYY-MM-DD of an ISO time in the report's time zone. */
  dayOf: (iso: string) => string;
}

/** Nothing of it is known: no spend, or every request it made has no token counts. */
function usageUnknown(spend: TaskSpend | undefined): boolean {
  return !spend || (spend.unknown > 0 && spend.tokens === 0 && spend.costUsd === 0);
}

/**
 * A column's name: the engine alone on its own company's models ("Claude Code", "Codex"), with the model
 * line when one is known ("Claude Code · Sonnet"), and the company when it is another's ("Claude Code · GPT Sol").
 */
function columnLabel(engine: string, family: ModelFamily, tier: string | null): string {
  return columnLabelOf(builderLabel({ engine: engine as SessionEngine }), engine, family, tier);
}

/** A split entry's name, as its column is named in the fair view: "Claude Code", "Claude Code · Sonnet". */
function entryLabelOf(b: { engine: SessionEngine; model?: string }): string {
  return modelLineLabel(builderLabel({ engine: b.engine }), resolveEngine(b.engine), b.model);
}

/**
 * The split's entries by key, named as the card shows them: an entry with no model, beside one of the
 * same engine that names a model, says it runs the engine's default ("Claude Code · default model"
 * beside "Claude Code · Sonnet"), so the two columns are told apart.
 */
function entryLabels(builders: ReadonlyArray<{ key: string; engine: SessionEngine; model?: string }>): Map<string, string> {
  return new Map(builders.map((b) => {
    const twin = !b.model && builders.some((o) => o.engine === b.engine && !!o.model);
    return [b.key, `${entryLabelOf(b)}${twin ? ' · default model' : ''}`];
  }));
}

type SessionFacts = CompareInput['sessions'] extends ReadonlyMap<string, infer R> ? R : never;

/**
 * A session that ran at least one turn: the first turn time Walnut keeps on the record, a main-loop
 * request (Claude Code's prompt cache facts), a turn end in its status moves, context (an ACP engine's),
 * a summary or a compaction.
 */
function sessionRanTurn(s: SessionFacts | undefined): boolean {
  if (!s) return false;
  // Not messageCount: Claude Code counts a spawn that got its pid, before any turn ran.
  return !!s.firstTurnAt || s.contextTokens != null || !!s.lastCompactUuid || !!s.summary || !!s.promptCache?.requestAt
    || !!s.status_history?.some((h) => h.reason === 'turn_completed');
}

/** A session that died in error, at any point (the evidence a start failed, when no turn ran). */
function sessionErrored(s: SessionFacts | undefined): boolean {
  return s?.process_status === 'error' || (s?.errorCount ?? 0) > 0 || !!s?.status_history?.some((h) => h.process_status === 'error');
}

/**
 * When a session's work began, for a task first closed at `firstClose`; undefined when it did none.
 * - Its first turn ran after a close that came after its start (a CLI that died before its first
 *   reply, resumed under the same id after a reopen): the work began with that turn.
 * - It ran a turn (that one known, or only signs of one on an older record): its start.
 * - No sign of a turn, and it died in error: the record of a failed start, no work.
 * - No sign either way (an older record): its start.
 */
function workStartOf(s: SessionFacts, firstClose: string | undefined): string | undefined {
  const at = s.startedAt;
  if (!at) return undefined;
  if (s.firstTurnAt) return firstClose && at <= firstClose && s.firstTurnAt > firstClose ? s.firstTurnAt : at;
  if (sessionRanTurn(s)) return at;
  return sessionErrored(s) ? undefined : at;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The task's session: its slot, the older exec slot a stored row may still use, else its last one. */
export function taskSessionId(t: Pick<Task, 'session_id' | 'exec_session_id' | 'session_ids'>): string | undefined {
  return t.session_id || t.exec_session_id || (Array.isArray(t.session_ids) ? t.session_ids.at(-1) : undefined) || undefined;
}

function counted(t: Task): boolean {
  // A start that failed before its engine named a session (an ACP engine names it late) still counts, as an error.
  if ((!taskSessionId(t) && !t.engine_pick && !t.last_start) || t.org_role || t.walnut_agent || t.routine_start || t.plugin_only) return false;
  return !/^ask /i.test((t.project ?? '').trim());
}

/** Every session the task held. */
function sessionsOf(t: Task): string[] {
  return [...new Set([t.session_id, t.exec_session_id, t.last_start?.session_id, ...(t.session_ids ?? []), ...(t.legacy_session_ids ?? [])]
    .filter((x): x is string => !!x))];
}

/**
 * When the task's work began: the earliest work start among its sessions (workStartOf), so a failed
 * start's empty session, kept in legacy_session_ids after a retry or resumed by it, never dates or times
 * the work; with none that did work, the earliest start of all.
 */
function firstStart(t: Task, sessions: CompareInput['sessions']): string | undefined {
  let first: string | undefined;
  let firstWork: string | undefined;
  for (const id of sessionsOf(t)) {
    const s = sessions.get(id);
    const at = s?.startedAt;
    if (!s || !at) continue;
    if (!first || at < first) first = at;
    const workAt = workStartOf(s, t.first_completed_at);
    if (workAt && (!firstWork || workAt < firstWork)) firstWork = workAt;
  }
  return firstWork ?? first;
}

/** One company's latest score on a task, part by part, with when each part was given. */
type CompanyScore = ReviewScore & { at: Record<string, string> };

/**
 * A task's verdict: each company's latest score, the lower on each dimension, every company's
 * parts counted (a dissent is never hidden). It is a full verdict only when some company scored
 * all three; otherwise the parts are shown but marked partial, so one company's function score and
 * another's UX and UI never add up to a full one.
 */
function verdictOf(byFam: ReadonlyMap<string, CompanyScore> | undefined): { score?: ReviewScore; scoredBy?: number; scoredFamilies?: string[]; scorePartial?: boolean } {
  if (!byFam?.size) return {};
  const full = (x: ReviewScore) => SCORE_DIMENSIONS.every((d) => typeof x[d] === 'number');
  const fullOnes = [...byFam].filter(([, x]) => full(x));
  const used = [...byFam];
  const score: ReviewScore = {};
  for (const d of SCORE_DIMENSIONS) {
    const vals = used.map(([, x]) => x[d]).filter((v): v is number => typeof v === 'number');
    if (vals.length) score[d] = Math.min(...vals);
  }
  const families = used.map(([k]) => (k.startsWith('?') ? 'unknown' : k)).sort();
  return Object.keys(score).length ? { score, scoredBy: used.length, scoredFamilies: families, ...(fullOnes.length ? {} : { scorePartial: true }) } : {};
}

/** The median of each dimension over the finished tasks that carry a score. */
function scoreMedians(done: readonly EngineCompareTask[]): { reviewScore: ReviewScore | null; scoredDone: number } {
  // Only tasks scored on all three: a UI median from one task of six would read as six.
  const scored = done.filter((p) => p.score && !p.scorePartial && SCORE_DIMENSIONS.every((d) => typeof p.score![d] === 'number'));
  if (!scored.length) return { reviewScore: null, scoredDone: 0 };
  const out: ReviewScore = {};
  for (const d of SCORE_DIMENSIONS) {
    const m = median(scored.map((p) => p.score![d]).filter((v): v is number => typeof v === 'number'));
    if (m !== null) out[d] = Math.round(m * 10) / 10;
  }
  return { reviewScore: Object.keys(out).length ? out : null, scoredDone: scored.length };
}

function inRange(day: string, range: { start?: string; end?: string }): boolean {
  return (!range.start || day >= range.start) && (!range.end || day <= range.end);
}

/** The comparison, from tasks, their sessions and their spend. Pure. */
export function aggregateEngineCompare(input: CompareInput): EngineCompare {
  const reviewsOf = new Map<string, number>();
  const reviewCostOf = new Map<string, number>();
  const reviewPartial = new Set<string>();
  // The model families each task's reviewers ran on: their usage, else their session's model.
  const reviewFamiliesOf = new Map<string, Set<ModelFamily>>();
  // Tasks with a reviewer of a known company, verdict or not: whether another company checked them is known.
  const reviewKnownOf = new Set<string>();
  // Each company's latest reviewer score per task.
  const scoresOf = new Map<string, Map<string, CompanyScore>>();
  for (const t of input.tasks) {
    if (!t.parent_task_id || !REVIEW_RE.test(t.title)) continue;
    const spend = input.spend.get(t.id);
    const rsid = taskSessionId(t);
    const rs = rsid ? input.sessions.get(rsid) : undefined;
    // Only evidence names the company: a model, else the engine a session or start recorded (never a default).
    // A model of no known company (Claude Code running a Qwen model) is an unknown company, never the engine's.
    const rEngine = spend?.engine ?? rs?.engine ?? t.last_start?.engine;
    const named = [spend?.model, rs?.acpModel ?? rs?.cliModel ?? rs?.model].map(modelFamily).filter((f): f is ModelFamily => !!f);
    const rfam = named.length ? named.find((f) => f !== 'Other')
      : (rEngine ? ENGINE_FAMILY[resolveEngine(rEngine)] : undefined);
    // Checked means a verdict came back: a score, a result, or a finished review that ran a turn.
    // A reviewer whose start failed before any turn tried; it checked nothing.
    const ranTurn = !!spend || sessionsOf(t).some((id) => sessionRanTurn(input.sessions.get(id)));
    const verdict = !!t.review_score || !!t.result_report || (t.phase === 'COMPLETE' && ranTurn);
    if (rfam) reviewKnownOf.add(t.parent_task_id);
    if (rfam && verdict) {
      if (!reviewFamiliesOf.has(t.parent_task_id)) reviewFamiliesOf.set(t.parent_task_id, new Set());
      reviewFamiliesOf.get(t.parent_task_id)!.add(rfam);
    }
    if (t.review_score) {
      if (!scoresOf.has(t.parent_task_id)) scoresOf.set(t.parent_task_id, new Map());
      const byFam = scoresOf.get(t.parent_task_id)!;
      // A reviewer of no known company is a company of its own: two unknown reviewers are never one.
      const fk = rfam ?? `?${t.id}`;
      // Within a company, each part's latest: a later UI-only score updates UI and keeps the rest.
      const was: CompanyScore = byFam.get(fk) ?? { at: {} };
      for (const d of SCORE_DIMENSIONS) {
        const v = t.review_score[d];
        if (typeof v !== 'number') continue;
        const at = t.review_score.parts_at?.[d] ?? t.review_score.at ?? '';
        if (was[d] === undefined || at > (was.at[d] ?? '')) { was[d] = v; was.at[d] = at; }
      }
      byFam.set(fk, was);
    }
    reviewsOf.set(t.parent_task_id, (reviewsOf.get(t.parent_task_id) ?? 0) + 1);
    reviewCostOf.set(t.parent_task_id, (reviewCostOf.get(t.parent_task_id) ?? 0) + (spend?.costUsd ?? 0));
    if (!spend || spend.unpriced > 0 || spend.unknown > 0) reviewPartial.add(t.parent_task_id);
  }
  // A column: `key` names it; `familyKey` is the engine, model family and model line it belongs to (the All view's columns).
  type Group = { key: string; familyKey: string; engine: string; family: ModelFamily; label: string };
  type Candidate = EngineCompareTask & { byCost: Group; byPick: Group | null; everDone: boolean; notStarted: boolean; sortAt: string };
  const entryLabel = entryLabels(splitBuilders(input.config));
  const candidates: Candidate[] = [];
  for (const t of input.tasks) {
    // A reviewer subtask counts toward its parent; a top-level task titled "Review ..." is work of its own.
    if (!counted(t) || (t.parent_task_id && REVIEW_RE.test(t.title))) continue;
    const sid = taskSessionId(t);
    const session = sid ? input.sessions.get(sid) : undefined;
    // Never ran a session (its start failed before one, and it was closed): not work the engine finished.
    const closed = t.phase === 'COMPLETE' && !!t.completed_at;
    const spend = input.spend.get(t.id);
    // Never ran a turn, on any engine: its start failed (the evidence), it has no usage, and no session of
    // it holds a conversation. Closed like that, it is not work the engine finished (Claude Code makes its
    // session record before the spawn, an ACP engine only after it, so the record alone says nothing).
    const ranTurn = !!spend || sessionsOf(t).some((id) => sessionRanTurn(input.sessions.get(id)));
    // The evidence its start failed: a refused start, or a session that died in error (a CLI that got its
    // pid and exited before its first reply leaves last_start "started" and only the session's error).
    const anySessionErrored = sessionsOf(t).some((id) => sessionErrored(input.sessions.get(id)));
    const notStarted = closed && !ranTurn && ((t.start_failures ?? 0) > 0 || t.last_start?.state === 'failed' || anySessionErrored);
    const done = closed && !notStarted;
    // From its first session's start (a restart, an engine switch or a recovery starts another)
    // to its first completion (a reopen adds the idle time before it otherwise).
    // No session start known (an old task whose records are gone, a start that never ran): no time, rather than its age.
    const sessionStart = firstStart(t, input.sessions);
    const startedAt = sessionStart ?? t.engine_pick?.at ?? t.created_at;
    // A completion before the work began is the close of a start that never ran (then reopened and
    // worked on): not a finish, so neither its date, its time nor its reopen counts. The first one
    // after is the first finish (a task from before the completion list has only its first).
    const completions = [...(t.completions?.length ? t.completions : t.first_completed_at ? [t.first_completed_at] : [])].sort();
    const unrunCloses = sessionStart ? completions.filter((c) => c < sessionStart).length : 0;
    const firstDone = completions[unrunCloses];
    const finishedAt = firstDone && t.completed_at && firstDone < t.completed_at ? firstDone : t.completed_at;
    // Finished: the day it finished. Reopened and open again: the day it first finished, so the
    // rework stays in the period of the work it reopened. Never finished: the day it started.
    const day = input.dayOf(firstDone ?? (closed ? t.completed_at! : startedAt));
    if (!inRange(day, input.range)) continue;
    const engine = resolveEngine(spend?.engine ?? session?.engine ?? t.engine_pick?.engine ?? t.last_start?.engine);
    // The first signal that names a known family; a model id of no known family (a proxy alias) falls
    // through to the next, so one engine is not split into a known column and an "Other" one.
    const named = [spend?.model, session?.acpModel ?? session?.cliModel ?? session?.model, t.engine_pick?.model]
      .find((m) => { const f = modelFamily(m); return !!f && f !== 'Other'; });
    const family = (named ? modelFamily(named) : null) ?? ENGINE_FAMILY[engine] ?? 'Other';
    // The All view's column: the engine and the model line of that same signal (Opus and Sonnet apart).
    const tier = named ? modelTier(named) : null;
    const lineKey = `${engine}|${family}|${tier ?? ''}`;
    const byCost: Group = { key: lineKey, familyKey: lineKey, engine, family, label: columnLabel(engine, family, tier) };
    // Where the split put it: the fair test keeps a task in that column even when it was rescued elsewhere.
    let byPick: Group | null = null;
    const pickTier = modelTier(t.engine_pick?.model);
    if (t.engine_pick) {
      const pe = resolveEngine(t.engine_pick.engine);
      // Fixed at assignment: the model the entry names, else the engine's own default family, never
      // read back from where the cost went (a task moved to another model in the same engine is a move).
      // A model id of no known family (an alias) says nothing: the engine's own family stands.
      const pickFam = modelFamily(t.engine_pick.model);
      const pf = (pickFam && pickFam !== 'Other' ? pickFam : null) ?? ENGINE_FAMILY[pe] ?? (pe === engine ? family : 'Other');
      // One column per split entry: two entries of one engine and family (Claude Code and Claude Code
      // on Sonnet) are what the fair test compares, so they never merge.
      byPick = { key: `split:${t.engine_pick.key}`, familyKey: `${pe}|${pf}|${pickTier ?? ''}`, engine: pe, family: pf,
        label: entryLabel.get(t.engine_pick.key) ?? entryLabelOf({ engine: pe as SessionEngine, model: t.engine_pick.model }) };
    }
    const hours = done && sessionStart ? (Date.parse(finishedAt!) - Date.parse(sessionStart)) / 3600_000 : null;
    // Any session it held: a task that failed on one engine and finished on another still had the error.
    const errored = anySessionErrored || t.last_start?.state === 'failed' || (t.start_failures ?? 0) > 0;
    candidates.push({
      byCost, byPick, taskId: t.id, title: t.title, project: t.project ?? '', key: byCost.key, done,
      hours: hours !== null && Number.isFinite(hours) && hours >= 0 ? hours : null,
      // A task that never ran cost nothing: a known $0, not an unknown.
      costUsd: spend?.costUsd ?? 0, partialCost: !notStarted && (!spend || spend.unpriced > 0 || spend.unknown > 0), noUsage: !notStarted && usageUnknown(spend),
      partialTokens: !notStarted && (!spend || spend.unknown > 0), tokens: spend?.tokens ?? 0, reviews: reviewsOf.get(t.id) ?? 0, reviewCostUsd: reviewCostOf.get(t.id) ?? 0, reviewPartialCost: reviewPartial.has(t.id),
      ...(family !== 'Other' && reviewKnownOf.has(t.id) ? { crossReviewed: [...(reviewFamiliesOf.get(t.id) ?? [])].some((f) => f !== family) } : {}),
      ...verdictOf(scoresOf.get(t.id)),
      followUps: input.followUps(t.id), reopens: Math.max(0, (t.reopens ?? 0) - unrunCloses), errored, split: !!t.engine_pick,
      // A model id that names no known family ("Other": a proxy alias) is no evidence of a move within one engine.
      // An entry that names a model line (Claude Code on Sonnet) whose work ran on another known line moved too.
      switched: !!byPick && (byPick.engine !== byCost.engine || (byCost.family !== 'Other' && byPick.family !== byCost.family)
        || (!!pickTier && !!tier && pickTier !== tier)), everDone: !notStarted && (done || !!firstDone), notStarted, sortAt: done ? t.completed_at! : startedAt,
    });
  }
  // A task whose signals name no model line (no usage yet, an alias) joins its engine and family's one
  // line when there is only one, so one engine on one model is one column; with several, it stays apart.
  const linesOf = new Map<string, Map<string, Group>>();
  for (const c of candidates) {
    const fk = `${c.byCost.engine}|${c.byCost.family}`;
    if (c.byCost.key.endsWith('|')) continue;
    if (!linesOf.has(fk)) linesOf.set(fk, new Map());
    linesOf.get(fk)!.set(c.byCost.key, c.byCost);
  }
  for (const c of candidates) {
    if (!c.byCost.key.endsWith('|')) continue;
    const lines = linesOf.get(`${c.byCost.engine}|${c.byCost.family}`);
    if (lines?.size === 1) c.byCost = [...lines.values()][0];
    c.key = c.byCost.key;
  }
  const builders = splitBuilders(input.config);
  const labels = entryLabels(builders);
  const entries = builders.map((b) => ({ key: b.key, label: labels.get(b.key)!, weight: b.weight }));
  const splitOn = entries.length >= 2;
  const inProject = (c: Candidate) => input.project === undefined || c.project === input.project;
  const splitTasks = candidates.filter((c) => c.split && inProject(c)).length;
  // 'auto': the split's own tasks once it is on and assigned enough in the period to compare, else every task.
  // Decided on the whole period, so choosing a project never flips which tasks count.
  const auto = splitOn && candidates.filter((c) => c.split).length >= AUTO_SPLIT_MIN;
  const splitOnly = input.splitOnly === 'auto' ? auto : !!input.splitOnly;
  const scoped = splitOnly ? candidates.filter((c) => c.split) : candidates;
  const projects = new Map<string, number>();
  for (const c of scoped) projects.set(c.project, (projects.get(c.project) ?? 0) + 1);
  const picked = scoped.filter(inProject).map((c) => {
    const g = splitOnly && c.byPick ? c.byPick : c.byCost;
    return { ...c, key: g.key, group: g };
  });
  const meta = new Map(picked.map((p) => [p.key, p.group]));
  const splitView = splitOnly;
  // The column a moved task was assigned, where its move counts: the split's entry; counting every task,
  // the column of the engine and family it was given (its model line when that has a column, else the
  // family's one line), none when that is not one column.
  const movedFrom = (p: (typeof picked)[number]): string | undefined => {
    if (!p.byPick) return undefined;
    if (splitView) return p.byPick.key;
    if (meta.has(p.byPick.familyKey)) return p.byPick.familyKey;
    const fam = `${p.byPick.engine}|${p.byPick.family}|`;
    const lines = [...meta.keys()].filter((k) => k.startsWith(fam));
    return lines.length === 1 ? lines[0] : undefined;
  };
  const rows: EngineCompareRow[] = [];
  for (const [key, { engine, family, label: named }] of meta) {
    // Counting every task, a column whose usage names no model line, beside a line of the same engine
    // and family, says so: "Claude Code" next to "Claude Code · Opus" read as one of them.
    const lineless = !splitView && key.endsWith('|') && [...meta.keys()].some((k) => k !== key && k.startsWith(key));
    const label = lineless ? `${named} · model unknown` : named;
    const all = picked.filter((p) => p.key === key);
    const done = all.filter((p) => p.done);
    const known = done.filter((p) => !p.noUsage);
    const everDone = all.filter((p) => p.everDone);
    const per = (f: (p: EngineCompareTask) => number) => done.length ? done.reduce((a, p) => a + f(p), 0) / done.length : null;
    rows.push({
      key, engine, family, label,
      done: done.length, open: all.filter((p) => !p.done && !p.notStarted).length, notStarted: all.filter((p) => p.notStarted).length,
      split: all.filter((p) => p.split).length,
      medianHours: median(done.map((p) => p.hours).filter((h): h is number => h !== null)),
      costUsd: all.reduce((a, p) => a + p.costUsd, 0), partialCost: all.filter((p) => p.partialCost).length,
      // The medians are of finished tasks: only those can make them a floor (a task that just started cannot).
      // A finished task with no usage at all is left out of the medians (noUsageDone), not a floor of them.
      partialCostDone: known.filter((p) => p.partialCost).length, partialTokensDone: known.filter((p) => p.partialTokens).length,
      noUsageDone: done.length - known.length, timedDone: done.filter((p) => p.hours !== null).length,
      // Under the column the split assigned, in either view.
      noUsage: all.filter((p) => p.noUsage).length, partialTokens: all.filter((p) => p.partialTokens).length, switched: picked.filter((p) => p.switched && movedFrom(p) === key).length,
      // Medians of the tasks whose usage is known: an unknown is not a zero (none known reads "-").
      medianCostUsd: median(known.map((p) => p.costUsd)),
      tokens: all.reduce((a, p) => a + p.tokens, 0), medianTokens: median(known.map((p) => p.tokens)),
      reviewsPerTask: per((p) => p.reviews), reviewCostPerTask: per((p) => p.reviewCostUsd), reviewPartialCost: done.filter((p) => p.reviewPartialCost).length,
      ...(() => {
        const known = done.filter((p) => p.crossReviewed !== undefined);
        return { crossReviewedShare: known.length ? known.filter((p) => p.crossReviewed).length / known.length : null, crossKnownDone: known.length };
      })(),
      reviewedDone: done.filter((p) => p.reviews > 0).length,
      ...scoreMedians(done), followUpsPerTask: per((p) => p.followUps),
      reopens: all.reduce((a, p) => a + p.reopens, 0), errored: all.filter((p) => p.errored).length,
      // Of the tasks ever finished, a reopened one still being worked on included (it is not "done" now).
      reopenedShare: everDone.length ? everDone.filter((p) => p.reopens > 0).length / everDone.length : null,
      erroredShare: all.length ? all.filter((p) => p.errored).length / all.length : null,
    });
  }
  rows.sort((a, b) => b.done - a.done || b.open - a.open || a.label.localeCompare(b.label));
  // Finished first, then open, then the ones that never started; newest first in each part
  // (finished by when they finished, the others by when they started). The open and never-started
  // keep their own places, so a long run of finished work never hides them.
  const ordered = [...picked]
    .sort((a, b) => Number(b.done) - Number(a.done) || Number(a.notStarted) - Number(b.notStarted) || b.sortAt.localeCompare(a.sortAt));
  const others = ordered.filter((x) => !x.done).slice(0, TASKS_OTHERS_MAX);
  const tasks = [...ordered.filter((x) => x.done).slice(0, TASKS_MAX - others.length), ...others]
    .map(({ sortAt: _f, byCost: _c, byPick: _p, group: _g, everDone: _d, ...t }) => t);
  return {
    range: { start: input.range.start ?? null, end: input.range.end ?? null }, rows, tasks,
    projects: [...projects].sort((a, b) => b[1] - a[1]).map(([project, n]) => ({ project, tasks: n })),
    split: { on: splitOn, entries }, taskCount: picked.length, splitOnly, splitTasks, auto,
  };
}

/**
 * Every task's whole spend (all time: a task finished this week may have started last month),
 * priced the way the Usage & Costs page prices it, with the engine and model that carried most of it.
 */
/** One computed spend map, reused for a minute: the page asks again on every period or project change. */
let spendCache: { at: number; key: string; value: Map<string, TaskSpend> } | null = null;
const SPEND_CACHE_MS = 60_000;

/** `key` names the usage it was read from (a finished collection changes it), so new usage is never served stale. */
export async function cachedTaskSpend(key: string, ...args: Parameters<typeof taskSpend>): Promise<Map<string, TaskSpend>> {
  if (spendCache && spendCache.key === key && Date.now() - spendCache.at < SPEND_CACHE_MS) return spendCache.value;
  const value = await taskSpend(...args);
  spendCache = { at: Date.now(), key, value };
  return value;
}

export async function taskSpend(rollup: CostRollup, overrides: Record<string, UserPriceRates> | undefined,
  sessionTask: (sid: string) => string | undefined): Promise<Map<string, TaskSpend>> {
  await ensurePriceBook();
  const thresholds = priceThresholds(overrides);
  rollup.setThresholds(thresholds);
  const pricer = new CostPricer(thresholds, overrides);
  const out = new Map<string, TaskSpend>();
  // Per task, what each engine, model family and model line carried (the All view's columns: Opus and
  // Sonnet apart), so a task counts under the line that cost the most, never the first model by name.
  const groups = new Map<string, Map<string, { engine: string; model: string; cost: number; tokens: number }>>();
  for (const r of rollup.query({ sources: ['session'], by: ['engine', 'session', 'task'] })) {
    const taskId = (r.taskId as string | null) ?? sessionTask(r.sessionId as string);
    if (!taskId) continue;
    const p = pricer.price(r.model, r.band, { ...r, requests: r.calls });
    const tokens = p.input + p.output + p.cacheRead + p.cacheWrite5m + p.cacheWrite1h;
    const acc = out.get(taskId) ?? { costUsd: 0, tokens: 0, outputTokens: 0, unpriced: 0, unknown: 0, engine: r.engine, model: r.model };
    acc.costUsd += p.costUsd; acc.tokens += tokens; acc.outputTokens += p.output; acc.unpriced += p.unpriced;
    acc.unknown += Number(r.unknown) || 0;
    out.set(taskId, acc);
    const byGroup = groups.get(taskId) ?? new Map();
    const gk = `${r.engine}\u0000${modelFamily(r.model) ?? 'Other'}\u0000${modelTier(r.model) ?? ''}`;
    const g = byGroup.get(gk) ?? { engine: r.engine, model: r.model, cost: 0, tokens: 0 };
    g.cost += p.costUsd; g.tokens += tokens;
    byGroup.set(gk, g);
    groups.set(taskId, byGroup);
  }
  // Dollars first; tokens only break a tie (unpriced work, or equal cost).
  for (const [taskId, byGroup] of groups) {
    let top: { engine: string; model: string; cost: number; tokens: number } | null = null;
    for (const g of byGroup.values()) {
      if (!top || g.cost > top.cost + 1e-12 || (Math.abs(g.cost - top.cost) <= 1e-12 && g.tokens > top.tokens)) top = g;
    }
    const acc = out.get(taskId)!;
    acc.engine = top!.engine; acc.model = top!.model;
  }
  return out;
}
