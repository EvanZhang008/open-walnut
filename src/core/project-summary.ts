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
 * cron. Regeneration fires only when the project's task count crosses a
 * threshold — 1, 2, 4, 8, 20, then every 20 — so young projects converge fast
 * and mature ones refresh cheaply.
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

import { sendMessage } from '../agent/model.js';
import { bus, EventNames, type BusEvent } from './event-bus.js';
import { log } from '../logging/index.js';
import { fastModelFor, backgroundAiDisabled } from './cheap-model.js';
import type { Task } from './types.js';

const SUBSCRIBER = 'project-summary';
/** Bulk importers storm task:created — never real "the user added work" events. */
const SKIP_SOURCE = /sync|reconcile|migration|plugin/i;
/** Regenerate when the open+done task count reaches these; then every STEP. */
const THRESHOLDS = [1, 2, 4, 8, 20];
const STEP = 20;
const MAX_TASKS_IN_PROMPT = 30;

let queueTail: Promise<void> = Promise.resolve();

export function __resetProjectSummaryState(): void {
  queueTail = Promise.resolve();
}

/** Threshold check: exact hit below 20, then every 20th task. */
export function isSummaryThreshold(count: number): boolean {
  if (count <= 0) return false;
  if (count <= THRESHOLDS[THRESHOLDS.length - 1]) return THRESHOLDS.includes(count);
  return count % STEP === 0;
}

const SYSTEM_PROMPT = `You maintain a one-line description of a project (a task list). Reply with ONLY a JSON object — no markdown fence, no commentary.
Field:
- summary: 1-3 short sentences describing what this project is about and its current focus, written so someone deciding "does a new task belong here?" can judge instantly. Plain statements, no fluff, no task-by-task recap. Preserve whatever is still true from the previous summary; drop what the task list no longer supports. Match the dominant language of the task titles.`;

export interface ProjectSummaryResult {
  summary: string;
  taskCount: number;
}

/**
 * Regenerate the summary for one project from its live task list.
 * Returns null for Inbox or when the model produced nothing usable. Never throws.
 */
export async function generateProjectSummary(
  project: string,
  opts: { timeoutMs?: number; modelOverride?: string } = {},
): Promise<ProjectSummaryResult | null> {
  const name = (project ?? '').trim();
  if (!name) return null; // Inbox
  try {
    const { listTasks, getProjectMetadata } = await import('./task-manager.js');
    // Case-insensitive match: project identity is NOCASE, and a caller may pass
    // a user-typed spelling (manual rebuild route) rather than the canonical one.
    const all = await listTasks();
    const tasks = all.filter((t) =>
      (t.project ?? '').toLowerCase() === name.toLowerCase()
      && !t.title.startsWith('.metadata')
      && !t.parent_task_id);
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

    let model = opts.modelOverride;
    if (!model) {
      const { getConfig } = await import('./config-manager.js');
      model = fastModelFor(await getConfig());
    }

    const content = [
      `Project: "${name}" (${taskCount} tasks)`,
      ...(previous ? ['', `Previous summary:\n${previous}`] : []),
      '',
      `Tasks (newest first${taskCount > MAX_TASKS_IN_PROMPT ? `, showing ${MAX_TASKS_IN_PROMPT}` : ''}):`,
      ...lines,
    ].join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
    let result;
    try {
      // Small maxTokens: Haiku's 64K catalog default trips the SDK's
      // "streaming required" guard on the non-streaming path.
      result = await sendMessage({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        config: { maxTokens: 256, ...(model ? { model } : {}) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
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
export async function refreshProjectSummary(project: string): Promise<boolean> {
  const name = (project ?? '').trim();
  if (!name) return false;
  const generated = await generateProjectSummary(name);
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
 * task:created gate: count the project's tasks; regenerate only on a
 * threshold crossing SINCE the last stored generation (summary_task_count),
 * so a burst of creates between thresholds can't double-fire and a stale
 * stored count self-heals on the next crossing.
 */
export async function maybeRefreshForTask(task: Task | undefined, source: string): Promise<boolean> {
  if (!task?.id) return false;
  if (task.parent_task_id) return false;
  if (task.title.startsWith('.metadata')) return false;
  if (SKIP_SOURCE.test(source)) return false;
  // Inbox is the unfiled pile, not a stream of work — a summary of "whatever is
  // passing through" would be noise and a wasted model call per capture.
  const project = (task.project ?? '').trim();
  if (!project) return false;

  // Serialize model runs — bursts of task creates must not fan out N calls.
  const prior = queueTail;
  let done!: () => void;
  queueTail = new Promise<void>((resolve) => { done = resolve; });
  await prior;

  try {
    const { listTasks, getProjectMetadata } = await import('./task-manager.js');
    const all = await listTasks();
    const count = all.filter((t) =>
      (t.project ?? '').toLowerCase() === project.toLowerCase()
      && !t.title.startsWith('.metadata')
      && !t.parent_task_id).length;
    if (!isSummaryThreshold(count)) return false;

    const meta = await getProjectMetadata(project);
    const lastCount = typeof meta?.summary_task_count === 'number' ? meta.summary_task_count : 0;
    if (count <= lastCount) return false; // already summarized at/past this size

    return await refreshProjectSummary(project);
  } catch (err) {
    log.web.warn('project-summary: refresh check failed', {
      taskId: task.id, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    done();
  }
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
  log.web.info('project-summary: maintainer started');
}

export function stopProjectSummaryMaintainer(): void {
  bus.unsubscribe(SUBSCRIBER);
  __resetProjectSummaryState();
}
