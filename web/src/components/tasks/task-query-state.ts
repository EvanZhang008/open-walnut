/**
 * Shared glue around the canonical task query, used by BOTH console surfaces:
 * the home panel (TodoPanel) and /tasks (DashboardPage).
 *
 * The value of one shared query model (src/core/task-query.ts) is that the two
 * surfaces cannot disagree about what "source = local, updated in the last 24h"
 * means. The derivations AROUND the evaluator have to live in one place for the
 * same reason: a second copy of the option lists, the blocked-set pass, or the
 * error fallback is exactly how the surfaces start drifting again.
 *
 * Presentation state (each surface's own sort/group/collapse) deliberately does
 * NOT live here — only what feeds the shared predicate.
 */
import type { Task } from '@open-walnut/core';
import {
  computeBlockedIds,
  normalizeTaskQuery,
  type NormalizedTaskQuery,
  type TaskQuery,
  type TaskQueryContext,
} from '@open-walnut/task-query';
import { log } from '@/utils/log';

/** Distinct non-empty `source` values across the loaded tasks, sorted. */
export function deriveSourceOptions(tasks: readonly Task[]): string[] {
  return [...new Set(tasks.map((task) => task.source).filter((s): s is string => !!s))].sort();
}

/** Distinct non-empty `sprint` values across the loaded tasks, sorted. */
export function deriveSprintOptions(tasks: readonly Task[]): string[] {
  return [...new Set(tasks.map((task) => task.sprint).filter((s): s is string => !!s))].sort();
}

/**
 * Every tag on the loaded tasks that the display rules show (`shown`, from the
 * tag display store), most used first, ties by text. Hidden tags (Walnut's own
 * `walnut:*` machine tags, anything the user or a plugin hid) are not offered:
 * the panel lists what the board shows. A hidden tag that is already selected
 * still renders, because the panel puts selected tags in front of this list.
 */
export function deriveTagOptions(
  tasks: readonly Pick<Task, 'tags'>[],
  shown: (tag: string) => boolean,
): string[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    // A task can repeat a tag; count it once per task.
    for (const tag of new Set(task.tags ?? [])) {
      if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([tag]) => shown(tag))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

/**
 * Normalize a query, degrading to `null` ("no conditions") instead of throwing.
 *
 * A half-typed custom time window is the only realistic thrower and
 * `taskQueryTime()` already guards it, so this is a belt-and-braces path — but
 * it must never blank a surface's whole list, which is what an uncaught
 * TaskQueryError would do.
 */
export function safeNormalizeTaskQuery(query: TaskQuery, now: Date): NormalizedTaskQuery | null {
  try {
    return normalizeTaskQuery(query, now);
  } catch (err) {
    log.warn('tasks', 'task query rejected — falling back to unfiltered', {
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Context the pure evaluator cannot derive from a task row on its own.
 *
 *  - `blockedIds` — a dependency-graph condition. matchesTaskQuery THROWS when
 *    `query.blocked` is set without it (so "never computed" can't read as
 *    "nothing is blocked"), which is why it's built only when the condition is
 *    actually on: it's an O(tasks × deps) pass.
 */
export function buildTaskQueryContext(
  tasks: readonly Task[],
  needsBlocked: boolean,
): TaskQueryContext {
  if (!needsBlocked) return {};
  return { blockedIds: computeBlockedIds(tasks) };
}
