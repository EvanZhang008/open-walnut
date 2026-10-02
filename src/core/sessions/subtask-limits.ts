/**
 * Server-side brakes on how far one session can multiply itself through Walnut
 * tasks: how DEEP a chain of subtasks may go, and how many of one task's
 * subtasks may run at once.
 *
 * Why in the server and not the prompt: a prompt line is one routine edit away
 * from deletion, and a session that files subtasks which file subtasks has no
 * natural stop. The prompt already tells a session to split work with its own
 * tools; these limits are what still holds when that advice is ignored.
 *
 * Scope: only work a SESSION creates or starts (a caller id rides the request).
 * The human's own creates and starts, from the board, the phone or the CLI, are
 * never limited, and a Personal AI ask is exempt from the running limit because
 * the user asking it IS the request (see caller-placement.ts for the same split).
 */

import type { Task } from '../types.js';

/** Levels below a top-level task. A top-level task is depth 0; its subtask 1. */
export const MAX_SUBTASK_DEPTH = 3;
/** Subtasks of one task that may run (IN_PROGRESS or starting) at once. */
export const MAX_RUNNING_SUBTASKS = 8;

export type SubtaskLimitCode = 'subtask_too_deep' | 'too_many_running_subtasks';

export class SubtaskLimitError extends Error {
  readonly statusCode = 409;
  constructor(readonly code: SubtaskLimitCode, message: string) {
    super(message);
    this.name = 'SubtaskLimitError';
  }
}

/**
 * Depth of a task in its parent chain. Bounded and cycle-safe: a chain longer
 * than the cap (or a corrupted loop) stops the walk, since past the cap the
 * exact number no longer changes the answer.
 */
export async function taskDepth(taskId: string): Promise<number> {
  const { listTasksByIds } = await import('../task-manager.js');
  const seen = new Set<string>();
  let depth = 0;
  let id: string | undefined = taskId;
  while (id && !seen.has(id) && depth <= MAX_SUBTASK_DEPTH + 1) {
    seen.add(id);
    const task: Task | undefined = (await listTasksByIds([id]))[0];
    id = task?.parent_task_id || undefined;
    if (id) depth++;
  }
  return depth;
}

/** Throws when a new subtask of `parentId` would sit deeper than the cap. */
export async function assertSubtaskDepth(parentId: string, parentTitle?: string): Promise<void> {
  const depth = await taskDepth(parentId);
  if (depth + 1 <= MAX_SUBTASK_DEPTH) return;
  const name = parentTitle ? `"${parentTitle}" (${parentId})` : parentId;
  throw new SubtaskLimitError('subtask_too_deep',
    `Refused: ${name} is already a subtask ${depth} level${depth === 1 ? '' : 's'} deep, and subtasks go at most `
    + `${MAX_SUBTASK_DEPTH} levels. Do this part here with your own tools (todo list, subagents), or report it `
    + 'back to the task that started you.');
}

/**
 * Levels of subtasks below a task: 0 for a task with none, 1 when it has
 * children, 2 when one of those has its own, and so on. One board read, then a
 * level-by-level walk that is cycle-safe (a corrupted loop is seen once) and
 * stops past the cap, where the exact number no longer changes any answer.
 */
export async function subtreeHeight(taskId: string): Promise<number> {
  const { listTasks } = await import('../task-manager.js');
  const children = new Map<string, string[]>();
  for (const t of await listTasks()) {
    if (!t.parent_task_id) continue;
    const bucket = children.get(t.parent_task_id);
    if (bucket) bucket.push(t.id);
    else children.set(t.parent_task_id, [t.id]);
  }
  const seen = new Set<string>([taskId]);
  let level = [taskId];
  let height = 0;
  while (height <= MAX_SUBTASK_DEPTH) {
    const next: string[] = [];
    for (const id of level) {
      for (const child of children.get(id) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        next.push(child);
      }
    }
    if (next.length === 0) break;
    height++;
    level = next;
  }
  return height;
}

/**
 * True when `ancestorId` sits in the parent chain of `taskId` (`taskId` itself
 * excluded). Walks the whole chain, not just the depth cap: a person may build
 * a longer one by hand, and a cycle check that stopped early would let one in.
 * A corrupted loop that does not contain `ancestorId` ends at its first repeat.
 */
export async function hasAncestor(taskId: string, ancestorId: string): Promise<boolean> {
  const { listTasksByIds } = await import('../task-manager.js');
  const seen = new Set<string>([taskId]);
  let id: string | undefined = (await listTasksByIds([taskId]))[0]?.parent_task_id || undefined;
  while (id && !seen.has(id)) {
    if (id === ancestorId) return true;
    seen.add(id);
    id = (await listTasksByIds([id]))[0]?.parent_task_id || undefined;
  }
  return false;
}

/**
 * Throws when making `taskId` a subtask of `parentId` would push its own
 * deepest subtask past the cap: the parent's depth, one level for the task,
 * plus every level the task already carries below it.
 */
export async function assertAdoptionDepth(
  parentId: string,
  taskId: string,
  names: { parentTitle?: string; taskTitle?: string } = {},
): Promise<void> {
  const [depth, height] = await Promise.all([taskDepth(parentId), subtreeHeight(taskId)]);
  const deepest = depth + 1 + height;
  if (deepest <= MAX_SUBTASK_DEPTH) return;
  const parent = names.parentTitle ? `"${names.parentTitle}" (${parentId})` : parentId;
  const task = names.taskTitle ? `"${names.taskTitle}" (${taskId})` : taskId;
  const below = height === 0 ? '' : `, with the ${height} level${height === 1 ? '' : 's'} of subtasks it already has,`;
  throw new SubtaskLimitError('subtask_too_deep',
    `Refused: ${parent} is a subtask ${depth} level${depth === 1 ? '' : 's'} deep, so ${task}${below} would reach `
    + `${deepest} levels down, and subtasks go at most ${MAX_SUBTASK_DEPTH} levels. Leave it where it is and `
    + 'talk to it with task_send, or ask the task that started you to adopt it.');
}

/** Starts that passed the running check and have not settled yet, per parent. */
const admitted = new Map<string, Set<string>>();
/** One admission at a time per parent: see admitSubtaskStart. */
const admissionLocks = new Map<string, Promise<void>>();

/**
 * Admit one start under `parentId`, or throw when the maximum number of its
 * subtasks is already running. Returns the release to call once the start has
 * settled (spawned or failed); until then the start counts as running.
 *
 * Serialized per parent: Claude Code runs a turn's tool calls in parallel, so a
 * worker can fire ten task_create calls at once, and a check that only reads the
 * board would let all ten through before any is IN_PROGRESS. Inside the lock a
 * start counts every sibling that is IN_PROGRESS or already admitted; one that
 * merely entered its own start first does not, so two racing starts at the
 * limit admit exactly one. `startingTaskId` never counts against itself (a
 * restart of a running child is refused elsewhere, as already started).
 * Releasing when the start settles leaves no gap: the runner writes the child's
 * IN_PROGRESS before it confirms the spawn.
 */
export async function admitSubtaskStart(parentId: string, startingTaskId: string, parentTitle?: string): Promise<() => void> {
  let unlock!: () => void;
  const mine = new Promise<void>((resolve) => { unlock = resolve; });
  const previous = admissionLocks.get(parentId) ?? Promise.resolve();
  const tail = previous.then(() => mine);
  admissionLocks.set(parentId, tail);
  await previous;
  try {
    // A board that cannot be read admits the start (fail open, like an unknown caller).
    const children = await import('../task-manager.js')
      .then((m) => m.getChildTasks(parentId)).catch(() => [] as Task[]);
    const starting = admitted.get(parentId) ?? new Set<string>();
    const running = children.filter((c) => c.id !== startingTaskId
      && (c.phase === 'IN_PROGRESS' || starting.has(c.id)));
    if (running.length >= MAX_RUNNING_SUBTASKS) {
      const name = parentTitle ? `"${parentTitle}"` : parentId;
      const ids = running.slice(0, MAX_RUNNING_SUBTASKS).map((c) => c.id);
      throw new SubtaskLimitError('too_many_running_subtasks',
        `Refused: ${running.length} subtasks of ${name} are already running, and at most ${MAX_RUNNING_SUBTASKS} run at `
        + `once. Wait for one to finish (walnut wait ${ids.slice(0, 3).join(' ')} --any), or do this part with your `
        + `own tools. Running: ${ids.join(', ')}.`);
    }
    starting.add(startingTaskId);
    admitted.set(parentId, starting);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      starting.delete(startingTaskId);
      if (starting.size === 0 && admitted.get(parentId) === starting) admitted.delete(parentId);
    };
  } finally {
    unlock();
    if (admissionLocks.get(parentId) === tail) admissionLocks.delete(parentId);
  }
}
