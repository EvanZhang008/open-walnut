/** The words of an empty, loading or unavailable state (EmptyState.tsx). Pure, so they are unit tested. */

/**
 * A state's words given as one string ("Nothing here yet. It fills when ..."): the first sentence
 * is the title (without its period), the rest the hint.
 */
export function stateWords(text: string): { title: string; hint?: string } {
  const at = text.search(/[.!?]\s+\S/);
  if (at < 0) return { title: text.replace(/\.$/, '') };
  return { title: text.slice(0, at), hint: text.slice(at + 1).trim() };
}

/**
 * A reason a person can read as it is: a short sentence that ends in a full stop, with no code,
 * path, status number or error name in it ("Needs your Mac. Its conversation is there.").
 * Anything else ("HTTP 502", "ENOENT: /x/y.jsonl", "Session history file not found") is a detail.
 */
export function readsPlain(text: string): boolean {
  const t = text.trim();
  return t.length <= 160
    && /^[A-Z][^/\\{}<>`_=|]*[.!?]$/.test(t)
    && !/\b(?:[A-Z]{2,}\d*|HTTP|\d{3,}|Error|undefined|null|NaN|file|JSON|stack)\b/.test(t);
}
