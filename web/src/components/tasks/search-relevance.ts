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

export interface SearchMatchFacts<T> {
  isOpen(task: T): boolean;
  isLiteral(task: T): boolean;
  /** Literal hit, exact reference, or a server row that shows the query. */
  showsQuery(task: T): boolean;
  /** Where the query starts in the title; Infinity for a project or tag hit. */
  titlePosition(task: T): number;
  completedAt(task: T): string | undefined;
}

/**
 * Completed title hits shown inline: a finished task must be findable by its own
 * title, but a broad word matches dozens of them (90 done vs 12 open for one
 * word in real data), and a wall of history would push live work out of view.
 */
export const INLINE_COMPLETED_HITS = 3;

/**
 * Arrange a search's matches for display. `matches` arrives quick lane first,
 * then the server lane, each in rank order.
 *   primary:   open literal hits; then up to three completed literal hits, the
 *              query nearest the title's start first (a long pasted prompt that
 *              merely contains the word ranks last), most recently completed next;
 *              then open server hits that show the query.
 *              Literal rows are all known before the server answers, so they
 *              never move when it does.
 *   completed: the other completed hits that show the query, behind "Completed (N)".
 *   related:   open hits that don't show it, behind "Related (N)".
 *   looseDone: completed hits that don't show it; only the Done chip brings them.
 * With `includeAllDone` (the Done chip) everything that shows the query stays in
 * pure rank order and every loose hit goes to related. When primary is empty the
 * first non-empty fold is the answer, so it shows directly.
 */
export function arrangeSearchResults<T>(
  matches: readonly T[],
  facts: SearchMatchFacts<T>,
  includeAllDone: boolean,
): { primary: T[]; completed: T[]; related: T[]; looseDone: number } {
  let looseDone = 0;
  const strong: T[] = [];
  const related: T[] = [];
  const literalOpen: T[] = [];
  const literalDone: T[] = [];
  const serverOpen: T[] = [];
  const serverDone: T[] = [];
  for (const task of matches) {
    const open = facts.isOpen(task);
    if (!facts.showsQuery(task)) {
      if (!open) looseDone++;
      if (open || includeAllDone) related.push(task);
      continue;
    }
    if (includeAllDone) strong.push(task);
    else if (facts.isLiteral(task)) (open ? literalOpen : literalDone).push(task);
    else (open ? serverOpen : serverDone).push(task);
  }
  let primary = strong;
  let completed: T[] = [];
  if (!includeAllDone) {
    literalDone.sort((a, b) => (facts.titlePosition(a) - facts.titlePosition(b))
      || (facts.completedAt(b) ?? '').localeCompare(facts.completedAt(a) ?? ''));
    primary = [...literalOpen, ...literalDone.slice(0, INLINE_COMPLETED_HITS), ...serverOpen];
    completed = [...literalDone.slice(INLINE_COMPLETED_HITS), ...serverDone];
  }
  if (primary.length === 0) {
    if (completed.length > 0) return { primary: completed, completed: [], related, looseDone };
    return { primary: related, completed: [], related: [], looseDone };
  }
  return { primary, completed, related, looseDone };
}
