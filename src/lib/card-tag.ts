/**
 * The card line: a session that keeps Threads says where a thread stands in its reply itself
 * (experiment threads_reply_tag; 2026-11-25, the user, translated: "it can do two things at once:
 * in what it returns, it adds this tag. Then it is both its reply to me and its reply to the
 * thread"). The reply ends with one line of its own per thread,
 *
 *   <walnut-card thread="th-1a2b3c4d5e6f" state="answered"/>
 *
 * and Walnut writes the thread's card from it (core/org/reply-card.ts) in place of asking the status
 * question about that thread. He never sees the line: every reader of a reply's text drops it
 * (stripCardTags, called by internal-lines.ts stripInternalLines, so the history every client reads,
 * the web chat while it streams, the thread cards, a push and the phone's twin all leave it out;
 * tests/lib/card-tag-readers-guard.test.ts).
 *
 * The line is one only as a line of its own outside a code fence: a quote of it in a sentence or a
 * code block stays text, as the tasks line does (core/org/message-about.ts). It is read only with at
 * most CARD_TAIL_LINES other lines after it (the tasks line, the agent-ack line); one further up is
 * hidden all the same and named as misplaced. Reading is strict, so a line that is wrong is sent
 * back to the session with one reason (core/org/reply-card-stop.ts) and never half applied.
 * Attributes are name="value"; a quote inside a value is &quot;.
 *
 *   state    working | waiting | answered | done, as a line of the status question means them, or
 *            needs (he must decide: with ask, options, kind, why)
 *   title    names an untitled thread          summary  what his card says (the store cuts it)
 *   seen     "yes": he reacted to the answer   merge    this thread joins that open one (alone)
 *   since    with needs, after his message there: what was done about it (thread_update since_you_wrote)
 *   decision with needs on a thread that asked before: "same" (that decision again) or "new" (another
 *            one: Walnut answers this thread and opens the new decision as its own, reply-card-decision.ts)
 * The store's own field names are the same attributes (CARD_ALIASES: its refusals name them).
 *
 * Pure and shared with the web client. The patterns the phone mirrors (ios-native InternalLines.swift)
 * run in Unicode mode and write "any character" out, as internal-lines.ts does.
 */
import { outsideFence } from '../core/org/message-about.js';

export const CARD_TAG_NAME = 'walnut-card';
export const CARD_STATES = ['working', 'waiting', 'answered', 'done', 'needs'] as const;
export type CardState = (typeof CARD_STATES)[number];
/** Card lines one reply may hold: more is a status list, which is what the line replaces. */
export const CARD_MAX = 6;
/** Other lines that may follow a card line: the tasks line, the agent-ack line, one more. */
export const CARD_TAIL_LINES = 3;

const HEAD = `<${CARD_TAG_NAME}`;
/** A line that is a card tag and nothing else: at most three spaces in, through its closing ">". */
const CARD_LINE = /^ {0,3}<walnut-card(?![A-Za-z0-9_-])[^\n\r]*>\s*$/u;
/** While a reply streams in, a last line that began a card tag (a whole one outside code is gone by then). */
const CARD_START = /^<walnut-card(?![A-Za-z0-9_-])/u;
/** From here on a start is this tag's alone. */
const OWN_START = '<walnut-c';
/** How a card line may start: at most three spaces before its first character. */
const CARD_LEAD = /^ {0,3}\S/u;
const ATTRIBUTE = /\s+([a-z_]+)="([^"]*)"/uy;
const THREAD_ID = /^th-[0-9a-f]{6,32}$/u;
const ATTRIBUTES = ['thread', 'state', 'title', 'summary', 'merge', 'seen', 'ask', 'options', 'kind', 'why', 'since', 'decision'] as const;
type Attribute = (typeof ATTRIBUTES)[number];
/**
 * The thread_update fields a decision line stands for, by the op's own name: the store's refusals
 * name these (2026-11-25, a live session told "Pass since_you_wrote" wrote since_you_wrote="..." in
 * its line, and the whole line was dropped), so each reads as the line's attribute.
 */
export const CARD_ALIASES: Readonly<Record<string, Attribute>> = { since_you_wrote: 'since', user_kind: 'kind', user_kind_why: 'why' };
/** What only a decision carries. */
const NEEDS_ONLY: readonly Attribute[] = ['ask', 'options', 'kind', 'why', 'since', 'decision'];
export const CARD_DECISIONS = ['same', 'new'] as const;

/** One card line, read. `state` is absent only with `merge`. */
export interface CardTag {
  thread: string;
  state?: CardState;
  title?: string;
  summary?: string;
  /** The open thread this one joins. */
  merge?: string;
  /** He reacted to the earlier answer in his own words. */
  seen?: boolean;
  /** With needs: what he decides, the choices (the recommended one first), which of his kinds it is and why. */
  ask?: string;
  options?: string[];
  kind?: string;
  why?: string;
  /** With needs, after his message on the thread: what was done about it. */
  since?: string;
  /** With needs on a thread that asked before: the same decision again, or a new one. */
  decision?: (typeof CARD_DECISIONS)[number];
}

/** A line that was not read, by the thread it names (when that much can be read) and whether it asked him to decide. */
export interface CardUnread { thread: string; needs: boolean }

export interface CardRead {
  /** The text without its card lines. */
  text: string;
  /** The lines read, one per thread, in the reply's order. */
  cards: CardTag[];
  /** Why a line was not read: one reason each. */
  errors: string[];
  /** The threads of the lines not read (one unreadable, or one of two naming a thread), where the line names one. */
  unread: CardUnread[];
  /**
   * What stood where a thread id belongs, in the state lines that named no thread ("none", a
   * placeholder, a made-up id): such a line has no thread to write and is no error to send back
   * (2026-11-26, the first hours of real use: 6 of 17 replies with a line named none, all in turns
   * no message of his started, where no note gave the session an id). A decision without a thread
   * id is still an error: it would be lost.
   */
  unnamed: string[];
  /** The reply held a card line, read or not. */
  tagged: boolean;
}

/** The line as a session writes it. */
export function cardTagLine(thread: string, state: CardState = 'answered'): string {
  return `${HEAD} thread="${thread}" state="${state}"/>`;
}

/** The line's form with no thread named, for a rule or a reason. */
export const CARD_TAG_FORM = cardTagLine('th-...');

const bare = (l: string) => l.replace(/\r$/u, '');
/** A value as written: its entities read back (&amp; last, so "&amp;quot;" stays the text "&quot;"). */
const decoded = (v: string) => v.replace(/&quot;/gu, '"').replace(/&apos;/gu, '\'').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');
const oneLine = (v: string) => decoded(v).replace(/\s+/gu, ' ').trim();
const NAMED_THREAD = /\sthread="(th-[0-9a-f]{6,32})"/u;
const ASKS_HIM = /\sstate="needs"/u;

/** What a line that was not read still says: the thread it names and whether it asked him to decide, or null. Pure. */
function unreadOf(raw: string): CardUnread | null {
  const thread = NAMED_THREAD.exec(raw)?.[1];
  return thread ? { thread, needs: ASKS_HIM.test(raw) } : null;
}

/** One card line as its tag, or why it is none. Pure. */
function parseCardLine(raw: string): { card: CardTag } | { error: string; unnamed?: string } {
  const line = raw.trim();
  if (!line.endsWith('/>')) return { error: `a card line is one self-closing tag, written ${CARD_TAG_FORM}` };
  const body = line.slice(HEAD.length, -2);
  const got = new Map<Attribute, string>();
  let at = 0;
  for (;;) {
    ATTRIBUTE.lastIndex = at;
    const m = ATTRIBUTE.exec(body);
    if (!m) break;
    const name = (CARD_ALIASES[m[1]] ?? m[1]) as Attribute;
    if (!ATTRIBUTES.includes(name)) return { error: `"${m[1]}" is no attribute of a card line (${ATTRIBUTES.join(', ')})` };
    if (got.has(name)) return { error: `a card line names ${name} once` };
    got.set(name, oneLine(m[2]));
    at = ATTRIBUTE.lastIndex;
  }
  const rest = body.slice(at).trim();
  if (rest) return { error: `the card line could not be read from "${rest.slice(0, 40)}": each attribute is name="value", and a quote inside a value is &quot;` };
  const thread = got.get('thread') ?? '';
  if (!THREAD_ID.test(thread)) {
    // A decision must reach him: without a thread of his it is a thread of its own, which a line cannot open.
    if (got.get('state') === 'needs') return { error: `a decision line names its thread by id (th- and hex digits), not "${thread}": with no thread of his for it, open one with thread_create` };
    return { error: `thread is a thread id (th- and hex digits), not "${thread}"`, unnamed: thread };
  }
  const merge = got.get('merge');
  if (merge !== undefined) {
    if (!THREAD_ID.test(merge) || merge === thread) return { error: `${thread}: merge names another open thread (th-...), not "${merge}"` };
    if (got.size > 2) return { error: `${thread}: merge goes alone, as <walnut-card thread="${thread}" merge="${merge}"/> (the thread is gone after it)` };
    return { card: { thread, merge } };
  }
  const state = got.get('state') ?? '';
  if (!(CARD_STATES as readonly string[]).includes(state)) return { error: `${thread}: state is ${CARD_STATES.join(', ')}, not "${state}"` };
  const seen = got.get('seen');
  if (seen !== undefined && seen !== 'yes') return { error: `${thread}: seen is "yes" or left out` };
  const needs = state === 'needs';
  const stray = NEEDS_ONLY.filter((a) => got.has(a));
  if (!needs && stray.length) return { error: `${thread}: ${stray.join(', ')} go with state="needs" only` };
  if (needs && !got.get('ask')) return { error: `${thread}: state="needs" takes ask="what he decides"` };
  const decision = got.get('decision');
  if (decision !== undefined && !(CARD_DECISIONS as readonly string[]).includes(decision)) return { error: `${thread}: decision is "same" or "new", not "${decision}"` };
  // Choices split on ";" (a full-width one too), the recommended one first. A choice marked the
  // status answer's way, "Oak (recommended)", is that one: the mark comes off its label and it goes
  // first (2026-11-25, a live session: his button read "Raised bed (recommended)", marked twice).
  const choices = (got.get('options') ?? '').split(/[;\uff1b]/u)
    .map((o) => ({ label: o.replace(/\s*\(recommended\)\s*/gi, ' ').trim(), best: /\(recommended\)/i.test(o) })).filter((o) => o.label);
  const best = choices.findIndex((o) => o.best);
  const options = (best > 0 ? [choices[best], ...choices.slice(0, best), ...choices.slice(best + 1)] : choices).map((o) => o.label);
  const card: CardTag = { thread, state: state as CardState };
  for (const name of ['title', 'summary', 'ask', 'kind', 'why', 'since'] as const) {
    const v = got.get(name);
    if (v) card[name] = v;
  }
  if (decision) card.decision = decision as CardTag['decision'];
  if (seen) card.seen = true;
  if (options.length) card.options = options;
  return { card };
}

/** The lines without the card ones. One blank line stays where a card line left the middle of the text. Pure. */
function withoutCards(lines: readonly string[], card: readonly boolean[]): string {
  const kept: string[] = [];
  let after = false;
  lines.forEach((l, i) => {
    if (card[i]) { after = true; return; }
    if (after && !l.trim() && !(kept[kept.length - 1] ?? '').trim()) return;
    after = false;
    kept.push(l);
  });
  return kept.join('\n').replace(/\s+$/u, '');
}

/**
 * Read the card lines off a reply's text. A card line is a line of its own outside a code fence;
 * the ones that count are among the reply's last lines (at most CARD_TAIL_LINES other lines after
 * each). A thread named twice, more than CARD_MAX lines, a line that cannot be read or one further
 * up gives a reason and no card for it. `text` holds no card line, wherever it stood: a line that
 * showed until more of the reply came would flash up while it streams. Pure.
 */
export function readCardTags(text: string | undefined): CardRead {
  const src = text ?? '';
  if (!src.includes(HEAD)) return { text: src, cards: [], errors: [], unread: [], unnamed: [], tagged: false };
  const lines = src.split('\n');
  const card = cardLinesOf(lines);
  if (!card.includes(true)) return { text: src, cards: [], errors: [], unread: [], unnamed: [], tagged: false };
  const tail: number[] = [];
  let others = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    if (card[i]) { tail.unshift(i); continue; }
    if (++others > CARD_TAIL_LINES) break;
  }
  const errors: string[] = [];
  const unread: CardUnread[] = [];
  const unnamed: string[] = [];
  const read: CardTag[] = [];
  for (const i of tail) {
    const r = parseCardLine(lines[i]);
    if ('card' in r) { read.push(r.card); continue; }
    if (r.unnamed !== undefined) { unnamed.push(r.unnamed); continue; }
    errors.push(r.error);
    const u = unreadOf(lines[i]);
    if (u) unread.push(u);
  }
  const times = new Map<string, number>();
  for (const c of read) times.set(c.thread, (times.get(c.thread) ?? 0) + 1);
  for (const [id, n] of times) {
    if (n < 2) continue;
    errors.push(`${n} card lines name ${id}: one line per thread`);
    unread.push({ thread: id, needs: read.some((c) => c.thread === id && c.state === 'needs') });
  }
  let cards = read.filter((c) => times.get(c.thread) === 1);
  if (tail.length > CARD_MAX) {
    errors.push(`a reply holds at most ${CARD_MAX} card lines, not ${tail.length}`);
    cards = [];
  }
  // A whole card line further up, for a thread the last lines do not name: it was meant, and is in the wrong place.
  const inTail = new Set(tail);
  const named = new Set(read.map((c) => c.thread));
  lines.forEach((l, i) => {
    if (inTail.has(i) || !card[i]) return;
    const r = parseCardLine(l);
    if ('card' in r && !named.has(r.card.thread)) {
      named.add(r.card.thread);
      errors.push(`the card line for ${r.card.thread} is not among the reply's last lines: move it to the end`);
    }
  });
  return { text: withoutCards(lines, card), cards, errors, unread, unnamed, tagged: true };
}

/** Which of these lines are card lines: a line of its own outside a code fence (the one rule, for a reader that goes line by line too: the Brief). Pure. */
export function cardLinesOf(lines: readonly string[]): boolean[] {
  const outside = outsideFence(lines.map(bare));
  return lines.map((l, i) => outside[i] === true && CARD_LINE.test(l));
}

/** Whether the reply holds a card line. */
export function hasCardLine(text: string | undefined): boolean {
  return readCardTags(text).tagged;
}

/**
 * The text as the screen shows it: never a card line. While a reply still streams, a last line that
 * is so far the start of one stays out too, so the tag never flashes up character by character.
 */
export function stripCardTags(text: string, streaming = false): string {
  const read = readCardTags(text);
  const out = read.tagged ? read.text : text;
  if (!streaming) return out;
  const cut = out.lastIndexOf('\n');
  const last = out.slice(cut + 1);
  // A line indented further than a card line may be (four spaces, a tab) is code: it shows as it comes.
  if (!CARD_LEAD.test(last)) return out;
  const tail = last.trim();
  // A shorter start ("<", "<walnut-") may be any tag of Walnut's: the layers that hold those hold it (turn-end-marker.ts, message-about.ts).
  if (!((tail.length >= OWN_START.length && HEAD.startsWith(tail)) || CARD_START.test(tail))) return out;
  // Inside a code block the line is code: it shows as it comes.
  const outside = outsideFence(out.split('\n').map(bare));
  return outside[outside.length - 1] ? out.slice(0, Math.max(0, cut)) : out;
}
