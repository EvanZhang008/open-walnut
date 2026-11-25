/**
 * When something last went into each task's session: any message (sendMessageToSession) or a
 * trigger fire a host delivered straight into the CLI. In memory; a restart only forgets it.
 *
 * subtask-notices.ts reads it: a second "stopped" about the same child with nothing sent into it
 * since the first is the same state, not news (2026-11-19: a lead read "stopped without completing
 * its task" three times in four minutes about a worker nobody had written to, whose background
 * subagent was still working).
 */
const lastInputAt = new Map<string, number>();
const MAX_TASKS = 5000;

/** Stamp it; the function returned takes the stamp back (a send that then stored nothing). */
export function noteTaskInput(taskId: string | null | undefined, at = Date.now()): () => void {
  if (!taskId) return () => {};
  if (lastInputAt.size >= MAX_TASKS && !lastInputAt.has(taskId)) lastInputAt.clear();
  const before = lastInputAt.get(taskId);
  lastInputAt.set(taskId, at);
  return () => {
    // A later input stamped since keeps its own.
    if (lastInputAt.get(taskId) !== at) return;
    if (before === undefined) lastInputAt.delete(taskId);
    else lastInputAt.set(taskId, before);
  };
}

export function lastTaskInputAt(taskId: string): number | undefined {
  return lastInputAt.get(taskId);
}

/** Test seam. */
export function resetTaskInputClockForTest(): void {
  lastInputAt.clear();
}
