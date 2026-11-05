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
import { builderLabel, splitBuilders } from '../agents/engine-split.js';
import { resolveEngine } from '../agents/engine-registry.js';
import type { CostRollup } from './cost-rollup.js';
import { CostPricer } from './cost-report.js';
import { ensurePriceBook, priceThresholds, type UserPriceRates } from './price-book.js';

/** Which company's model a model id is. */
export type ModelFamily = 'Claude' | 'GPT' | 'Gemini' | 'Other';

export function modelFamily(model: string | undefined | null): ModelFamily | null {
  const m = (model ?? '').toLowerCase();
  if (!m) return null;
  if (/claude|anthropic|opus|sonnet|haiku|fable/.test(m)) return 'Claude';
  if (/gpt|openai|(^|[^a-z])o[1-9]|codex/.test(m)) return 'GPT';
  if (/gemini/.test(m)) return 'Gemini';
  return 'Other';
}

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
  followUps: number;
  reopens: number;
  errored: boolean;
  /** The engine split chose its engine. */
  split: boolean;
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
  /** Tasks the split assigned whose cost mostly ran on another engine. */
  switched: number;
  medianCostUsd: number | null;
  tokens: number;
  medianTokens: number | null;
  /** Review subtasks per finished task. */
  reviewsPerTask: number | null;
  /** What those reviewers cost, per finished task. */
  reviewCostPerTask: number | null;
  /** Tasks whose review cost leaves out unpriced requests. */
  reviewPartialCost: number;
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
/** A reviewer subtask: its title starts with "review" (after a bracketed tag) or names a reviewer. */
const REVIEW_RE = /^\s*(?:\[[^\]]*\]\s*)?(?:code |ui |ux |design |final |second |independent )?review\b|\breviewer\b/i;

/** The model family an engine runs when nothing says otherwise. */
const ENGINE_FAMILY: Record<string, ModelFamily> = { claude: 'Claude', codex: 'GPT', gemini: 'Gemini' };

export interface CompareInput {
  tasks: readonly Task[];
  /** By session id: what Walnut's record says. */
  sessions: ReadonlyMap<string, { engine?: SessionEngine; startedAt?: string; model?: string; cliModel?: string; acpModel?: string;
    process_status?: string; status_history?: { process_status?: string }[]; errorCount?: number }>;
  spend: ReadonlyMap<string, TaskSpend>;
  followUps: (taskId: string) => number;
  range: { start?: string; end?: string };
  project?: string;
  /** Count only tasks the engine split assigned (a fair test: no engine was picked by hand); 'auto' decides. */
  splitOnly?: boolean | 'auto';
  config?: { defaults?: { engine_split?: unknown } } | null;
  /** YYYY-MM-DD of an ISO time in the report's time zone. */
  dayOf: (iso: string) => string;
}

/** Nothing of it is known: no spend, or every request it made has no token counts. */
function usageUnknown(spend: TaskSpend | undefined): boolean {
  return !spend || (spend.unknown > 0 && spend.tokens === 0 && spend.costUsd === 0);
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

/** The earliest start among every session the task held. */
function firstStart(t: Task, sessions: CompareInput['sessions']): string | undefined {
  let first: string | undefined;
  for (const id of sessionsOf(t)) {
    const at = sessions.get(id)?.startedAt;
    if (at && (!first || at < first)) first = at;
  }
  return first;
}

function inRange(day: string, range: { start?: string; end?: string }): boolean {
  return (!range.start || day >= range.start) && (!range.end || day <= range.end);
}

/** The comparison, from tasks, their sessions and their spend. Pure. */
export function aggregateEngineCompare(input: CompareInput): EngineCompare {
  const reviewsOf = new Map<string, number>();
  const reviewCostOf = new Map<string, number>();
  const reviewPartial = new Set<string>();
  for (const t of input.tasks) {
    if (!t.parent_task_id || !REVIEW_RE.test(t.title)) continue;
    const spend = input.spend.get(t.id);
    reviewsOf.set(t.parent_task_id, (reviewsOf.get(t.parent_task_id) ?? 0) + 1);
    reviewCostOf.set(t.parent_task_id, (reviewCostOf.get(t.parent_task_id) ?? 0) + (spend?.costUsd ?? 0));
    if (!spend || spend.unpriced > 0 || spend.unknown > 0) reviewPartial.add(t.parent_task_id);
  }
  type Group = { key: string; engine: string; family: ModelFamily };
  type Candidate = EngineCompareTask & { finishedAt: string; byCost: Group; byPick: Group | null };
  const candidates: Candidate[] = [];
  for (const t of input.tasks) {
    // A reviewer subtask counts toward its parent; a top-level task titled "Review ..." is work of its own.
    if (!counted(t) || (t.parent_task_id && REVIEW_RE.test(t.title))) continue;
    const sid = taskSessionId(t);
    const session = sid ? input.sessions.get(sid) : undefined;
    const done = t.phase === 'COMPLETE' && !!t.completed_at;
    // From its first session's start (a restart, an engine switch or a recovery starts another)
    // to its first completion (a reopen adds the idle time before it otherwise).
    // No session start known (an old task whose records are gone): no time, rather than its age.
    const sessionStart = firstStart(t, input.sessions) ?? t.engine_pick?.at;
    const startedAt = sessionStart ?? t.created_at;
    const finishedAt = t.first_completed_at && t.completed_at && t.first_completed_at < t.completed_at ? t.first_completed_at : t.completed_at;
    const day = input.dayOf(done ? t.completed_at! : startedAt);
    if (!inRange(day, input.range)) continue;
    const spend = input.spend.get(t.id);
    const engine = resolveEngine(spend?.engine ?? session?.engine ?? t.engine_pick?.engine ?? t.last_start?.engine);
    const family = modelFamily(spend?.model) ?? modelFamily(session?.acpModel ?? session?.cliModel ?? session?.model)
      ?? modelFamily(t.engine_pick?.model) ?? ENGINE_FAMILY[engine] ?? 'Other';
    const byCost: Group = { key: `${engine}|${family}`, engine, family };
    // Where the split put it: the fair test keeps a task in that column even when it was rescued elsewhere.
    let byPick: Group | null = null;
    if (t.engine_pick) {
      const pe = resolveEngine(t.engine_pick.engine);
      // Fixed at assignment: the model the entry names, else the engine's own default family, never
      // read back from where the cost went (a task moved to another model in the same engine is a move).
      const pf = modelFamily(t.engine_pick.model) ?? ENGINE_FAMILY[pe] ?? (pe === engine ? family : 'Other');
      byPick = { key: `${pe}|${pf}`, engine: pe, family: pf };
    }
    const hours = done && sessionStart ? (Date.parse(finishedAt!) - Date.parse(sessionStart)) / 3600_000 : null;
    // Any session it held: a task that failed on one engine and finished on another still had the error.
    const errored = sessionsOf(t).some((id) => {
      const s = input.sessions.get(id);
      return s?.process_status === 'error' || (s?.errorCount ?? 0) > 0 || !!s?.status_history?.some((h) => h.process_status === 'error');
    }) || t.last_start?.state === 'failed';
    candidates.push({
      byCost, byPick, taskId: t.id, title: t.title, project: t.project ?? '', key: byCost.key, done,
      hours: hours !== null && Number.isFinite(hours) && hours >= 0 ? hours : null,
      costUsd: spend?.costUsd ?? 0, partialCost: !spend || spend.unpriced > 0 || spend.unknown > 0, noUsage: usageUnknown(spend),
      partialTokens: !spend || spend.unknown > 0, tokens: spend?.tokens ?? 0, reviews: reviewsOf.get(t.id) ?? 0, reviewCostUsd: reviewCostOf.get(t.id) ?? 0, reviewPartialCost: reviewPartial.has(t.id),
      followUps: input.followUps(t.id), reopens: t.reopens ?? 0, errored, split: !!t.engine_pick,
      switched: !!byPick && byPick.key !== byCost.key, finishedAt: done ? t.completed_at! : '',
    });
  }
  // Named like the columns ("Claude Code · GPT"), with the model an entry names.
  const entries = splitBuilders(input.config).map((b) => {
    const fam = modelFamily(b.model) ?? ENGINE_FAMILY[resolveEngine(b.engine)] ?? 'Other';
    return { key: b.key, label: `${builderLabel({ engine: b.engine })} · ${fam}${b.model ? ` (${b.model})` : ''}`, weight: b.weight };
  });
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
  const rows: EngineCompareRow[] = [];
  for (const [key, { engine, family }] of meta) {
    const all = picked.filter((p) => p.key === key);
    const done = all.filter((p) => p.done);
    const known = done.filter((p) => !p.noUsage);
    const per = (f: (p: EngineCompareTask) => number) => done.length ? done.reduce((a, p) => a + f(p), 0) / done.length : null;
    rows.push({
      key, engine, family, label: `${builderLabel({ engine: engine as SessionEngine })} · ${family}`,
      done: done.length, open: all.length - done.length, split: all.filter((p) => p.split).length,
      medianHours: median(done.map((p) => p.hours).filter((h): h is number => h !== null)),
      costUsd: all.reduce((a, p) => a + p.costUsd, 0), partialCost: all.filter((p) => p.partialCost).length,
      // Under the column the split assigned, in either view.
      noUsage: all.filter((p) => p.noUsage).length, partialTokens: all.filter((p) => p.partialTokens).length, switched: picked.filter((p) => p.switched && p.byPick?.key === key).length,
      // Medians of the tasks whose usage is known: an unknown is not a zero (none known reads "-").
      medianCostUsd: median(known.map((p) => p.costUsd)),
      tokens: all.reduce((a, p) => a + p.tokens, 0), medianTokens: median(known.map((p) => p.tokens)),
      reviewsPerTask: per((p) => p.reviews), reviewCostPerTask: per((p) => p.reviewCostUsd), reviewPartialCost: all.filter((p) => p.reviewPartialCost).length, followUpsPerTask: per((p) => p.followUps),
      reopens: all.reduce((a, p) => a + p.reopens, 0), errored: all.filter((p) => p.errored).length,
      reopenedShare: per((p) => (p.reopens > 0 ? 1 : 0)),
      erroredShare: all.length ? all.filter((p) => p.errored).length / all.length : null,
    });
  }
  rows.sort((a, b) => b.done - a.done || b.open - a.open || a.label.localeCompare(b.label));
  const tasks = [...picked]
    .sort((a, b) => Number(b.done) - Number(a.done) || b.finishedAt.localeCompare(a.finishedAt))
    .slice(0, TASKS_MAX)
    .map(({ finishedAt: _f, byCost: _c, byPick: _p, group: _g, ...t }) => t);
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
  const out = new Map<string, TaskSpend & { top: number }>();
  const weightOf = new Map<string, number>();
  for (const r of rollup.query({ sources: ['session'], by: ['engine', 'session', 'task'] })) {
    const taskId = (r.taskId as string | null) ?? sessionTask(r.sessionId as string);
    if (!taskId) continue;
    const p = pricer.price(r.model, r.band, { ...r, requests: r.calls });
    const tokens = p.input + p.output + p.cacheRead + p.cacheWrite5m + p.cacheWrite1h;
    const acc = out.get(taskId) ?? { costUsd: 0, tokens: 0, outputTokens: 0, unpriced: 0, unknown: 0, engine: r.engine, model: r.model, top: -1 };
    acc.costUsd += p.costUsd; acc.tokens += tokens; acc.outputTokens += p.output; acc.unpriced += p.unpriced;
    acc.unknown += Number(r.unknown) || 0;
    // The engine and model family that carried most of it, summed the way the columns are (Opus and
    // Sonnet are one Claude column): cost first, tokens break the tie for unpriced rows.
    const wk = `${taskId}\u0000${r.engine}\u0000${modelFamily(r.model) ?? 'Other'}`;
    const w = (weightOf.get(wk) ?? 0) + p.costUsd * 1e9 + tokens;
    weightOf.set(wk, w);
    if (w > acc.top) { acc.top = w; acc.engine = r.engine; acc.model = r.model; }
    out.set(taskId, acc);
  }
  return new Map([...out].map(([id, { top: _top, ...s }]) => [id, s]));
}
