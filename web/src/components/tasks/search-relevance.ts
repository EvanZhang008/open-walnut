/**
 * Home task-panel search: which hits lead and which fold away.
 *
 * The list has two lanes. The QUICK lane is a literal substring match on the
 * small metadata fields (title, project, tags), answered on every keystroke.
 * The SERVER lane arrives after a typing pause and adds hits from descriptions,
 * transcripts and the semantic index. The quick lane is usually what the user
 * wants, so its rows lead and never move; server hits only append.
 *
 * A server hit that shows the typed text in its own title or snippet is real
 * evidence. One that doesn't came from the semantic lane alone (look-alike
 * words, a shared digit): for one short token in the report that was 34 of 40
 * rows, and dozens of those arriving at once read as "my result was replaced",
 * so they fold into one "Related (N)" row. Raw scores can't make this call: the lanes
 * score on different scales, and the same query's noise scored 0.08 one day and
 * 0.3 the next.
 */

export interface LiteralFields {
  title: string;
  project?: string;
  tags?: string[];
}

/** The quick lane's test. `lowerQuery` is already trimmed and lowercased. */
export function taskMatchesLiterally(task: LiteralFields, lowerQuery: string): boolean {
  return task.title.toLowerCase().includes(lowerQuery)
    || (task.project ?? '').toLowerCase().includes(lowerQuery)
    || !!task.tags?.some((tag) => tag.toLowerCase().includes(lowerQuery));
}

/** Server hits on an identifier answer exactly what was typed. */
const REFERENCE_FIELDS = new Set(['id', 'session_id', 'commit_sha', 'external_url']);

/** Lowercased whitespace-split terms; one-character terms are noise unless nothing else is left. */
export function queryTerms(query: string): string[] {
  const all = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const terms = all.filter((term) => term.length > 1);
  return terms.length > 0 ? terms : all;
}

/** Does a server row show the query in its own text (every term, in its title or snippet)? */
export function serverRowShowsQuery(
  row: { title?: string; snippet?: string; matchField?: string },
  terms: readonly string[],
): boolean {
  if (row.matchField && REFERENCE_FIELDS.has(row.matchField)) return true;
  if (terms.length === 0) return false;
  const text = `${row.title ?? ''}\n${row.snippet ?? ''}`.toLowerCase();
  return terms.every((term) => text.includes(term));
}

/**
 * Split an ordered match list into the rows shown up front and the folded
 * "Related" rows, keeping order inside each part. When nothing strong is left
 * the related rows ARE the answer, so they are shown directly.
 */
export function splitRelatedMatches<T extends { id: string }>(
  ordered: readonly T[],
  weakIds: ReadonlySet<string>,
): { primary: T[]; related: T[] } {
  if (weakIds.size === 0) return { primary: [...ordered], related: [] };
  const primary: T[] = [];
  const related: T[] = [];
  for (const task of ordered) (weakIds.has(task.id) ? related : primary).push(task);
  if (primary.length === 0) return { primary: related, related: [] };
  return { primary, related };
}
