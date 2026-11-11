/**
 * THE projection of a delivered user line to what a person reads: Walnut's message hints and
 * reference-card block off, the pre-registry bracket lines off old rows.
 *
 * Moved from reference-cards.ts (2026-11-11) so it has no I/O: the transcript parser
 * (history-parse.ts) runs it on every user row, and the session daemon bundles that parser.
 * reference-cards.ts re-exports all of it.
 */

import { parseHinted, type CarriedHint } from '../hints/hint-format.js';
import { redactAiOnly } from '../../lib/ai-only-envelope.js';
import { stripLegacyHintLines } from './legacy-hint-lines.js';

/** Block markers, each on its OWN line. Line-anchored like the output-mode
 *  markers so a human sentence quoting one survives the stripper. */
export const REFERENCE_CARDS_OPEN = '---walnut-refs---';
export const REFERENCE_CARDS_CLOSE = '---/walnut-refs---';

/** Is this whole LINE one of our markers? Line-anchored for the same reason the
 *  output-mode stripper is: a human sentence merely MENTIONING the marker does
 *  not start with it, so it survives. */
function isOpenMarker(line: string): boolean {
  return line.trim() === REFERENCE_CARDS_OPEN;
}

function isCloseMarker(line: string): boolean {
  return line.trim() === REFERENCE_CARDS_CLOSE;
}

/**
 * Undo the append for DISPLAY. Every block, from an OPEN marker line through its
 * matching CLOSE line inclusive, plus the ONE blank line we wrote next to it
 * (preferring the one BEFORE, so two of the user's own paragraphs never fuse).
 *
 * A block with no CLOSE marker strips to the end of the text: the only way to
 * see one is a truncated/interrupted delivery, and half a card block is machine
 * text too.
 */
export function stripReferenceCards(text: string): string {
  // Fast path: this runs per user message of every history parse (a whale JSONL
  // has thousands), and the overwhelming majority carry no refs at all.
  if (!text.includes(REFERENCE_CARDS_OPEN) && !text.includes(REFERENCE_CARDS_CLOSE)) {
    return text;
  }

  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isOpenMarker(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    // Swallow through the matching close marker (or to the end when absent).
    let j = i + 1;
    while (j < lines.length && !isCloseMarker(lines[j])) j++;
    i = j; // the close line itself (or one past the end) is consumed
    if (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
    else if (lines[i + 1]?.trim() === '') i++;
  }
  const stripped = out.join('\n').trim();
  // Never strip a message down to NOTHING: our block always accompanies the
  // user's own words, so an "all block" message is someone quoting the literal
  // markers at us — showing it is right, deleting their message is not.
  return stripped === '' ? text : stripped;
}

/**
 * THE projection of a delivered user line to what every display surface shows,
 * with the message hints it carried.
 *
 * A user message can carry message hints (`<system-reminder>` blocks,
 * hints/hint-format.ts) and a reference-card block, and the CLI echoes all of it
 * into its JSONL. Surfaces built from a history parse (web bubbles, the phone, the
 * notification feed, search snippets, auto-titles) must show only what the human
 * typed, so they go through this one function rather than each remembering which
 * strippers exist. `at` is the row's time: only a row from before the hint
 * registry may carry the old bracket lines (output-mode.ts stripLegacyHintLines).
 */
export function projectUserText(text: string, at?: number | string | null): { text: string; hints: CarriedHint[] } {
  // An App's AI-only brief keeps its fold and loses its body FIRST (lib/ai-only-envelope.ts): no
  // parse below may read inside it (a hint or a reference card in its text is its text).
  const parsed = parseHinted(redactAiOnly(text));
  return { text: stripReferenceCards(stripLegacyHintLines(parsed.text, at)), hints: parsed.hints };
}
