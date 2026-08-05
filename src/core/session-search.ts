/**
 * Pure session-list search filtering (server-side `?q=` on the sessions list
 * endpoints). Case-insensitive substring match across session title, owning
 * task title, cwd, and host. Kept pure (no I/O) so it is directly unit-testable
 * and reusable by any list surface.
 */
import type { SessionRecord } from './types.js';

/** Resolve a session's owning-task title; return undefined when unknown. */
export type TaskTitleLookup = (taskId: string) => string | undefined;

/** Resolve a host ALIAS to its full hostname; return undefined when unknown.
 *  Needed because persisted session records carry only the alias — the
 *  `hostname` field is display-time enrichment that happens AFTER filtering. */
export type HostnameLookup = (hostAlias: string) => string | undefined;

/** Partial: list rows from other surfaces may omit any of these fields. */
type SearchableSession = Partial<Pick<SessionRecord, 'title' | 'taskId' | 'cwd' | 'host' | 'hostname'>>;

/** Lowercase haystack fields for one session (title, task title, cwd, host, hostname). */
export function sessionSearchFields(
  session: SearchableSession,
  taskTitleById?: TaskTitleLookup,
  hostnameByAlias?: HostnameLookup,
): string[] {
  const fields: string[] = [];
  if (session.title) fields.push(session.title);
  const taskTitle = session.taskId ? taskTitleById?.(session.taskId) : undefined;
  if (taskTitle) fields.push(taskTitle);
  if (session.cwd) fields.push(session.cwd);
  if (session.host) fields.push(session.host);
  // Prefer the record's own hostname (already enriched); fall back to the
  // resolver for the common case where filtering runs before enrichment.
  const hostname = session.hostname ?? (session.host ? hostnameByAlias?.(session.host) : undefined);
  if (hostname) fields.push(hostname);
  return fields.map((f) => f.toLowerCase());
}

/**
 * Filter sessions by a query. Empty/whitespace query returns the input as-is.
 * Whitespace-separated terms must ALL match (each against any field) so
 * "walnut clouddev" narrows instead of unioning.
 */
export function filterSessionsByQuery<T extends SearchableSession>(
  sessions: T[],
  query: string | undefined,
  taskTitleById?: TaskTitleLookup,
  hostnameByAlias?: HostnameLookup,
): T[] {
  const terms = (query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return sessions;
  return sessions.filter((s) => {
    const fields = sessionSearchFields(s, taskTitleById, hostnameByAlias);
    return terms.every((term) => fields.some((f) => f.includes(term)));
  });
}
