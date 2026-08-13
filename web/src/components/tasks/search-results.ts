export interface TaskReferenceFields {
  id: string;
  session_id?: string;
  session_ids?: string[];
  plan_session_id?: string;
  exec_session_id?: string;
  external_url?: string;
}

/** Fields the open-first search ranking reads. */
export interface TaskSearchRankFields {
  id: string;
  status?: string;
  title?: string;
}

/**
 * Rank a search match list so OPEN tasks come before completed ones, stably.
 *
 * Search intentionally ignores every view filter — including "Show completed" —
 * so the raw match set is dominated by history (a mature install has ~20x more
 * done tasks than open ones). Without this, a broad query like "check" fills
 * the whole render cap with finished work and the one live task the user was
 * hunting for never mounts.
 *
 * Order WITHIN each bucket is preserved: relevance ordering (metadata-exact
 * first, then the server's semantic ranking) is decided by the caller, and this
 * only partitions by open-vs-done on top of it.
 */
export function rankOpenTasksFirst<T extends TaskSearchRankFields>(
  matches: readonly T[],
): T[] {
  const open: T[] = [];
  const done: T[] = [];
  for (const task of matches) (task.status === 'done' ? done : open).push(task);
  return [...open, ...done];
}

const MIN_PARTIAL_REFERENCE_LENGTH = 8;

function referenceMatches(
  value: string | undefined,
  query: string,
  kind: 'id' | 'url' = 'id',
): boolean {
  if (!value) return false;
  const normalizedValue = value.toLowerCase();
  if (normalizedValue === query) return true;
  if (query.length < MIN_PARTIAL_REFERENCE_LENGTH || /\s/.test(query)) return false;
  if (kind === 'url' && !/^https?:\/\//.test(query)) return false;
  return normalizedValue.startsWith(query);
}

export function taskReferenceMatchField(
  task: TaskReferenceFields,
  rawQuery: string,
): 'id' | 'session_id' | 'external_url' | null {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return null;

  if (referenceMatches(task.id, query)) return 'id';
  if (
    referenceMatches(task.session_id, query)
    || task.session_ids?.some((sessionId) => referenceMatches(sessionId, query))
    || referenceMatches(task.plan_session_id, query)
    || referenceMatches(task.exec_session_id, query)
  ) {
    return 'session_id';
  }
  if (referenceMatches(task.external_url, query, 'url')) return 'external_url';
  return null;
}

/** Map authoritative server IDs to the currently loaded, filter-eligible tasks. */
export function mapServerTaskSearchResults<T extends TaskReferenceFields>(
  eligibleTasks: readonly T[],
  serverTaskIds: readonly string[],
): T[] {
  const taskById = new Map(eligibleTasks.map((task) => [task.id, task]));
  const results: T[] = [];
  const seen = new Set<string>();

  const append = (task: T | undefined) => {
    if (!task || seen.has(task.id)) return;
    seen.add(task.id);
    results.push(task);
  };

  for (const taskId of serverTaskIds) append(taskById.get(taskId));

  return results;
}
