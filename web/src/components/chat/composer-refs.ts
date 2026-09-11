/**
 * The composer's chips-and-prose split.
 *
 * An entity reference (`<task-ref id="…" label="…"/>` and its session/project
 * siblings) is markup the CLI reads, not something a human should have to look
 * at while typing. So the textarea holds prose ONLY and every reference lives
 * beside it as a chip; the message that goes out is the two composed back
 * together, tags first.
 *
 * This module is the one place that knows how to move between the two shapes:
 *
 *   splitComposerRefs(text, existing) → { refs, body }   text → chips + prose
 *   composeWithRefs(refs, body)       → string           chips + prose → message
 *
 * Every path that can put text into the box (draft restore, prefill, an "@"
 * pick, a paste, a restore after a failed send) runs through the split, which is
 * what keeps the invariant true: a tag can never become visible in the textarea.
 *
 * PURE MODULE: no React, no DOM. It has to load in a bare node test.
 */
import { extractEntityRefs } from '@/utils/entity-ref-tags';

export interface ComposerRefSplit {
  /** Tag strings, verbatim, in the order they were referenced. */
  refs: string[];
  /** What the textarea shows: prose with no tags in it. */
  body: string;
}

/**
 * Dedupe key for a tag. The same entity referenced twice is one chip, so the key
 * is kind+id and never the label (a task can be renamed between two picks).
 * A string that is not a tag at all keys on itself rather than collapsing with
 * every other unparseable entry.
 */
function refKey(tag: string): string {
  const m = extractEntityRefs(tag)[0];
  return m ? `${m.kind}:${m.id}` : tag;
}

/**
 * Join what is left after cutting a span out of a line. A cut leaves the two
 * sides touching, so the doubled space a removed `"<tag> "` used to leave is
 * collapsed here, and two words that would otherwise be glued together keep one
 * space between them. Only spaces and tabs are collapsed: a newline is layout
 * the user typed on purpose.
 */
function joinAcrossCut(head: string, tail: string): { text: string; caret: number } {
  if (head === '' || /\s$/.test(head)) {
    return { text: head + tail.replace(/^[ \t]+/, ''), caret: head.length };
  }
  if (tail !== '' && !/^\s/.test(tail)) return { text: `${head} ${tail}`, caret: head.length + 1 };
  return { text: head + tail, caret: head.length };
}

/**
 * Remove `[start, end)` from `text`, collapsing the gap it leaves, and report
 * where the caret belongs afterwards.
 */
export function cutSpan(text: string, start: number, end: number): { text: string; caret: number } {
  return joinAcrossCut(text.slice(0, start), text.slice(end));
}

/**
 * Lift every reference tag in `text` out into `refs` and return the prose that
 * remains. `existing` are the chips already standing (they keep their order and
 * lead the list); a tag repeating one of them is dropped.
 */
export function splitComposerRefs(text: string, existing: readonly string[] = []): ComposerRefSplit {
  const found = extractEntityRefs(text);
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const tag of existing) {
    const key = refKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(tag);
  }
  for (const m of found) {
    const key = `${m.kind}:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(text.slice(m.start, m.end));
  }
  // Back to front so the spans found in the original text stay valid.
  let body = text;
  for (let i = found.length - 1; i >= 0; i--) {
    body = cutSpan(body, found[i].start, found[i].end).text;
  }
  return { refs, body };
}

/**
 * The message (and the persisted draft): tags first, then the prose. Tags lead
 * so the agent reads the references before the sentence about them, and so the
 * draft round-trips through `splitComposerRefs` back to the same chips.
 */
export function composeWithRefs(refs: readonly string[], body: string): string {
  const prose = body.trim();
  if (refs.length === 0) return prose;
  const tags = refs.join(' ');
  return prose ? `${tags} ${prose}` : tags;
}
