/**
 * Refresh one task's search document from outside the task store: a write that changes what the
 * document holds without a task event (his words filed in user-asks.ts). The search wiring
 * registers the hook while it runs; elsewhere (the CLI, a process without the index) it is a no-op.
 * Its own module so a caller never loads the index library to ask.
 */
let hook: ((taskId: string) => void) | null = null;
/** Bumped by every requeue, so a reader that keeps his words in memory (search.ts) reads again. */
let generation = 0;

export function taskSearchGeneration(): number {
  return generation;
}

export function setTaskSearchRequeue(fn: (taskId: string) => void): void {
  hook = fn;
}

/** Only the wiring that set it clears it: a newer wiring keeps its own. */
export function clearTaskSearchRequeue(fn: (taskId: string) => void): void {
  if (hook === fn) hook = null;
}

export function requeueTaskSearch(taskId: string): void {
  generation++;
  hook?.(taskId);
}
