/**
 * The "@" picker's source tabs, as pure rules (no React, no DOM; loads in a bare node test).
 *
 * The picker has one tab per source after the default one:
 *
 *   All · Notes · Slack · Mail · …     (core/mention-sources on the server decides the list)
 *
 * "All" is the mixed view: tasks and files as before, plus a plugin row only when the query
 * names it EXACTLY (isPreciseMatch), so a loose match never crowds out a task or a file.
 * A source tab shows that source's own search. Ways to a tab:
 *   - Tab / Shift+Tab cycle the tabs;
 *   - → at the end of the query and ← at its start (where the caret would otherwise leave
 *     the "@query"), and either arrow again right after a switch;
 *   - typing the source's keyword and a space: "@slack deploy" (the keyword alone, "@slack",
 *     is still an ordinary search, so a task named Slack stays reachable).
 */

export interface MentionSourceInfo {
  id: string;
  label: string;
  /** Keyword plus aliases this source owns (`slack`, `sl`). */
  keywords: string[];
  kinds: string[];
  minChars: number;
  /** Asked in the mixed "All" view too (false: only on its own tab). */
  inAll?: boolean;
}

export interface MentionSourceRow {
  ref: string;
  title: string;
  subtitle?: string;
  kind?: string;
  keys?: string[];
}

export const ALL_TAB = 'all';

/** Rows from all plugin sources together that "All" may show (exact matches only). */
export const ALL_SOURCE_ROWS_MAX = 3;
/** Rows from one source in "All". */
export const ALL_SOURCE_ROWS_EACH = 2;
/** Shortest query "All" asks the sources about: a name shorter than this is rarely meant exactly. */
export const ALL_SOURCE_MIN_CHARS = 3;
/** "All" asks the sources only once typing pauses this long (a tab's own search: 200 ms). */
export const ALL_SOURCE_DEBOUNCE_MS = 400;

/** `@<keyword> <rest>`: the source the keyword names, and the query left for it. */
export function parseKeywordScope(
  query: string,
  sources: readonly MentionSourceInfo[],
): { sourceId: string; keyword: string; rest: string } | null {
  const m = /^([A-Za-z0-9]+) (.*)$/.exec(query);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const source = sources.find((s) => s.keywords.includes(word));
  return source ? { sourceId: source.id, keyword: m[1], rest: m[2] } : null;
}

export function tabsOf(sources: readonly MentionSourceInfo[]): string[] {
  return [ALL_TAB, ...sources.map((s) => s.id)];
}

/** The tab `delta` steps from `current`, wrapping. An unknown current counts as All. */
export function cycleTab(tabs: readonly string[], current: string, delta: number): string {
  if (tabs.length === 0) return ALL_TAB;
  const at = Math.max(0, tabs.indexOf(current));
  return tabs[((at + delta) % tabs.length + tabs.length) % tabs.length];
}

/** Case, a leading "@"/"#", and runs of spaces, "-", "_", "." do not tell two names apart. */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/^[@#]+/, '').replace(/[\s\-_.]+/g, ' ').trim();
}

/**
 * Does the query name this row exactly? Its title, or one of the names the source says
 * it answers to (a handle, a channel name, an address). Nothing partial: "All" is for
 * tasks and files first, and a plugin row joins only when the user clearly meant it.
 */
export function isPreciseMatch(query: string, row: MentionSourceRow): boolean {
  const q = normalizeName(query);
  if (q.length < ALL_SOURCE_MIN_CHARS) return false;
  if (normalizeName(row.title) === q) return true;
  return (row.keys ?? []).some((k) => normalizeName(k) === q);
}

/** The exact rows "All" shows, in source order, capped per source and overall. */
export function preciseRowsForAll(
  query: string,
  answers: ReadonlyArray<{ sourceId: string; rows: readonly MentionSourceRow[] }>,
): Array<{ sourceId: string; row: MentionSourceRow }> {
  const out: Array<{ sourceId: string; row: MentionSourceRow }> = [];
  for (const { sourceId, rows } of answers) {
    let taken = 0;
    for (const row of rows) {
      if (out.length >= ALL_SOURCE_ROWS_MAX) return out;
      if (taken >= ALL_SOURCE_ROWS_EACH) break;
      if (!isPreciseMatch(query, row)) continue;
      out.push({ sourceId, row });
      taken++;
    }
  }
  return out;
}

/**
 * Should an arrow key switch tabs instead of moving the caret? Only where the caret
 * would otherwise leave the "@query" (→ at its end, ← at its start, i.e. right after
 * the "@"), or right after a switch, so ←→ keep browsing tabs once started.
 */
export function arrowSwitchesTab(opts: {
  key: 'ArrowLeft' | 'ArrowRight';
  caret: number;
  hasSelection: boolean;
  atIndex: number;
  end: number;
  justSwitched: boolean;
}): boolean {
  if (opts.hasSelection) return false;
  if (opts.justSwitched && opts.caret === opts.end) return true;
  if (opts.key === 'ArrowRight') return opts.caret === opts.end;
  return opts.caret === opts.atIndex + 1;
}
