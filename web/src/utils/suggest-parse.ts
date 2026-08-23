/**
 * `<suggest>` action-card parser — assistant text → ordered render segments.
 *
 * The Personal AI may wrap a suggestion in a card so the user can act on it with
 * one click instead of typing a follow-up:
 *
 *   <suggest title="Triage this" multi>
 *     Some **markdown** explaining the choice.
 *     <action tool="task_focus_tier_set" args='{"id":"abc","tier":"focus"}' label="Put to Focus" style="primary"/>
 *     <action dismiss label="Ignore"/>
 *   </suggest>
 *
 * Three constraints shape this file:
 *
 * 1. It runs BEFORE markdown. DOMPurify keeps the text content of unknown tags,
 *    so an unparsed card degrades into loose prose ("Put to Focus Ignore") —
 *    silently wrong rather than visibly broken. Splitting the message into
 *    segments and rendering the card as a real React component is the only way
 *    to keep per-button state.
 * 2. Text arrives as growing streaming deltas, so a card whose `</suggest>` has
 *    not landed yet must be HIDDEN to end-of-text, never half-rendered (the same
 *    rule stripLeakedToolCalls follows for leaked tool syntax). Hiding needs
 *    corroborating evidence though (looksLikeStreamingCard): a prose mention of
 *    the tag never gets a closer, and hiding there deletes the rest of the answer.
 * 3. It is deliberately dependency-free. Importing codeRegions() from
 *    '@/utils/markdown' would drag `marked` + `dompurify` into every consumer
 *    (and into a test tier that cannot resolve them), for a code-skip that here
 *    only needs fences, indented blocks, and inline spans.
 *
 * Never scan unguarded: the `includes('<suggest')` precheck comes first, because
 * an unbounded per-message scan is what froze page boot for 10-16s in 2026-07.
 *
 * Degradation is deliberate: only the web console parses cards. The phone's v1
 * chat projection, notification bodies, and search snippets keep the raw text,
 * so the prose around a card has to stand on its own (the prompt contract says
 * exactly that). Nothing is lost, only the buttons.
 */

export interface SuggestAction {
  /** Stable within the card — the persistence key for "already clicked". */
  id: string;
  /** A dismiss action just collapses the card; it calls no op. */
  dismiss: boolean;
  /** Registry op name (`tool="task_delete"`). Absent on a dismiss action. */
  tool?: string;
  args: Record<string, unknown>;
  /** Set when `args` was present but not parseable as a JSON object. */
  argsError?: string;
  label: string;
  style: 'primary' | 'danger' | 'default';
  /** Inline confirmation prompt shown before the op fires. */
  confirm?: string;
}

export interface SuggestCardSpec {
  /** Deterministic across reloads: derived from the card's own text, the message
   *  text that precedes it, and its occurrence index (see parseCard). */
  id: string;
  title?: string;
  /** Each action stays independently clickable (default: one action per card). */
  multi: boolean;
  /** Card never settles — buttons re-arm after each result. */
  sticky: boolean;
  /** Markdown body (the card's inner text with the action tags removed). */
  body: string;
  actions: SuggestAction[];
}

export type SuggestSegment =
  | { kind: 'md'; text: string }
  | { kind: 'card'; card: SuggestCardSpec };

const OPEN_TAG = '<suggest';
const ACTION_TAG = '<action';
/** Trailing partial open tag mid-stream (`…<suggest tit`), cut from the tail. */
const PARTIAL_OPEN_RE = /<suggest\b[^>]*$/i;

// ── Tag scanning ─────────────────────────────────────────────────────────────

/**
 * End index (exclusive) of the tag opened at `start`, quote-aware so a `>`
 * inside an attribute value (very likely in `args` JSON) cannot end the tag
 * early. Returns -1 when the tag is still arriving.
 */
function tagEnd(text: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i + 1;
  }
  return -1;
}

const ENTITIES: Array<[RegExp, string]> = [
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
  [/&#0*39;/g, "'"],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&amp;/g, '&'], // last, so `&amp;quot;` survives as a literal `&quot;`
];

function decodeEntities(raw: string): string {
  let out = raw;
  for (const [re, ch] of ENTITIES) out = out.replace(re, ch);
  return out;
}

/** Attribute map for one tag's raw attribute text. Bare names map to `true`. */
function parseAttrs(raw: string): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  const re = /([A-Za-z_][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const value = m[2] ?? m[3] ?? m[4];
    out[m[1].toLowerCase()] = value === undefined ? true : decodeEntities(value);
  }
  return out;
}

function attrString(attrs: Record<string, string | true>, name: string): string | undefined {
  const v = attrs[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function attrFlag(attrs: Record<string, string | true>, name: string): boolean {
  const v = attrs[name];
  return v === true || v === 'true' || v === '';
}

// ── Code regions (so a doc that SHOWS the syntax renders it literally) ───────

/**
 * Ranges markdown renders as code. Fences are 3+ backticks/tildes closed only
 * by the same char at >= the same length, so a ````-wrapped ``` sample stays
 * protected end to end (the 2026-07-25 single-regex bug). Indented blocks need
 * a preceding blank line — over-protecting here would HIDE a real card, which is
 * worse than rendering a literal one.
 */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let fence: { char: string; len: number; start: number } | null = null;
  let prevBlank = true;
  let pos = 0;
  for (const line of text.split('\n')) {
    const start = pos;
    const end = start + line.length;
    pos = end + 1; // consumed '\n'
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence.char && f[1].length >= fence.len) {
        ranges.push([fence.start, end]);
        fence = null;
      }
      continue;
    }
    if (f) { fence = { char: f[1][0], len: f[1].length, start }; prevBlank = false; continue; }
    if (prevBlank && /^ {4,}\S/.test(line)) ranges.push([start, end]);
    prevBlank = line.trim() === '';
  }
  if (fence) ranges.push([fence.start, text.length]); // unclosed fence runs to EOF

  const inline = /`[^`\n]+`/g;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(text)) !== null) {
    const at = m.index;
    if (!ranges.some(([s, e]) => at >= s && at < e)) ranges.push([at, at + m[0].length]);
  }
  return ranges;
}

function makeSkip(text: string): (index: number) => boolean {
  const ranges = codeRanges(text);
  return (index: number) => ranges.some(([s, e]) => index >= s && index < e);
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** djb2 — the same cheap digest the diff view uses; no new dependency. */
function digest(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function parseAction(raw: string, index: number): SuggestAction {
  const attrs = parseAttrs(raw);
  const tool = attrString(attrs, 'tool');
  const styleRaw = attrString(attrs, 'style');
  const confirm = attrString(attrs, 'confirm');

  let args: Record<string, unknown> = {};
  let argsError: string | undefined;
  const argsRaw = attrString(attrs, 'args');
  if (argsRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(argsRaw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        argsError = 'args must be a JSON object';
      } else {
        args = parsed as Record<string, unknown>;
      }
    } catch (err) {
      argsError = `args is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    id: `a${index}`,
    // No tool name means there is nothing to invoke, so the button can only be a
    // dismiss — whether or not the model spelled the `dismiss` attribute.
    dismiss: tool === undefined,
    ...(tool ? { tool } : {}),
    args,
    ...(argsError ? { argsError } : {}),
    label: attrString(attrs, 'label') ?? tool ?? 'Dismiss',
    style: styleRaw === 'primary' || styleRaw === 'danger' ? styleRaw : 'default',
    ...(confirm ? { confirm } : {}),
  };
}

function parseCard(attrRaw: string, inner: string, occurrence: number, before: string): SuggestCardSpec {
  const attrs = parseAttrs(attrRaw);
  const skip = makeSkip(inner);
  const lower = inner.toLowerCase();
  const actions: SuggestAction[] = [];
  let body = '';
  let cursor = 0;
  let at = 0;

  while (at < inner.length) {
    const found = lower.indexOf(ACTION_TAG, at);
    if (found < 0) break;
    const end = tagEnd(inner, found);
    if (end < 0) break; // tag still streaming
    at = end;
    if (skip(found)) continue; // a fenced sample that SHOWS the syntax
    body += inner.slice(cursor, found);
    cursor = end;
    // `<action …></action>` — swallow the redundant closer so it never leaks
    // into the body as prose.
    const closer = /^\s*<\/action\s*>/i.exec(inner.slice(cursor));
    if (closer) { cursor += closer[0].length; at = cursor; }
    actions.push(parseAction(inner.slice(found + ACTION_TAG.length, end - 1).replace(/\/\s*$/, ''), actions.length));
  }
  body += inner.slice(cursor);

  const title = attrString(attrs, 'title');
  const signature = [
    title ?? '',
    body.trim(),
    actions.map((a) => `${a.tool ?? 'dismiss'}|${JSON.stringify(a.args)}|${a.label}`).join(''),
  ].join(' ');

  return {
    // Identity = where the card sits + what it says. The occurrence index keeps
    // two identical cards in ONE message distinct; `before` (the message text
    // preceding this card) keeps the same card in DIFFERENT messages distinct —
    // without it, a repeated suggestion inherited the earlier one's receipt and
    // rendered already-settled over an op the user never ran.
    //
    // Both parts stay stable across a reload, which the persisted receipt depends
    // on: the message text is durable in chat history, and `before` is complete
    // by the time the card renders, so a still-growing tail never renumbers a
    // card the user can already click. (The message TIMESTAMP would look like the
    // obvious identity here and is not usable: a live turn's optimistic message
    // is stamped by the browser, the stored entry by the server, so mixing it in
    // would lose every receipt on the next reload.)
    id: `sc-${digest(`${digest(before)} ${signature}`)}-${occurrence}`,
    ...(title ? { title } : {}),
    multi: attrFlag(attrs, 'multi'),
    sticky: attrFlag(attrs, 'sticky'),
    body: body.trim(),
    actions,
  };
}

function pushMd(segments: SuggestSegment[], text: string): void {
  if (text.trim() !== '') segments.push({ kind: 'md', text });
}

/**
 * Attributes only a real card carries. A prose mention ("wrap it in a <suggest>
 * card") has none, which is what tells the two apart before any closer exists.
 */
const CARD_ATTRS = ['title', 'multi', 'sticky'];

/**
 * Is an unclosed open tag a card that is still streaming, or just prose?
 *
 * It matters because the two get opposite treatment and only one is recoverable:
 * a streaming card must be hidden to end-of-text, while hiding a prose mention
 * DELETES the rest of the answer — and permanently, since history replay runs
 * this same parse over the stored text and no closer is ever coming. So hide only
 * with corroborating evidence: a card attribute on the open tag, or an `<action`
 * after it. Otherwise the tag stays in the markdown and DOMPurify drops it,
 * leaving the answer intact.
 */
function looksLikeStreamingCard(attrRaw: string, rest: string): boolean {
  const attrs = parseAttrs(attrRaw);
  if (CARD_ATTRS.some((name) => name in attrs)) return true;
  return rest.toLowerCase().includes(ACTION_TAG);
}

function findClose(
  text: string,
  from: number,
  skip: (index: number) => boolean,
): { at: number; len: number } | null {
  const re = /<\/suggest\s*>/gi;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!skip(m.index)) return { at: m.index, len: m[0].length };
  }
  return null;
}

/**
 * Split assistant text into markdown runs and cards, in order.
 *
 * A message with no card returns a single `md` segment, so the caller's render
 * path is byte-identical for the overwhelmingly common case.
 */
export function splitSuggestSegments(text: string): SuggestSegment[] {
  if (!text) return [];
  if (!text.includes(OPEN_TAG)) return [{ kind: 'md', text }];

  const skip = makeSkip(text);
  const lower = text.toLowerCase();
  const segments: SuggestSegment[] = [];
  let cursor = 0;
  let at = 0;
  let occurrence = 0;

  while (at < text.length) {
    const open = lower.indexOf(OPEN_TAG, at);
    if (open < 0) break;
    // `<suggestion>` and friends are ordinary prose, not a card.
    const after = text[open + OPEN_TAG.length];
    if (after !== undefined && !/[\s/>]/.test(after)) { at = open + OPEN_TAG.length; continue; }

    const openEnd = tagEnd(text, open);
    if (openEnd < 0) break; // partial open tag — trimmed off the tail below
    if (skip(open)) { at = openEnd; continue; }

    const attrRaw = text.slice(open + OPEN_TAG.length, openEnd - 1);
    // `<suggest/>` is an empty card, not an unterminated one — skip the tag
    // instead of hiding everything after it (that would eat a real answer).
    if (/\/\s*$/.test(attrRaw)) { at = openEnd; continue; }

    const close = findClose(text, openEnd, skip);
    if (!close) {
      // No closer: either a card still arriving (hide to end of text) or an
      // ordinary prose mention of the tag (keep the answer) — see
      // looksLikeStreamingCard.
      if (!looksLikeStreamingCard(attrRaw, text.slice(openEnd))) { at = openEnd; continue; }
      pushMd(segments, text.slice(cursor, open));
      return segments;
    }
    pushMd(segments, text.slice(cursor, open));
    segments.push({
      kind: 'card',
      card: parseCard(attrRaw, text.slice(openEnd, close.at), occurrence++, text.slice(0, open)),
    });
    cursor = close.at + close.len;
    at = cursor;
  }

  let tail = text.slice(cursor);
  const partial = tail.search(PARTIAL_OPEN_RE);
  if (partial >= 0 && !skip(cursor + partial)) tail = tail.slice(0, partial);
  pushMd(segments, tail);
  return segments;
}

/** True when the text carries at least one complete card (cheap UI precheck). */
export function hasSuggestCard(text: string): boolean {
  return text.includes(OPEN_TAG) && splitSuggestSegments(text).some((s) => s.kind === 'card');
}
