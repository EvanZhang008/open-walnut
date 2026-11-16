import { useRef } from 'react';

/** True when both sets hold exactly the same members. */
export function sameMembers<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * The set a render computed, or the one the last render returned when it holds the same
 * members. A set derived from a list (open column ids, the projects the tasks name) is a new
 * object on every recompute; handed to a memo'd component or an effect's deps, that alone
 * re-ran them. On Home it re-drew the whole task list for every task update
 * and every column change, Cmd+N included (2026-11-16, task 9bceb9f2).
 */
export function useSameSet<S extends ReadonlySet<unknown>>(next: S): S {
  const kept = useRef(next);
  if (kept.current !== next && !sameMembers(kept.current, next)) kept.current = next;
  return kept.current;
}
