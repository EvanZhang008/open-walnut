/**
 * Project summary generator — a 1-3 sentence, fast-model description of what
 * each project is about, built up as the project accumulates tasks.
 *
 * WHY: project auto-placement (quick-task parse, session-organize) judges by a
 * handful of raw recent task titles. Titles are noisy; a concise standing
 * summary of "what lives in this project" makes those picks much better, and
 * gives the project drill-in UI something to show.
 *
 * TRIGGER: task:created bus events (see startProjectSummaryMaintainer), NOT
 * cron. Regeneration fires when the project's task count has CROSSED a
 * threshold — 1, 2, 4, 8, 20, then every 20 — since the last stored
 * generation, so young projects converge fast, mature ones refresh cheaply,
 * and a failed generation self-heals on the next create instead of waiting
 * for the count to land exactly on a threshold again. Sync/bulk sources are
 * not dropped (that left every synced project permanently undescribed) but
 * debounced per project: a 300-task import is one generation, after the
 * burst goes quiet. A startup catch-up sweep heals whatever both paths
 * missed while the server was down.
 *
 * ALWAYS full regeneration from the current task list (+ the previous summary
 * as context). NEVER append — append-style summaries grow stale clauses
 * forever; a regenerate stays exactly as long as the prompt allows.
 *
 * STORAGE: the `task_projects` registry metadata (setProjectMetadata) under two
 * keys:
 *   summary            — the generated text
 *   summary_task_count — task count at generation time (threshold bookkeeping)
 * Inbox ('' project) never gets a summary — it has no registry row and is by
 * definition the unfiled pile, not a stream of work worth describing.
 */

import { sendMessage } from '../model/model.js';
import { bus, EventNames, type BusEvent } from './event-bus.js';
import { log } from '../logging/index.js';
import { fastModelFor, fastModelRidesCli, directFastRoute, backgroundAiDisabled } from './cheap-model.js';
import type { Task } from './types.js';

const SUBSCRIBER = 'project-summary';
/** Bulk importers storm task:created — debounce these per project, never
 *  refresh per event (a reconcile can emit hundreds in one loop). */
const BULK_SOURCE = /sync|reconcile|migration|plugin/i;
/** Quiet period after the last bulk create before one refresh runs.
 *  Read per call so tests can shrink it and drive the REAL timer path. */
function syncDebounceMs(): number {
  const env = Number(process.env.WALNUT_SUMMARY_SYNC_DEBOUNCE_MS);
  return Number.isFinite(env) && env > 0 ? env : 60_000;
}
/** Startup catch-up runs after boot settles; heals whatever event-driven
 *  refreshes missed (server down, failed generations, pre-mechanism projects). */
const CATCHUP_DELAY_MS = 120_000;
/** Regenerate when the open+done task count reaches these; then every STEP. */
const THRESHOLDS = [1, 2, 4, 8, 20];
const STEP = 20;
const MAX_TASKS_IN_PROMPT = 30;

let queueTail: Promise<void> = Promise.resolve();
const pendingSync = new Map<string, ReturnType<typeof setTimeout>>();
let catchUpTimer: ReturnType<typeof setTimeout> | undefined;

export function __resetProjectSummaryState(): void {
  queueTail = Promise.resolve();
  for (const timer of pendingSync.values()) clearTimeout(timer);
  pendingSync.clear();
  if (catchUpTimer) { clearTimeout(catchUpTimer); catchUpTimer = undefined; }
}

/**
 * True when any threshold (1, 2, 4, 8, 20, then every 20) lies in
 * (lastCount, count]. Crossing — not exact-hit — is the load-bearing choice:
 * a bulk import that jumps 0 → 300 crossed plenty of thresholds even though
 * 300 lands on none of the small ones, and a generation that failed at 20
 * retries at 21 instead of waiting for 40.
 */
export function hasCrossedThreshold(lastCount: number, count: number): boolean {
  if (count <= lastCount) return false;
  if (THRESHOLDS.some((t) => t > lastCount && t <= count)) return true;
  const top = THRESHOLDS[THRESHOLDS.length - 1];
  return Math.floor(count / STEP) > Math.floor(Math.max(lastCount, top) / STEP);
}

const SYSTEM_PROMPT = `You maintain a one-line description of a project (a task list). Reply with ONLY a JSON object — no markdown fence, no commentary.
Field:
- summary: 2-3 short sentences. The FIRST sentence must stand alone as "what this project is" — downstream prompts truncate to it, so it alone must let someone decide "does a new task belong here?". The following sentence(s) describe the current focus. Plain statements, no fluff, no task-by-task recap. Preserve whatever is still true from the previous summary; drop what the task list no longer supports. Match the dominant language of the task titles.`;

export interface ProjectSummaryResult {
  summary: string;
  taskCount: number;
}

/** The slice of a task the summary prompt consumes — satisfied by both Task
 *  and SlimTask, so callers can prefetch with the lighter projection. */
export interface SummaryTaskLike {
  title: string;
  project?: string;
  parent_task_id?: string;
  phase?: string;
  created_at?: string;
  summary?: string;
  description?: string;
}

/** The one definition of "which tasks count for this project's summary". */
function projectSummaryTasks<T extends SummaryTaskLike>(all: readonly T[], project: string): T[] {
  const key = project.toLowerCase();
  return all.filter((t) =>
    (t.project ?? '').toLowerCase() === key
    && !t.title.startsWith('.metadata')
    && !t.parent_task_id);
}

/**
 * Regenerate the summary for one project from its live task list.
 * Returns null for Inbox or when the model produced nothing usable. Never throws.
 */
export async function generateProjectSummary(
  project: string,
  opts: { timeoutMs?: number; modelOverride?: string; tasks?: readonly SummaryTaskLike[] } = {},
): Promise<ProjectSummaryResult | null> {
  const name = (project ?? '').trim();
  if (!name) return null; // Inbox
  try {
    const { listTasksSlim, getProjectMetadata } = await import('./task-manager.js');
    // Case-insensitive match: project identity is NOCASE, and a caller may pass
    // a user-typed spelling (manual rebuild route) rather than the canonical one.
    // Callers that already hold the project's tasks (the gate, the catch-up
    // sweep) pass them in so one refresh never reads the store twice.
    const tasks = opts.tasks ?? projectSummaryTasks(await listTasksSlim({}), name);
    if (!tasks.length) return null;
    const taskCount = tasks.length;

    const meta = await getProjectMetadata(name);
    const previous = typeof meta?.summary === 'string' ? meta.summary.trim() : '';

    // Newest first; completed tasks carry their (derived) summary when present.
    // description is OPTIONAL context: it fills in gradually as tasks are
    // worked, so its absence must never gate or degrade generation.
    const lines = [...tasks]
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
      .slice(0, MAX_TASKS_IN_PROMPT)
      .map((t) => {
        const bits = [`- [${t.phase === 'COMPLETE' ? 'done' : 'open'}] ${t.title}`];
        const detail = (t.summary?.trim() || t.description?.trim() || '').slice(0, 150);
        if (detail) bits.push(`  ${detail}`);
        return bits.join('\n');
      });

    // Route: a claude_cli main provider would make sendMessage spawn a whole
    // `claude -p` for this 256-token background call (~5s before any prompt;
    // it blew the 15s budget often enough that most projects had no summary).
    // Prefer a configured direct-API haiku, keeping the CLI as the fallback so
    // CLI-only setups lose nothing.
    let model = opts.modelOverride;
    let provider: string | undefined;
    let cliFallbackModel: string | undefined;
    if (!model) {
      const { getConfig } = await import('./config-manager.js');
      const config = await getConfig();
      const direct = fastModelRidesCli(config) ? directFastRoute(config) : undefined;
      if (direct) {
        provider = direct.provider;
        model = direct.model;
        cliFallbackModel = fastModelFor(config);
      } else {
        model = fastModelFor(config);
      }
    }

    const content = [
      `Project: "${name}" (${taskCount} tasks)`,
      ...(previous ? ['', `Previous summary:\n${previous}`] : []),
      '',
      `Tasks (newest first${taskCount > MAX_TASKS_IN_PROMPT ? `, showing ${MAX_TASKS_IN_PROMPT}` : ''}):`,
      ...lines,
    ].join('\n');

    const attempt = async (prov: string | undefined, mdl: string | undefined) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
      try {
        // Small maxTokens: Haiku's 64K catalog default trips the SDK's
        // "streaming required" guard on the non-streaming path.
        return await sendMessage({
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content }],
          config: { maxTokens: 256, ...(prov ? { provider: prov } : {}), ...(mdl ? { model: mdl } : {}) },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let result;
    try {
      result = await attempt(provider, model);
    } catch (err) {
      // Direct route unavailable (no creds, network) → the CLI path is still
      // a real answer for CLI-only setups; give it its own full budget.
      if (!provider) throw err;
      log.web.debug('project-summary: direct route failed, retrying via main provider', {
        project: name, provider, errorKind: err instanceof Error ? err.name : typeof err,
      });
      result = await attempt(undefined, cliFallbackModel);
    }

    const text = (result.content ?? [])
      .map((b) => (b.type === 'text' && 'text' in b ? (b as { text: string }).text : ''))
      .join('')
      .trim();
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const parsed: unknown = JSON.parse((fence?.[1] ?? text).trim());
    const summary = parsed && typeof parsed === 'object' && typeof (parsed as { summary?: unknown }).summary === 'string'
      ? (parsed as { summary: string }).summary.trim().slice(0, 600)
      : '';
    if (!summary) return null;
    return { summary, taskCount };
  } catch (err) {
    log.web.debug('generateProjectSummary failed', {
      project: name,
      errorKind: err instanceof Error ? err.name : typeof err,
    });
    return null;
  }
}

/** Generate + persist into the project registry. For the rebuild route + tests. */
export async function refreshProjectSummary(
  project: string,
  opts: { tasks?: readonly SummaryTaskLike[] } = {},
): Promise<boolean> {
  const name = (project ?? '').trim();
  if (!name) return false;
  const generated = await generateProjectSummary(name, { tasks: opts.tasks });
  if (!generated) return false;
  const { setProjectMetadata } = await import('./task-manager.js');
  await setProjectMetadata(name, {
    summary: generated.summary,
    summary_task_count: generated.taskCount,
  });
  log.web.info('project-summary: refreshed', {
    project: name, taskCount: generated.taskCount,
  });
  return true;
}

/**
 * The shared gate: count the project's tasks; regenerate only when a
 * threshold was CROSSED since the last stored generation (summary_task_count).
 * Serialized through one queue so bursts never fan out N model calls.
 * Every path funnels here — live creates, the sync debounce, the catch-up.
 */
async function gateAndRefresh(project: string, context: string): Promise<boolean> {
  const prior = queueTail;
  let done!: () => void;
  queueTail = new Promise<void>((resolve) => { done = resolve; });
  await prior;

  try {
    const { listTasksSlim, getProjectMetadata } = await import('./task-manager.js');
    const tasks = projectSummaryTasks(await listTasksSlim({}), project);

    const meta = await getProjectMetadata(project);
    const lastCount = typeof meta?.summary_task_count === 'number' ? meta.summary_task_count : 0;
    // A project whose summary vanished (metadata edited, registry rebuilt)
    // regenerates from zero even though summary_task_count survived.
    const hasSummary = typeof meta?.summary === 'string' && meta.summary.trim().length > 0;
    if (!hasCrossedThreshold(hasSummary ? lastCount : 0, tasks.length)) return false;

    return await refreshProjectSummary(project, { tasks });
  } catch (err) {
    log.web.warn('project-summary: refresh check failed', {
      project, context, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    done();
  }
}

/**
 * task:created gate. Bulk sources (sync reconcilers, migrations, plugins) are
 * DEBOUNCED per project, not dropped: dropping them left every synced project
 * permanently undescribed — the digest's "about:" line never existed for
 * exactly the projects with the most tasks. One timer per project, pushed out
 * by each event in the burst; the refresh runs once, after the import goes
 * quiet, against the final count.
 */
export async function maybeRefreshForTask(task: Task | undefined, source: string): Promise<boolean> {
  if (!task?.id) return false;
  if (task.parent_task_id) return false;
  if (task.title.startsWith('.metadata')) return false;
  // Inbox is the unfiled pile, not a stream of work — a summary of "whatever is
  // passing through" would be noise and a wasted model call per capture.
  const project = (task.project ?? '').trim();
  if (!project) return false;

  if (BULK_SOURCE.test(source)) {
    const key = project.toLowerCase();
    const existing = pendingSync.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pendingSync.delete(key);
      void gateAndRefresh(project, 'sync-debounce').catch(() => {});
    }, syncDebounceMs());
    timer.unref?.();
    pendingSync.set(key, timer);
    return false; // nothing refreshed yet — the debounced run reports its own result
  }

  return gateAndRefresh(project, `task:${task.id}`);
}

/**
 * Startup catch-up: sweep every registered project through the same crossing
 * gate. Heals what event-driven refreshes structurally miss — projects
 * imported while this feature didn't exist, generations that failed and saw
 * no further creates, servers that were down during a sync. Runs its own
 * serial loop rather than the event queue (a minutes-long sweep must not
 * block live gates); racing a live refresh for the same project is harmless —
 * both write the same regenerated state.
 */
export async function runSummaryCatchUp(): Promise<number> {
  const { getStoreProjects, getProjectMetadata, listTasksSlim } = await import('./task-manager.js');
  const projects = Object.keys(await getStoreProjects());
  // ONE store read for the whole sweep — per-project gateAndRefresh calls
  // would re-materialize the full task list once per registry project.
  const all = await listTasksSlim({});
  let refreshed = 0;
  let consecutiveFailures = 0;
  for (const name of projects) {
    try {
      const tasks = projectSummaryTasks(all, name);
      const meta = await getProjectMetadata(name);
      const lastCount = typeof meta?.summary_task_count === 'number' ? meta.summary_task_count : 0;
      const hasSummary = typeof meta?.summary === 'string' && meta.summary.trim().length > 0;
      if (!hasCrossedThreshold(hasSummary ? lastCount : 0, tasks.length)) continue;

      if (await refreshProjectSummary(name, { tasks })) {
        refreshed += 1;
        consecutiveFailures = 0;
      } else {
        // The gate passed, so a false here means generation itself failed.
        // Three in a row reads as "the model route is down" — stop burning a
        // timeout per remaining project; the next boot retries the rest.
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          log.web.warn('project-summary: catch-up aborted after consecutive failures', {
            refreshed, scanned: projects.length,
          });
          return refreshed;
        }
      }
    } catch (err) {
      log.web.warn('project-summary: catch-up project failed', {
        project: name, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (refreshed > 0) {
    log.web.info('project-summary: catch-up refreshed projects', {
      refreshed, scanned: projects.length,
    });
  }
  return refreshed;
}

/** Subscribe to task creation. Call once at server startup. */
export function startProjectSummaryMaintainer(): void {
  // Test servers must not fire unprompted model calls on every task create
  // (real ~/.aws → live Bedrock; see backgroundAiDisabled). Tests exercise
  // maybeRefreshForTask/refreshProjectSummary directly with sendMessage mocked.
  if (backgroundAiDisabled()) {
    log.web.info('project-summary: maintainer disabled (test env / WALNUT_DISABLE_BACKGROUND_AI)');
    return;
  }
  bus.subscribe(SUBSCRIBER, (event: BusEvent) => {
    if (event.name !== EventNames.TASK_CREATED) return;
    const task = (event.data as { task?: Task } | undefined)?.task;
    void maybeRefreshForTask(task, event.source).catch((err) => {
      log.web.warn('project-summary: handler error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, { global: true, interest: ['task:created'] });
  catchUpTimer = setTimeout(() => {
    catchUpTimer = undefined;
    void runSummaryCatchUp().catch((err) => {
      log.web.warn('project-summary: catch-up failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, CATCHUP_DELAY_MS);
  catchUpTimer.unref?.();
  log.web.info('project-summary: maintainer started');
}

export function stopProjectSummaryMaintainer(): void {
  bus.unsubscribe(SUBSCRIBER);
  __resetProjectSummaryState();
}
