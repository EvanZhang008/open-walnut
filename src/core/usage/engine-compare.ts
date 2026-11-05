/**
 * Engines compared on finished work (Usage & Costs, "Engines compared"): for each coding
 * engine and the company whose model it ran, the tasks it finished in a period, how long
 * they took, what they cost, how many review subtasks they needed, and how much rework
 * followed (the user's own messages into the task, reopens after completion, errors).
 *
 * A task belongs to the engine and model family that carried most of its spend (a task
 * that switched engines counts where its money went), else to its session's engine. Counted:
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
  tokens: number;
  reviews: number;
  followUps: number;
  reopens: number;
  errored: boolean;
  /** The engine split chose its engine. */
  split: boolean;
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
  medianCostUsd: number | null;
  tokens: number;
  medianTokens: number | null;
  /** Review subtasks per finished task. */
  reviewsPerTask: number | null;
  /** The user's messages per finished task. */
  followUpsPerTask: number | null;
  reopens: number;
  errored: number;
}

export interface EngineCompare {
  range: { start: string | null; end: string | null };
  rows: EngineCompareRow[];
  /** The tasks behind the rows, newest finished first, at most TASKS_MAX. */
  tasks: EngineCompareTask[];
  projects: { project: string; tasks: number }[];
  split: { on: boolean; entries: { key: string; label: string; weight: number }[] };
}

export const TASKS_MAX = 60;
const REVIEW_RE = /\breview/i;

export interface CompareInput {
  tasks: readonly Task[];
  /** By session id: what Walnut's record says. */
  sessions: ReadonlyMap<string, { engine?: SessionEngine; startedAt?: string; model?: string; cliModel?: string; acpModel?: string;
    process_status?: string; status_history?: { process_status?: string }[] }>;
  spend: ReadonlyMap<string, TaskSpend>;
  followUps: (taskId: string) => number;
  range: { start?: string; end?: string };
  project?: string;
  config?: { defaults?: { engine_split?: unknown } } | null;
  /** YYYY-MM-DD of an ISO time in the report's time zone. */
  dayOf: (iso: string) => string;
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
  if (!taskSessionId(t) || t.org_role || t.walnut_agent || t.routine_start || t.plugin_only) return false;
  return !/^ask /i.test((t.project ?? '').trim());
}

function inRange(day: string, range: { start?: string; end?: string }): boolean {
  return (!range.start || day >= range.start) && (!range.end || day <= range.end);
}

/** The comparison, from tasks, their sessions and their spend. Pure. */
export function aggregateEngineCompare(input: CompareInput): EngineCompare {
  const reviewsOf = new Map<string, number>();
  for (const t of input.tasks) {
    if (t.parent_task_id && REVIEW_RE.test(t.title)) reviewsOf.set(t.parent_task_id, (reviewsOf.get(t.parent_task_id) ?? 0) + 1);
  }
  const projects = new Map<string, number>();
  const picked: (EngineCompareTask & { finishedAt: string })[] = [];
  const meta = new Map<string, { engine: string; family: ModelFamily }>();
  for (const t of input.tasks) {
    if (!counted(t) || REVIEW_RE.test(t.title)) continue;
    const session = input.sessions.get(taskSessionId(t)!);
    const done = t.phase === 'COMPLETE' && !!t.completed_at;
    const startedAt = session?.startedAt ?? t.created_at;
    const day = input.dayOf(done ? t.completed_at! : startedAt);
    if (!inRange(day, input.range)) continue;
    projects.set(t.project ?? '', (projects.get(t.project ?? '') ?? 0) + 1);
    if (input.project !== undefined && (t.project ?? '') !== input.project) continue;
    const spend = input.spend.get(t.id);
    const engine = resolveEngine(spend?.engine ?? session?.engine ?? t.engine_pick?.engine);
    const family = modelFamily(spend?.model) ?? modelFamily(session?.acpModel ?? session?.cliModel ?? session?.model)
      ?? modelFamily(t.engine_pick?.model) ?? (engine === resolveEngine(undefined) ? 'Claude' : 'Other');
    const key = `${engine}|${family}`;
    meta.set(key, { engine, family });
    const hours = done ? (Date.parse(t.completed_at!) - Date.parse(startedAt)) / 3600_000 : null;
    const errored = session?.process_status === 'error' || !!session?.status_history?.some((h) => h.process_status === 'error')
      || t.last_start?.state === 'failed';
    picked.push({
      taskId: t.id, title: t.title, project: t.project ?? '', key, done,
      hours: hours !== null && Number.isFinite(hours) && hours >= 0 ? hours : null,
      costUsd: spend?.costUsd ?? 0, tokens: spend?.tokens ?? 0, reviews: reviewsOf.get(t.id) ?? 0,
      followUps: input.followUps(t.id), reopens: t.reopens ?? 0, errored, split: !!t.engine_pick,
      finishedAt: done ? t.completed_at! : '',
    });
  }
  const rows: EngineCompareRow[] = [];
  for (const [key, { engine, family }] of meta) {
    const all = picked.filter((p) => p.key === key);
    const done = all.filter((p) => p.done);
    const per = (f: (p: EngineCompareTask) => number) => done.length ? done.reduce((a, p) => a + f(p), 0) / done.length : null;
    rows.push({
      key, engine, family, label: `${builderLabel({ engine: engine as SessionEngine })} · ${family}`,
      done: done.length, open: all.length - done.length, split: all.filter((p) => p.split).length,
      medianHours: median(done.map((p) => p.hours).filter((h): h is number => h !== null)),
      costUsd: all.reduce((a, p) => a + p.costUsd, 0), medianCostUsd: median(done.map((p) => p.costUsd)),
      tokens: all.reduce((a, p) => a + p.tokens, 0), medianTokens: median(done.map((p) => p.tokens)),
      reviewsPerTask: per((p) => p.reviews), followUpsPerTask: per((p) => p.followUps),
      reopens: all.reduce((a, p) => a + p.reopens, 0), errored: all.filter((p) => p.errored).length,
    });
  }
  rows.sort((a, b) => b.done - a.done || b.open - a.open || a.label.localeCompare(b.label));
  const tasks = [...picked]
    .sort((a, b) => Number(b.done) - Number(a.done) || b.finishedAt.localeCompare(a.finishedAt))
    .slice(0, TASKS_MAX)
    .map(({ finishedAt: _f, ...t }) => t);
  const entries = splitBuilders(input.config).map((b) => ({ key: b.key, label: builderLabel(b), weight: b.weight }));
  return {
    range: { start: input.range.start ?? null, end: input.range.end ?? null }, rows, tasks,
    projects: [...projects].sort((a, b) => b[1] - a[1]).map(([project, n]) => ({ project, tasks: n })),
    split: { on: entries.length >= 2, entries },
  };
}

/**
 * Every task's whole spend (all time: a task finished this week may have started last month),
 * priced the way the Usage & Costs page prices it, with the engine and model that carried most of it.
 */
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
    const acc = out.get(taskId) ?? { costUsd: 0, tokens: 0, outputTokens: 0, engine: r.engine, model: r.model, top: -1 };
    acc.costUsd += p.costUsd; acc.tokens += tokens; acc.outputTokens += p.output;
    // The engine and model that carried most of it: cost first, tokens break the tie for unpriced rows.
    const wk = `${taskId}\u0000${r.engine}\u0000${r.model}`;
    const w = (weightOf.get(wk) ?? 0) + p.costUsd * 1e9 + tokens;
    weightOf.set(wk, w);
    if (w > acc.top) { acc.top = w; acc.engine = r.engine; acc.model = r.model; }
    out.set(taskId, acc);
  }
  return new Map([...out].map(([id, { top: _top, ...s }]) => [id, s]));
}
