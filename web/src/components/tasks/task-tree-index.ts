import type { Task } from '@open-walnut/core';

/**
 * Parent links read off a task list in one pass per list.
 *
 * A subtask names its parent with `parent_task_id`, which may be a short
 * prefix of the parent's id (legacy data): the rule everywhere is
 * `parent.id.startsWith(child.parent_task_id)`. Resolving that with
 * `list.find(startsWith)` per subtask costs O(subtasks x tasks) on every task
 * event. Here each id is instead cut at every distinct reference length and
 * looked up, so a whole list costs O(tasks x distinct lengths).
 */

type TaskRef = Pick<Task, 'id' | 'parent_task_id'>;

/** Case-insensitive project identity, the registry's rule ('' = Inbox). */
function projectKey(p: string | undefined): string {
  return (p ?? '').trim().toLowerCase();
}

const NO_REFS: readonly string[] = [];

/** Answers "which of these references does this id start with". */
export class ParentRefMatcher {
  private readonly rank = new Map<string, number>();
  private readonly lengths: number[];

  constructor(refs: Iterable<string>) {
    for (const ref of refs) if (!this.rank.has(ref)) this.rank.set(ref, this.rank.size);
    this.lengths = [...new Set([...this.rank.keys()].map((ref) => ref.length))].sort((a, b) => a - b);
  }

  get size(): number {
    return this.rank.size;
  }

  /** The references `id` starts with, in the order they were given. */
  refsOf(id: string): readonly string[] {
    let out: string[] | undefined;
    for (const len of this.lengths) {
      if (len > id.length) break;
      const head = len === id.length ? id : id.slice(0, len);
      if (!this.rank.has(head)) continue;
      if (out) out.push(head); else out = [head];
    }
    if (!out) return NO_REFS;
    if (out.length > 1) out.sort((a, b) => this.rank.get(a)! - this.rank.get(b)!);
    return out;
  }
}

/** The distinct non-empty `parent_task_id` values of `list`, in first-seen order. */
export function parentRefsOf(list: readonly TaskRef[]): Set<string> {
  const refs = new Set<string>();
  for (const t of list) if (t.parent_task_id) refs.add(t.parent_task_id);
  return refs;
}

// ref -> first match in list order (null = none). Cached per list ARRAY: the
// task context hands out a new array on every change and never mutates one.
const FIRST_MATCH = new WeakMap<readonly TaskRef[], Map<string, TaskRef | null>>();

function buildFirstMatch(list: readonly TaskRef[]): Map<string, TaskRef | null> {
  const refs = parentRefsOf(list);
  const matcher = new ParentRefMatcher(refs);
  const first = new Map<string, TaskRef | null>();
  if (matcher.size === 0) return first;
  for (const t of list) {
    for (const ref of matcher.refsOf(t.id)) if (!first.has(ref)) first.set(ref, t);
    if (first.size === matcher.size) break;
  }
  for (const ref of refs) if (!first.has(ref)) first.set(ref, null);
  return first;
}

/**
 * Exactly `list.find((t) => t.id.startsWith(ref))`. The references the list's
 * own members carry are resolved together on first use; any other reference
 * falls back to one scan, remembered for this list.
 */
export function resolveParentRef<T extends TaskRef>(list: readonly T[], ref: string): T | undefined {
  let first = FIRST_MATCH.get(list);
  if (!first) {
    first = buildFirstMatch(list);
    FIRST_MATCH.set(list, first);
  }
  let hit = first.get(ref);
  if (hit === undefined) {
    hit = list.find((t) => t.id.startsWith(ref)) ?? null;
    first.set(ref, hit);
  }
  return (hit ?? undefined) as T | undefined;
}

/** Parent id -> how many tasks of `tasks` resolve to it as their parent. */
export function countSubtasksByParent(tasks: readonly TaskRef[]): Map<string, number> {
  const countMap = new Map<string, number>();
  for (const task of tasks) {
    if (!task.parent_task_id) continue;
    const parent = resolveParentRef(tasks, task.parent_task_id);
    if (parent) countMap.set(parent.id, (countMap.get(parent.id) ?? 0) + 1);
  }
  return countMap;
}

/**
 * `matched` followed by the subtasks of rows already listed, at any depth, as
 * hierarchy context. Passes over `tasks` repeat until one adds nothing, and a
 * row added earlier in a pass already counts as a parent later in that pass.
 * Only a parent in the SAME project pulls a subtask in: a subtask filed into
 * another project is that project's own row (its Sub pill carries the link),
 * and must not drag its project into a view filtered to the parent's.
 */
export function withSubtaskContext<T extends TaskRef & Pick<Task, 'project'>>(
  tasks: readonly T[],
  matched: readonly T[],
  eligible: (t: T) => boolean,
): T[] {
  const result = [...matched];
  const included = new Set<string>(matched.map((t) => t.id));
  const matcher = new ParentRefMatcher(parentRefsOf(tasks));
  // ref -> project keys of listed rows whose id starts with it.
  const listed = new Map<string, Set<string>>();
  const list = (t: T): void => {
    for (const ref of matcher.refsOf(t.id)) {
      const keys = listed.get(ref);
      if (keys) keys.add(projectKey(t.project)); else listed.set(ref, new Set([projectKey(t.project)]));
    }
  };
  for (const t of result) list(t);
  let added = true;
  while (added) {
    added = false;
    for (const t of tasks) {
      if (included.has(t.id)) continue;
      if (!t.parent_task_id) continue;
      if (!eligible(t)) continue;
      if (!listed.get(t.parent_task_id)?.has(projectKey(t.project))) continue;
      result.push(t);
      included.add(t.id);
      list(t);
      added = true;
    }
  }
  return result;
}
