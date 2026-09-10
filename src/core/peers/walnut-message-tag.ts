/**
 * Walnut envelope v2: the ONE place a `<walnut-message …>` tag is serialized.
 *
 * Every delivery that carries something other than the human's own words into a
 * CLI's stdin (another session's note, a routed reply, a Walnut status notice)
 * is one tag: attributes carry the provenance, the body carries the words.
 *
 * Anti-spoof rule, and the reason the body is escaped at all: a body can never
 * contain `<walnut-message` or `</walnut-message`, so "from the open tag to the
 * FIRST `\n</walnut-message>`" is always the whole body. Text inside a body can
 * therefore never become framing, which is the same guarantee the old sha1
 * fence bought with three sentences of prose per message.
 */

/** Fixed print order. An attribute appears only when it has a value. */
const ATTR_ORDER = [
  'from', 'from-session', 'from-task', 'host',
  'about', 'about-session', 'about-task',
  'request', 'asked', 'outcome', 'anonymous', 'note',
] as const;

export type WalnutMessageAttrName = typeof ATTR_ORDER[number];
export type WalnutMessageAttrs = Partial<Record<WalnutMessageAttrName, string | undefined>>;
export type WalnutMessageKind = 'peer-note' | 'reply' | 'notification';

const TAG = 'walnut-message';
/** Sender titles are attacker-controlled (any session can task_update one). */
const TITLE_MAX = 80;

/** XML attribute rules, plus: any whitespace run becomes one space, trimmed. */
export function escapeAttr(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Only the leading `<` of the two tag sequences is touched; a body is
 *  otherwise verbatim, INCLUDING the tag name's original case (rewriting it
 *  would edit the sender's words, and would not round-trip). A body that
 *  already holds the escaped form gets one more `&amp;` so the two never
 *  collide on the wire: without that, "&lt;walnut-message" typed by a sender
 *  would decode into a real tag on the reader's side. */
export function escapeBody(body: string): string {
  return body
    .replace(/&lt;(\/?)(walnut-message)/gi, '&amp;lt;$1$2')
    .replace(/<(\/?)(walnut-message)/gi, '&lt;$1$2');
}

/** Exact inverse of escapeBody (reverse order of its two rules). */
export function unescapeBody(body: string): string {
  return body
    .replace(/&lt;(\/?)(walnut-message)/gi, '<$1$2')
    .replace(/&amp;lt;(\/?)(walnut-message)/gi, '&lt;$1$2');
}

function unescapeAttr(value: string): string {
  // &amp; LAST, or an escaped "&amp;lt;" would decode twice.
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * `Title [8hex]` exactly as envelopes and `session_list` print it, and exactly
 * what `session_send`'s `to` accepts back. The title is flattened and capped
 * BEFORE the id suffix, so a long or multi-line title can never push the id off
 * the line it identifies. No title → just `[8hex]`.
 */
export function sessionHandle(
  title: string | null | undefined,
  sessionId: string | null | undefined,
): string {
  const flat = (title ?? '').replace(/\s+/g, ' ').trim();
  // Cap by code point, not UTF-16 unit: slicing inside a surrogate pair puts a
  // lone surrogate on the wire (U+FFFD after UTF-8, rejected by strict JSON).
  const points = [...flat];
  const capped = points.length > TITLE_MAX ? `${points.slice(0, TITLE_MAX).join('')}…` : flat;
  const short = (sessionId ?? '').trim().slice(0, 8);
  if (capped && short) return `${capped} [${short}]`;
  if (capped) return capped;
  return short ? `[${short}]` : '';
}

export function buildWalnutMessage(input: {
  kind: WalnutMessageKind;
  attrs?: WalnutMessageAttrs;
  body: string;
}): string {
  const attrs = [`kind="${escapeAttr(input.kind)}"`];
  for (const name of ATTR_ORDER) {
    const value = escapeAttr(input.attrs?.[name] ?? '');
    if (value) attrs.push(`${name}="${value}"`);
  }
  return `<${TAG} ${attrs.join(' ')}>\n${escapeBody(input.body)}\n</${TAG}>`;
}

export interface ParsedWalnutMessage {
  kind: string;
  attrs: Record<string, string>;
  body: string;
  /** The exact slice the envelope occupied, open tag through close tag. */
  raw: string;
}

const OPEN_TAG = new RegExp(`<${TAG}((?:\\s+[a-z-]+="[^"]*")*)\\s*>\\n`, 'i');
const CLOSE_TAG = `\n</${TAG}>`;

/**
 * Read back the FIRST envelope in `text`, this serializer's own inverse, used
 * to prove a body cannot open or close a tag. The chat's provenance card has
 * its own parser (it also understands the pre-v2 prose shapes); this one exists
 * so the server can check its own round trip.
 */
export function parseWalnutMessage(text: string): ParsedWalnutMessage | null {
  const open = OPEN_TAG.exec(text);
  if (!open) return null;
  const bodyStart = open.index + open[0].length;
  const closeAt = text.indexOf(CLOSE_TAG, bodyStart);
  if (closeAt === -1) return null;
  const attrs: Record<string, string> = {};
  for (const m of (open[1] ?? '').matchAll(/([a-z-]+)="([^"]*)"/g)) {
    attrs[m[1]] = unescapeAttr(m[2]);
  }
  return {
    kind: attrs.kind ?? '',
    attrs,
    body: unescapeBody(text.slice(bodyStart, closeAt)),
    raw: text.slice(open.index, closeAt + CLOSE_TAG.length),
  };
}
