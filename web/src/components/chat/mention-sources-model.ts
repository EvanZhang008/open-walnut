/**
 * The "@" picker's tabs and its mixed view, as pure rules (no React, no DOM; loads in a bare
 * node test).
 *
 *   All · Tasks · Notes · Slack · Mail · …   (core/mention-sources on the server decides
 *                                             every tab after Tasks, in its order)
 *
 * "All" searches every source (2026-10-31, the user: "All 里面我搜索也没有搜索到 Notes"):
 *   Tasks, then the `top` sources (core's own: Notes), then Files: they show at once;
 *   then every `below` source (a plugin: Slack, Mail, ...), a few rows each, filled in
 *   when it answers. A slow or failed source never holds the list: it adds its rows
 *   later or none. No source is left out, and none decides its own place (allPlan).
 * A tab shows one source's own search. Ways to a tab:
 *   - Tab / Shift+Tab cycle the tabs;
 *   - → at the end of the query and ← at its start (where the caret would otherwise leave
 *     the "@query"), and either arrow again right after a switch;
 *   - typing the source's keyword and a space: "@slack deploy", "@tasks deploy" (the
 *     keyword alone, "@slack", is still an ordinary search, so a task named Slack stays
 *     reachable).
 */

export interface MentionSourceInfo {
  id: string;
  label: string;
  /** Keyword plus aliases this source owns (`slack`, `sl`). */
  keywords: string[];
  kinds: string[];
  minChars: number;
  /** Older servers' flag; every source is asked in All now (allPlan). */
  inAll?: boolean;
  /** Where All shows it: `top` beside Tasks and Files, `below` under them (the default). */
  lane?: 'top' | 'below';
}

export interface MentionSourceRow {
  ref: string;
  title: string;
  subtitle?: string;
  kind?: string;
  keys?: string[];
}

export const ALL_TAB = 'all';
/** Tasks live in the browser (the task list plus the hybrid search), not on the source list. */
export const TASKS_TAB = 'tasks';
export const TASKS_KEYWORDS = ['tasks', 'task'];

/** Rows a `top` source (Notes) shows in All. */
export const ALL_TOP_ROWS = 3;
/** Rows one `below` source (Slack, Mail) shows in All, and all of them together. */
export const ALL_BELOW_ROWS_EACH = 2;
export const ALL_BELOW_ROWS_MAX = 4;
/** Shortest query All asks a `below` source about: one letter matches half of Slack. */
export const ALL_BELOW_MIN_CHARS = 2;
/** All asks the `top` sources once typing pauses this long, the `below` ones after this. */
export const ALL_TOP_DEBOUNCE_MS = 120;
export const ALL_BELOW_DEBOUNCE_MS = 300;

export const laneOf = (s: MentionSourceInfo): 'top' | 'below' => (s.lane === 'top' ? 'top' : 'below');

/**
 * Which sources All asks for `query`, by lane. Every source is in one of the two lists
 * unless the query is too short for it or is a path (a "/" browses Files).
 */
export function allPlan(sources: readonly MentionSourceInfo[], query: string): { top: string[]; below: string[] } {
  const q = query.trim();
  if (q.includes('/')) return { top: [], below: [] };
  const top: string[] = [];
  const below: string[] = [];
  for (const src of sources) {
    if (q.length < (src.minChars ?? 0)) continue;
    if (laneOf(src) === 'top') top.push(src.id);
    else if (q.length >= ALL_BELOW_MIN_CHARS) below.push(src.id);
  }
  return { top, below };
}

/** `@<keyword> <rest>`: the source the keyword names, and the query left for it. */
export function parseKeywordScope(
  query: string,
  sources: readonly MentionSourceInfo[],
): { sourceId: string; keyword: string; rest: string } | null {
  const m = /^([A-Za-z0-9]+) (.*)$/.exec(query);
  if (!m) return null;
  const word = m[1].toLowerCase();
  if (TASKS_KEYWORDS.includes(word)) return { sourceId: TASKS_TAB, keyword: m[1], rest: m[2] };
  const source = sources.find((s) => s.keywords.includes(word));
  return source ? { sourceId: source.id, keyword: m[1], rest: m[2] } : null;
}

export function tabsOf(sources: readonly MentionSourceInfo[]): string[] {
  return [ALL_TAB, TASKS_TAB, ...sources.map((s) => s.id).filter((id) => id !== ALL_TAB && id !== TASKS_TAB)];
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

/** Does the query name this row exactly? Its title, or one of the names the source says
 *  it answers to (a handle, a channel name, an address). An exact row goes first. */
export function isPreciseMatch(query: string, row: MentionSourceRow): boolean {
  const q = normalizeName(query);
  if (!q) return false;
  if (normalizeName(row.title) === q) return true;
  return (row.keys ?? []).some((k) => normalizeName(k) === q);
}

/**
 * The source rows All shows, in source order, each source's exact matches first:
 * a `top` source up to ALL_TOP_ROWS, a `below` one up to ALL_BELOW_ROWS_EACH and
 * ALL_BELOW_ROWS_MAX for all of them together.
 */
export function rowsForAll(
  query: string,
  answers: ReadonlyArray<{ sourceId: string; lane: 'top' | 'below'; rows: readonly MentionSourceRow[] }>,
): Array<{ sourceId: string; lane: 'top' | 'below'; row: MentionSourceRow }> {
  const out: Array<{ sourceId: string; lane: 'top' | 'below'; row: MentionSourceRow }> = [];
  let belowTaken = 0;
  for (const { sourceId, lane, rows } of answers) {
    const cap = lane === 'top' ? ALL_TOP_ROWS : Math.min(ALL_BELOW_ROWS_EACH, ALL_BELOW_ROWS_MAX - belowTaken);
    if (cap <= 0) continue;
    const exact = rows.filter((r) => isPreciseMatch(query, r));
    const ordered = [...exact, ...rows.filter((r) => !exact.includes(r))].slice(0, cap);
    for (const row of ordered) out.push({ sourceId, lane, row });
    if (lane === 'below') belowTaken += ordered.length;
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
