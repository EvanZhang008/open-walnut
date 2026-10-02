/**
 * The task's own dates in the search box: `created:2026-10-01` or `updated:2026-09` finds the
 * tasks created or last updated that day (or month). They are tags Walnut works out
 * (src/core/tag-model.ts `dateTags`) and never stores, so the quick lane's tag match, which reads
 * stored tags only, would miss them. Asked only by a query that names one of the two keys, so
 * every other search is untouched.
 */
import { dateTags } from '../../../../src/core/tag-model';

const DATE_QUERY_RE = /^(created|updated):\S/;

export function taskMatchesDateTag(task: { created_at?: string; updated_at?: string }, lowerQuery: string): boolean {
  const query = lowerQuery.trim();
  if (!DATE_QUERY_RE.test(query)) return false;
  return dateTags(task).some((tag) => tag.startsWith(query));
}
