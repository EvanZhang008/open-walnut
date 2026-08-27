/**
 * Agent search trigger policy — pure functions, no React.
 *
 * The AI lane costs a whole claude -p run (10-30s, subscription quota), so it
 * fires only for queries that look like a QUESTION about tasks, never for the
 * short substrings and pasted ids the instant lane already handles.
 */

/** Longer than the instant lane's 500ms (useTaskSearch) so the AI lane only
 *  fires once typing has genuinely settled. */
export const AGENT_SEARCH_DEBOUNCE_MS = 1000;

/** 'open-walnut-' prefix keeps the toggle riding the ui-prefs sync. */
export const AGENT_SEARCH_TOGGLE_KEY = 'open-walnut-agent-search';

const CJK_RE = /[㐀-鿿぀-ヿ가-힯]/;

export function isAgentSearchEligible(query: string): boolean {
  const t = query.trim();
  if (t.length < 6) return false;
  // A pasted URL / session uuid / task id is a navigation command — the
  // reference lane resolves it instantly and an AI run would be pure waste.
  // Shapes are matched narrowly so hyphenated words ("notification-redesign")
  // stay eligible: uuids are hex-only, task ids are 8-9 alnum + dash + 4.
  if (/^https?:\/\//i.test(t)) return false;
  if (/^[0-9a-f]{8}[0-9a-f-]*$/i.test(t)) return false;
  if (/^[a-z0-9]{8,9}-[a-z0-9]{4}$/i.test(t)) return false;
  return t.split(/\s+/).length >= 2 || CJK_RE.test(t) || t.length >= 10;
}
