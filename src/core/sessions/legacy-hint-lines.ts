/**
 * The bracket lines Walnut wrote into messages before the hint registry, and the display stripper
 * that takes them off old rows (`[Rich output mode: …]`, `[Rich output mode is still on …]`,
 * `[Reply language: …]`, `[Voice reply: …]`).
 *
 * No I/O on purpose: the transcript parser (history-parse.ts) calls the stripper, and the session
 * daemon bundles that parser. The cutoff (when this Walnut home first ran the registry) is read
 * from disk by output-mode.ts loadLegacyHintCutoff on the server, which sets it here. A daemon
 * serves several servers and clients, so it never sets it: a ready view's parse passes the asking
 * server's value as a parse option (`legacyHintCutoffMs`), which holds for that one synchronous
 * parse only (withLegacyHintCutoff).
 */

/** Opening literal of the pre-registry edge instruction, kept to recognise old rows. */
export const OUTPUT_MODE_INSTRUCTION_MARKER = '[Rich output mode: ';

/** Opening literal of the pre-registry standing reminder, kept to recognise old rows. */
export const OUTPUT_MODE_REMINDER_MARKER = '[Rich output mode is still on';

/** Opening literal of the pre-registry reply-language line, kept to recognise old rows. */
export const REPLY_LANGUAGE_MARKER = '[Reply language: ';

/**
 * Rows written before this (ms) may carry the pre-registry bracket lines; a row after it never
 * does. Until the server's read lands it is this process's start, which is never earlier.
 */
let legacyHintLinesUntil = Date.now();
/** A cutoff in force for one synchronous call (withLegacyHintCutoff), over the process's own. */
let scopedCutoff: number | undefined;

/** The current cutoff (ms). */
export function legacyHintCutoff(): number {
  return scopedCutoff ?? legacyHintLinesUntil;
}

/**
 * Run `fn` with `ms` as the cutoff, then put back what was there. `fn` must be synchronous: no
 * other code runs inside it, so no other caller ever reads this cutoff, and nothing is left set
 * after it (even when it throws). A missing or non-finite `ms` runs `fn` with the process's own.
 */
export function withLegacyHintCutoff<T>(ms: number | undefined, fn: () => T): T {
  if (ms === undefined || !Number.isFinite(ms)) return fn();
  const prev = scopedCutoff;
  scopedCutoff = ms;
  try {
    return fn();
  } finally {
    scopedCutoff = prev;
  }
}

/** Set the cutoff (ms); returns it. Ignores a value that is not a finite number. */
export function setLegacyHintCutoff(ms: number): number {
  if (Number.isFinite(ms)) legacyHintLinesUntil = ms;
  return legacyHintLinesUntil;
}

/** The phone's pre-registry voice line. */
const VOICE_REPLY_MARKER = '[Voice reply: ';

/** Is this whole LINE one of the old bracket lines? Line-anchored, as before. */
function isLegacyHintLine(line: string): boolean {
  const t = line.trim();
  if (t.startsWith(OUTPUT_MODE_INSTRUCTION_MARKER)) return true;
  // The phone's voice-reply line rides the same way (voice-reply.ts), so the one
  // display choke point strips it too.
  if (t.startsWith(VOICE_REPLY_MARKER) && t.endsWith(']')) return true;
  if (t.startsWith(REPLY_LANGUAGE_MARKER) && t.endsWith(']')) return true;
  return t.startsWith(OUTPUT_MODE_REMINDER_MARKER) && t.endsWith(']');
}

/**
 * Take the old bracket lines off a row written before the hint registry started
 * (`at`: the row's time, ms or ISO). A newer row, or one with no time, is returned
 * as it is: the user's own words are never matched against a pattern.
 * Display-only, like the hint parse (src/core/hints/hint-format.ts).
 */
export function stripLegacyHintLines(text: string, at?: number | string | null): string {
  const ms = typeof at === 'string' ? Date.parse(at) : at;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms >= legacyHintCutoff()) return text;
  // Fast path: the overwhelming majority of lines have neither marker, and this
  // runs per user message of every parse (a whale JSONL has thousands).
  if (
    !text.includes(OUTPUT_MODE_INSTRUCTION_MARKER)
    && !text.includes(OUTPUT_MODE_REMINDER_MARKER)
    && !text.includes(VOICE_REPLY_MARKER)
    && !text.includes(REPLY_LANGUAGE_MARKER)
  ) {
    return text;
  }

  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isLegacyHintLine(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    // Also swallow the ONE blank line we wrote next to it, preferring the one
    // BEFORE so two of the user's own paragraphs never fuse into one.
    if (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
    else if (lines[i + 1]?.trim() === '') i++;
  }
  const stripped = out.join('\n').trim();
  // Never strip a message down to NOTHING: our wrapper always accompanies the
  // user's own words, so an "all wrapper" message is someone quoting the literal
  // text at us — showing it is right, deleting their message is not.
  return stripped === '' ? text : stripped;
}
