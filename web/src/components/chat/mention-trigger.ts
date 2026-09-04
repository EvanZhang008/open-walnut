/**
 * "@" mention trigger detection (pure; the slash twin is slash-trigger.ts).
 *
 * The trigger is strict so emails (`a@b`) and decorators never false-fire: the
 * "@" must sit at the start of the input or right after whitespace, and the
 * query between it and the caret must not contain whitespace.
 *
 * Multi-word queries are the one deliberate exception. The palette's hybrid
 * search understands "oauth returns unauthorized" while a single token would
 * never find that task, so once the palette is OPEN for a given "@" the query
 * may keep growing across single spaces. `openAt` is that "@"'s index (or -1
 * when nothing is open): the FIRST word still has to be typed without a space,
 * so a stray "@" in prose never quietly captures the rest of the sentence, and
 * the palette itself closes on a definitive no-match so a runaway query hands
 * Enter back to "send".
 */

/** Longest a multi-word query may grow before it stops being a lookup. */
export const MENTION_QUERY_MAX_CHARS = 64;
/** Most words a multi-word query may hold — five is a long description already. */
export const MENTION_QUERY_MAX_WORDS = 6;

export function detectMention(
  text: string,
  caret: number,
  openAt = -1,
): { atIndex: number; query: string } | null {
  const at = text.lastIndexOf('@', caret - 1);
  if (at === -1) return null;
  const before = at === 0 ? '' : text[at - 1];
  if (before && !/\s/.test(before)) return null;
  const query = text.slice(at + 1, caret);
  if (!/\s/.test(query)) return { atIndex: at, query };
  // Whitespace inside the query: only allowed while the palette is already open
  // for this very "@", and only in the shape of words separated by single spaces.
  if (at !== openAt) return null;
  if (/[\n\r\t]/.test(query) || /\s\s/.test(query) || /^\s/.test(query)) return null;
  if (query.length > MENTION_QUERY_MAX_CHARS) return null;
  if (query.trim().split(' ').length > MENTION_QUERY_MAX_WORDS) return null;
  return { atIndex: at, query };
}
