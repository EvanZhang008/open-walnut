/**
 * The strict Ask here protocol: a question's answer is exactly the text inside
 * its `<walnut-ask-answer>` tag (2026-11-03, the user: "we must make it strict
 * ... the thread-id and thread name in a html tag format ... otherwise we keep
 * getting this no answered").
 *
 * A question's send carries the `question` message hint, whose text names it
 * `<walnut-ask thread="6.1" name="NAME">` and asks the model to put its answer
 * inside `<walnut-ask-answer thread="6.1" name="NAME">` ... `</walnut-ask-answer>`
 * (src/core/sessions/ask-thread.ts). The thread id is the question's path: its
 * number on the main conversation, `6.1` for a question asked inside question 6.
 * The name is fixed at the question's first send and repeated by every
 * follow-up's hint.
 *
 * A question is STRICT when its row's hint asks for the tag. Its answer is read
 * from the tag alone, wherever the tag sits after the question (the same turn, a
 * later turn, after a compaction, one message answering two questions), and only
 * when both the id and the name match the question's own hint. Text outside a
 * tag is never its answer. Rows from before this (a `[Qn]` reply tag) keep the
 * old rules (question-tag.ts, tagged-reply-split.ts).
 *
 * Pure: unit tested in tests/web/ask-answer.test.ts.
 */

/** A thread id: 6, 6.1, 6.1.2 (the server's ASK_THREAD_RE). */
export const ASK_THREAD_RE = /^\d{1,5}(?:\.\d{1,5}){0,5}$/;

const OPEN_TAG = /<walnut-ask-answer\b([^<>]*)>/gi;
const CLOSE_TAG = /<\/walnut-ask-answer\s*>/gi;
const ANY_TAG = /<\/?walnut-ask-answer\b[^<>]*>/gi;
const ATTR = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/g;

/** The attributes of a tag's inside (`thread="6" name="x"`), names lowercased. */
function attrsOf(inside: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of inside.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, (m[2] ?? m[3] ?? m[4] ?? '').trim());
  }
  return out;
}

/** [start, end) of each fenced code block (``` or ~~~ opening a line); an unclosed one runs to the end. */
export function fenceSpans(text: string): Array<[number, number]> {
  if (!text.includes('```') && !text.includes('~~~')) return [];
  const spans: Array<[number, number]> = [];
  let open: { at: number; mark: string; len: number } | null = null;
  for (const m of text.matchAll(/^[ \t]{0,3}(`{3,}|~{3,})/gm)) {
    if (m.index === undefined) continue;
    if (!open) open = { at: m.index, mark: m[1][0], len: m[1].length };
    else if (m[1][0] === open.mark && m[1].length >= open.len) { spans.push([open.at, m.index + m[0].length]); open = null; }
  }
  if (open) spans.push([open.at, text.length]);
  return spans;
}

/**
 * [start, end) of every code span: the fenced blocks, and inline code outside
 * them (a run of backticks closed by a run of the same length on the same line,
 * CommonMark's rule). A tag quoted in code is text: it files nothing, and the
 * chat shows it as written.
 */
export function codeSpans(text: string): Array<[number, number]> {
  const fences = fenceSpans(text);
  if (!text.includes('`')) return fences;
  const out = [...fences];
  let lineStart = 0;
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl < 0 ? text.length : nl;
    if (!inFence(fences, lineStart)) {
      const line = text.slice(lineStart, lineEnd);
      const runs = [...line.matchAll(/`+/g)].map((m) => ({ at: m.index ?? 0, len: m[0].length }));
      for (let i = 0; i < runs.length; i++) {
        const j = runs.findIndex((r, k) => k > i && r.len === runs[i].len);
        if (j < 0) continue;
        out.push([lineStart + runs[i].at, lineStart + runs[j].at + runs[j].len]);
        i = j;
      }
    }
    if (nl < 0) break;
    lineStart = nl + 1;
  }
  return out;
}

const inFence = (spans: ReadonlyArray<[number, number]>, at: number) => spans.some(([a, b]) => at >= a && at < b);

/** Cheap pre-test: the text mentions the answer tag at all. */
export function mentionsAskAnswer(text: string | undefined): boolean {
  return !!text && /walnut-ask-answer/i.test(text);
}

export interface AskAnswerPart {
  /** The thread id the span names; null for text outside every span. */
  thread: string | null;
  /** The name the span names (absent: the tag had none). */
  name?: string;
  /** The span's inside (blank edge lines trimmed), or the text between spans as written. */
  text: string;
  /** The raw source of the part, tags included (what a span that files nowhere shows). */
  raw: string;
}

interface Tag { at: number; end: number; open: boolean; thread?: string; name?: string }

function tagsOf(text: string): Tag[] {
  if (!mentionsAskAnswer(text)) return [];
  const fences = codeSpans(text);
  const tags: Tag[] = [];
  for (const m of text.matchAll(OPEN_TAG)) {
    if (m.index === undefined || inFence(fences, m.index)) continue;
    const attrs = attrsOf(m[1]);
    const thread = attrs.get('thread') ?? '';
    // A tag without a valid id names no question: it is text.
    if (!ASK_THREAD_RE.test(thread)) continue;
    tags.push({ at: m.index, end: m.index + m[0].length, open: true, thread, ...(attrs.has('name') ? { name: attrs.get('name')! } : {}) });
  }
  for (const m of text.matchAll(CLOSE_TAG)) {
    if (m.index === undefined || inFence(fences, m.index)) continue;
    tags.push({ at: m.index, end: m.index + m[0].length, open: false });
  }
  return tags.sort((a, b) => a.at - b.at);
}

/** A span's inside: the lines between the tag lines, blank edge lines gone. */
function inner(text: string): string {
  return text.replace(/^[ \t]*\r?\n/, '').replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
}

/**
 * The text cut into spans and the text between them, in order. A span runs from
 * its opening tag to the next closing tag, the next opening tag, or the end of
 * the message. A closing tag with no open span is dropped. Parts with nothing
 * in them are left out.
 */
export function parseAskAnswers(text: string): AskAnswerPart[] {
  const tags = tagsOf(text);
  if (!tags.some((t) => t.open)) return [{ thread: null, text, raw: text }];
  const out: AskAnswerPart[] = [];
  let pos = 0;
  let open: Tag | null = null;
  const between = (to: number) => {
    const raw = text.slice(pos, to);
    if (raw.trim()) out.push({ thread: null, text: raw.trim(), raw });
  };
  const close = (to: number, end: number) => {
    const o = open!;
    const raw = text.slice(o.at, end);
    out.push({ thread: o.thread!, ...(o.name !== undefined ? { name: o.name } : {}), text: inner(text.slice(o.end, to)), raw });
    open = null;
    pos = end;
  };
  for (const t of tags) {
    if (t.open) {
      if (open) close(t.at, t.at);
      else between(t.at);
      open = t;
      pos = t.end;
    } else if (open) {
      close(t.at, t.end);
    } else {
      // A stray closing tag: dropped from the text around it.
      between(t.at);
      pos = t.end;
    }
  }
  if (open) close(text.length, text.length);
  else between(text.length);
  return out;
}

/** The answer tag a text opens with (blank lines allowed before it), or null. */
export function askAnswerOpening(text: string | undefined): { thread: string; name?: string } | null {
  if (!text || !mentionsAskAnswer(text)) return null;
  const m = /^\s*<walnut-ask-answer\b([^<>]*)>/i.exec(text);
  if (!m) return null;
  const attrs = attrsOf(m[1]);
  const thread = attrs.get('thread') ?? '';
  if (!ASK_THREAD_RE.test(thread)) return null;
  return { thread, ...(attrs.has('name') ? { name: attrs.get('name')! } : {}) };
}

/** Text that is only the start of an opening tag still streaming in (`<walnut-ask-ans`). */
const PARTIAL_OPEN = /^\s*<(?:w(?:a(?:l(?:n(?:u(?:t(?:-(?:a(?:s(?:k(?:-(?:a(?:n(?:s(?:w(?:e(?:r(?:\b[^<>]*)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?$/i;

/**
 * The text as shown: every answer tag (opening or closing, valid or not, outside
 * code blocks) gone with its line when it stands alone, and a tag still
 * streaming in at the very start hidden.
 */
export function stripAskAnswerTags(text: string): string {
  if (!text.includes('<')) return text;
  if (PARTIAL_OPEN.test(text) && /\S/.test(text)) return '';
  if (!mentionsAskAnswer(text)) return text;
  const fences = codeSpans(text);
  let out = '';
  let pos = 0;
  for (const m of text.matchAll(ANY_TAG)) {
    if (m.index === undefined || inFence(fences, m.index)) continue;
    let from = m.index;
    let to = m.index + m[0].length;
    // A tag on a line of its own takes its line along.
    const lineStart = text.lastIndexOf('\n', from - 1) + 1;
    const nl = text.indexOf('\n', to);
    const lineEnd = nl < 0 ? text.length : nl;
    if (!text.slice(lineStart, from).trim() && !text.slice(to, lineEnd).trim()) {
      from = lineStart;
      to = nl < 0 ? lineEnd : nl + 1;
    }
    if (from < pos) from = pos;
    out += text.slice(pos, from);
    pos = to;
  }
  out += text.slice(pos);
  return out.replace(/^\s*\n/, '').replace(/\n+$/, '').replace(/\n{3,}/g, '\n\n');
}

/** A name as compared: whitespace collapsed, case folded, a trailing ellipsis gone. */
export function askNameKey(name: string | undefined): string {
  return (name ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
    .replace(/(?:\u2026|\.\.\.)$/, '').trim().toLowerCase();
}

/** Do two names name the same question? */
export function sameAskName(a: string | undefined, b: string | undefined): boolean {
  return askNameKey(a) === askNameKey(b);
}

/** What a strict question's hint names it by. */
export interface StrictAsk {
  thread: string;
  name: string;
}

type HintRow = { role?: string; hints?: ReadonlyArray<{ kind: string; arg?: string; text?: string }> };

/** The question hint a row carries, when its text asks for the answer tag. */
function strictHint(m: HintRow): { kind: string; arg?: string; text?: string } | undefined {
  const h = m.hints?.find((x) => x.kind === 'question');
  return h && mentionsAskAnswer(h.text) ? h : undefined;
}

/** The row asked a strict question (its hint asks for the answer tag). */
export function isStrictAskRow(m: HintRow): boolean {
  return (m.role === undefined || m.role === 'user') && !!strictHint(m);
}

/** The thread id and name a strict question's row names it by, or null. */
export function strictAskOf(m: HintRow): StrictAsk | null {
  if (m.role !== undefined && m.role !== 'user') return null;
  const h = strictHint(m);
  if (!h) return null;
  const tag = /<walnut-ask\s+([^<>]*)>/i.exec(h.text ?? '');
  const attrs = tag ? attrsOf(tag[1]) : new Map<string, string>();
  const thread = attrs.get('thread') ?? h.arg ?? '';
  if (!ASK_THREAD_RE.test(thread)) return null;
  return { thread, name: attrs.get('name') ?? '' };
}

/** The strict questions on screen: per thread key, and per thread id. */
export interface StrictAskIndex {
  byKey: Map<string, { thread: string; name?: string }>;
  /** `names` (folded, askNameKey) absent: only a sent bubble knows the question
   *  so far (its name is checked once its row lands). Every ask row of the thread
   *  adds its name: a follow-up's hint may carry another one than the first. */
  byThread: Map<string, { key: string; names?: Set<string> }>;
}

/** The question a tag names, when its id and name match one in the index. */
export function askKeyOf(index: StrictAskIndex, thread: string | null, name: string | undefined): string | null {
  if (thread === null) return null;
  const ask = index.byThread.get(thread);
  if (!ask) return null;
  return !ask.names || ask.names.has(askNameKey(name)) ? ask.key : null;
}

const wordsIn = (text: string) => (stripAskAnswerTags(text).match(/\S+/g) ?? []).length;

/**
 * The question a live text block files under, or null (the turn's own page): the
 * question whose tag the block opens with, else the question whose matching
 * spans hold at least as many of the block's words as the text outside them (a
 * short preamble, then the tagged answer: the stored split files the answer
 * under the question, so the live block does not show it in the main chat while
 * it streams).
 */
export function liveAskKeyOf(index: StrictAskIndex, text: string | undefined): string | null {
  if (index.byThread.size === 0 || !text || !mentionsAskAnswer(text)) return null;
  const open = askAnswerOpening(text);
  if (open) return askKeyOf(index, open.thread, open.name);
  const per = new Map<string, number>();
  let outside = 0;
  for (const p of parseAskAnswers(text)) {
    const key = askKeyOf(index, p.thread, p.name);
    if (key === null) outside += wordsIn(p.raw);
    else per.set(key, (per.get(key) ?? 0) + wordsIn(p.text));
  }
  let best: string | null = null;
  let most = -1;
  for (const [key, n] of per) if (n > most) { best = key; most = n; }
  return best !== null && most >= outside && most > 0 ? best : null;
}

/**
 * Every strict question: from the rows (the first row of a thread id gives its
 * name, as the server fixed it at the first send) and from sent bubbles (every
 * question this client sends asks for the tag). `keyOf` maps a row's thread id
 * to its thread key; a row of the main conversation is no question.
 */
export function strictAsksOf(
  rows: ReadonlyArray<HintRow & { msgId?: string; sourceUuid?: string }>,
  bubbles: ReadonlyArray<{ role?: string; userUuid?: string; requestedHints?: Record<string, { arg?: string } | undefined> }> | undefined,
  keyOf: (id: string | undefined) => string,
): StrictAskIndex {
  const out: StrictAskIndex = { byKey: new Map(), byThread: new Map() };
  for (const r of rows) {
    if (r.role !== 'user') continue;
    const ask = strictAskOf(r);
    if (!ask) continue;
    const key = keyOf(r.sourceUuid ?? r.msgId);
    if (!key) continue;
    if (!out.byKey.has(key)) out.byKey.set(key, ask);
    const known = out.byThread.get(ask.thread);
    if (!known) out.byThread.set(ask.thread, { key, names: new Set([askNameKey(ask.name)]) });
    else known.names?.add(askNameKey(ask.name));
  }
  for (const b of bubbles ?? []) {
    const thread = b.requestedHints?.question?.arg;
    if (b.role !== 'user' || !b.userUuid || !thread || !ASK_THREAD_RE.test(thread)) continue;
    const key = keyOf(b.userUuid);
    if (!key) continue;
    if (!out.byKey.has(key)) out.byKey.set(key, { thread });
    if (!out.byThread.has(thread)) out.byThread.set(thread, { key });
  }
  return out;
}
