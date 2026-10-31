/**
 * The wire format of a message hint: how Walnut's own text rides a message to the
 * model, and how every display surface takes it back off. Pure, no imports: the web
 * client uses this same file (`@open-walnut/hint-format`), so the emitter and every
 * reader can never disagree about the shape.
 *
 * A hint is one Claude Code style block, kept apart from the user's text:
 *
 *   <system-reminder>
 *   Walnut (reply-language): Talk to the user in Chinese; ...
 *   </system-reminder>
 *
 * The first words name Walnut and the hint's kind (plus an optional argument, the
 * question number), so the model and a person can tell Walnut's hints from Claude
 * Code's own reminders, and the UI can say which hints a message carried.
 *
 * Hints are told apart by STRUCTURE, never by matching the user's words: every
 * composed message has its non-hint text escaped first (`<system-reminder` becomes
 * `&lt;system-reminder`, and an already escaped form gains one more `amp;`, so the
 * mapping is reversible), which means every unescaped block left in a composed
 * message is one Walnut wrote. Display removes those blocks and undoes the escape,
 * so whatever the user typed, a literal `<system-reminder>` or `[Rich output ...]`
 * included, shows exactly as typed.
 */

export const HINT_TAG = 'system-reminder';
/** First word of every Walnut hint body. */
export const HINT_AUTHOR = 'Walnut';

/** A hint as a message carried it (what the UI lists). */
export interface CarriedHint {
  kind: string;
  /** The kind's argument when it has one (a question's number). */
  arg?: string;
  /** The hint's text after `Walnut (kind):`. */
  text: string;
}

const KIND_RE = /^[a-z][a-z0-9-]{0,40}$/;
const ARG_RE = /^[A-Za-z0-9._-]{1,32}$/;

/** `<system-reminder` and `</system-reminder`, plain or already escaped (`&lt;`, `&amp;lt;`, ...). */
const TAG_TOKEN = /(<|&(?:amp;)*lt;)(\/?)(system-reminder)/gi;

/** Make every system-reminder tag in `text` inert, reversibly. */
export function escapeHintTags(text: string): string {
  if (!/system-reminder/i.test(text)) return text;
  return text.replace(TAG_TOKEN, (_m, open: string, slash: string, name: string) =>
    `${open === '<' ? '&lt;' : `&amp;${open.slice(1)}`}${slash}${name}`);
}

/** Undo escapeHintTags. */
export function unescapeHintTags(text: string): string {
  if (!/system-reminder/i.test(text)) return text;
  return text.replace(TAG_TOKEN, (m, open: string, slash: string, name: string) => {
    if (open === '<') return m;
    return `${open === '&lt;' ? '<' : `&${open.slice('&amp;'.length)}`}${slash}${name}`;
  });
}

/** One hint block. The body's own tags are escaped so it can never close the block early. */
export function renderHintBlock(kind: string, text: string, arg?: string): string {
  if (!KIND_RE.test(kind)) throw new Error(`invalid hint kind: ${kind}`);
  const label = arg !== undefined && ARG_RE.test(arg) ? `${kind} ${arg}` : kind;
  return `<${HINT_TAG}>\n${HINT_AUTHOR} (${label}): ${escapeHintTags(text.trim())}\n</${HINT_TAG}>`;
}

export interface ComposedHints {
  /** Blocks that go before the message, already rendered. */
  before: readonly string[];
  /** Blocks that go after it. */
  after: readonly string[];
}

/**
 * The text the model receives: the before blocks, the escaped message, the after
 * blocks, one blank line between parts. With no blocks the message is still
 * escaped, so a hint-free message keeps the invariant every reader relies on.
 */
export function composeHinted(message: string, hints: ComposedHints): string {
  const body = escapeHintTags(message);
  const parts: string[] = [];
  if (hints.before.length) parts.push(hints.before.join('\n'));
  parts.push(body);
  if (hints.after.length) parts.push(hints.after.join('\n'));
  return parts.join('\n\n');
}

/**
 * A Walnut hint block anywhere in the text. Tolerates blank lines inside it: an
 * older daemon re-joins a reply tail's lines with blank lines between them.
 */
const BLOCK_RE = /<system-reminder>\s*Walnut \(([a-z][a-z0-9-]{0,40})(?: ([A-Za-z0-9._-]{1,32}))?\): ?([\s\S]*?)\s*<\/system-reminder>/g;

export interface ParsedHinted {
  /** What the user wrote, as typed. */
  text: string;
  /** Every Walnut hint the message carried, in order. */
  hints: CarriedHint[];
}

/**
 * Take a delivered message apart: the hints out, the escape undone. A text with no
 * Walnut block comes back unchanged except for the unescape. Every send path escapes
 * (the queue, the first message, an edit), so the unescape gives back what was typed;
 * a row an older Walnut wrote unescaped shows a typed `&lt;system-reminder` as `<`.
 */
export function parseHinted(raw: string): ParsedHinted {
  if (!raw.includes('system-reminder')) return { text: raw, hints: [] };
  const hints: CarriedHint[] = [];
  const segments: string[] = [];
  let last = 0;
  BLOCK_RE.lastIndex = 0;
  for (let m = BLOCK_RE.exec(raw); m; m = BLOCK_RE.exec(raw)) {
    hints.push({
      kind: m[1],
      ...(m[2] !== undefined ? { arg: m[2] } : {}),
      text: unescapeHintTags(m[3].replace(/\n\s*\n/g, '\n').trim()),
    });
    segments.push(raw.slice(last, m.index));
    last = m.index + m[0].length;
  }
  if (!hints.length) return { text: unescapeHintTags(raw), hints };
  segments.push(raw.slice(last));
  // The separators composeHinted wrote next to a block go with it (at most one
  // blank line each side); the user's own text in between is kept byte for byte,
  // and two pieces a block stood between (a merged batch) stay two paragraphs.
  const kept = segments
    .map((s, i) => {
      let t = s;
      if (i > 0) t = t.replace(/^[ \t]*\n?[ \t]*\n?/, '');
      if (i < segments.length - 1) t = t.replace(/\n?[ \t]*\n?[ \t]*$/, '');
      return t;
    })
    .filter((s) => s.trim() !== '');
  const text = unescapeHintTags(kept.join('\n\n').trim());
  // Never strip a message down to nothing: a hint always comes with words.
  return { text: text === '' ? unescapeHintTags(raw) : text, hints };
}

export interface SplitHinted {
  /** Blocks ahead of the message, as written. */
  before: string[];
  /** The message, unescaped (what the user typed). */
  text: string;
  /** Blocks after it, as written. */
  after: string[];
  kinds: string[];
}

/**
 * A message that was composed upstream (the companion adds the voice hint before it
 * relays a phone send), taken apart so a second composition keeps its blocks where
 * they were instead of escaping them into plain text. Only the exact blocks in
 * `trusted` count (the caller renders what the upstream sender writes), so a block a
 * person typed, of any kind or wording, is never trusted. Null when there is none,
 * or when any block in the text is not one of them.
 */
export function splitHinted(raw: string, trusted: readonly string[]): SplitHinted | null {
  if (!hasHintBlock(raw)) return null;
  BLOCK_RE.lastIndex = 0;
  const all = [...raw.matchAll(BLOCK_RE)];
  if (!all.length || all.some((m) => !trusted.includes(m[0]))) return null;
  const before: string[] = [];
  const after: string[] = [];
  const kinds: string[] = [];
  let seenText = false;
  let last = 0;
  BLOCK_RE.lastIndex = 0;
  for (let m = BLOCK_RE.exec(raw); m; m = BLOCK_RE.exec(raw)) {
    if (raw.slice(last, m.index).trim()) seenText = true;
    (seenText ? after : before).push(m[0]);
    kinds.push(m[1]);
    last = m.index + m[0].length;
  }
  return { before, text: parseHinted(raw).text, after, kinds };
}

/**
 * A queued row whose words are replaced (the person edits a message still waiting,
 * a newer notice takes an older one's place): the row's own hint blocks stay where
 * they were, since their state is already recorded as told, and the new words are
 * escaped like any composed text.
 */
export function replaceHintedText(composed: string, text: string): string {
  if (!hasHintBlock(composed)) return composeHinted(text, { before: [], after: [] });
  const before: string[] = [];
  const after: string[] = [];
  let seenText = false;
  let last = 0;
  BLOCK_RE.lastIndex = 0;
  for (let m = BLOCK_RE.exec(composed); m; m = BLOCK_RE.exec(composed)) {
    if (composed.slice(last, m.index).trim()) seenText = true;
    (seenText ? after : before).push(m[0]);
    last = m.index + m[0].length;
  }
  return composeHinted(text, { before, after });
}

/** Does the text already carry a Walnut hint block (it went through composition)? */
export function hasHintBlock(raw: string): boolean {
  if (!raw.includes('system-reminder')) return false;
  BLOCK_RE.lastIndex = 0;
  return BLOCK_RE.test(raw);
}

/**
 * Text a person reads that may still hold Walnut's blocks inside it (a hook's added
 * context restates the hints after a compaction, a CLI-injected Walnut message
 * carries them): each block becomes what `line` says for its hint, in place. The
 * words around the blocks are left exactly as they are: this text was never
 * composed (a hook's context holds memory and notes verbatim), or a later read
 * undoes the escape once (projectUserText), so unescaping here would change words
 * nobody escaped. A hint's own text is unescaped, as parseHinted does.
 */
export function replaceHintBlocks(raw: string, line: (hint: CarriedHint) => string): string {
  if (!raw.includes('system-reminder')) return raw;
  let out = '';
  let last = 0;
  BLOCK_RE.lastIndex = 0;
  for (let m = BLOCK_RE.exec(raw); m; m = BLOCK_RE.exec(raw)) {
    const [, kind, arg, body] = m;
    out += raw.slice(last, m.index);
    out += line({ kind, ...(arg !== undefined ? { arg } : {}), text: unescapeHintTags(body.replace(/\n\s*\n/g, '\n').trim()) });
    last = m.index + m[0].length;
  }
  return out + raw.slice(last);
}
