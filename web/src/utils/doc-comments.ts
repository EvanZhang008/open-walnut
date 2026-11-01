/**
 * Comments on a document live in a sidecar Markdown file beside it (2026-11-01,
 * the user: "a separate Markdown or text file ... the AI can resolve in it ... like
 * a Google Doc"). `design.md` keeps its comments in `design.md.comments.md`, a file
 * a person reads as it is and an agent edits with its own tools:
 *
 *     <!-- walnut-comments v1 ... -->
 *
 *     ## c-3f2a1b9e · open
 *     <!-- anchor {"exact":"...","prefix":"so ","suffix":" and"} -->
 *     > the passage, as selected
 *
 *     - **You** · 2026-11-01T10:00:00.000Z · the comment
 *       a second line of it
 *     - **AI** · 2026-11-01T10:05:00.000Z · a reply
 *
 * One `##` section per comment: its id, its status (`open`, or `resolved` with who
 * and when after it), the anchor (W3C TextQuote: the words and their context, plus
 * the view they were picked in), the passage as a Markdown quote, then the thread,
 * oldest first. Parsing is lenient, because an agent writes this by hand: a post's
 * later lines and paragraphs need no indent, `- **AI**: text` and a missing time are
 * read, and nothing the parser does not know is lost: text before the first section
 * and lines between a passage and its thread are kept and written back.
 *
 * What the user typed can never become structure: every line of a post after its
 * first is written indented, and only an unindented line starts a section, an
 * anchor or a post.
 */
import type { SessionPinnedQuote } from '@/types/session';

export const DOC_COMMENTS_VERSION = 1;
/** The first line of a file Walnut wrote (`isWalnutFile`). */
const MAGIC = 'walnut-comments';

export interface DocCommentPost {
  /** "You" for the user, "AI" for the session's agent; any other name as written. */
  author: string;
  /** ISO time; '' when the writer gave none. */
  at: string;
  text: string;
}

/** The view the words were picked in: a rendered doc and its source read differently. */
export type DocCommentView = 'rendered' | 'source';

export interface DocComment {
  id: string;
  status: 'open' | 'resolved';
  resolvedBy?: string;
  resolvedAt?: string;
  /** exact '' = a section with no passage (an agent wrote it): it cannot be placed. */
  quote: SessionPinnedQuote;
  /** Absent = rendered. */
  view?: DocCommentView;
  /** The passage as selected, line breaks kept. */
  text: string;
  thread: DocCommentPost[];
  /** Lines the parser did not understand between the passage and the thread, kept. */
  extra?: string[];
}

export interface DocCommentsFile {
  comments: DocComment[];
  /** What stands before the first section, Walnut's header line excluded: kept as it is. */
  preface: string[];
  /** The file starts with Walnut's header line. */
  isWalnutFile: boolean;
}

export const USER_AUTHOR = 'You';
export const AI_AUTHOR = 'AI';

/** `docs/design.md` → `docs/design.md.comments.md`: the doc's whole name, so no two docs share one. */
export function sidecarPathOf(docPath: string): string {
  return `${docPath}.comments.md`;
}

/** A sidecar is never itself commented on. */
export function isSidecarPath(path: string): boolean {
  return /\.comments\.md$/i.test(path);
}

const HEADER = (doc: string) =>
  `<!-- ${MAGIC} v${DOC_COMMENTS_VERSION}: comments on ${JSON.stringify(doc).replace(/--/g, '- -')}. One "## <id> · <status>" section per comment; `
  + 'reply with a list item "- **AI** · <time> · <words>" (later lines indented two spaces); resolve by writing "resolved · AI · <time>" '
  + 'for "open". Keep the ids and the anchor lines. -->';

/** Only an unindented line is structure (see the file comment). */
const SECTION = /^##\s+(c-[A-Za-z0-9_-]+)\b[\s·:,.-]*(.*)$/;
const ANCHOR = /^<!--\s*anchor\s+(\{.*\})\s*-->\s*$/;
const POST = /^[-*]\s+\*\*(.+?)\*\*\s*(?:[·:]\s*)?(.*)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

function parseStatus(rest: string | undefined): Pick<DocComment, 'status' | 'resolvedBy' | 'resolvedAt'> {
  const text = (rest ?? '').trim();
  if (!/^resolved\b/i.test(text)) return { status: 'open' };
  const parts = text.replace(/^resolved\b/i, '').split(/·|\bby\b|,/i).map((p) => p.trim()).filter(Boolean);
  const at = parts.find((p) => ISO.test(p));
  const by = parts.find((p) => p !== at);
  return { status: 'resolved', ...(by ? { resolvedBy: by } : {}), ...(at ? { resolvedAt: at } : {}) };
}

function parsePost(line: string): DocCommentPost | null {
  const m = POST.exec(line);
  if (!m) return null;
  let rest = m[2] ?? '';
  let at = '';
  const t = /^(\S+)\s*·\s*([\s\S]*)$/.exec(rest);
  if (t && ISO.test(t[1]!)) { at = t[1]!; rest = t[2]!; }
  return { author: m[1]!.trim(), at, text: rest.trim() };
}

export function parseDocCommentsFile(source: string): DocCommentsFile {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const isWalnutFile = (lines[0] ?? '').trimStart().startsWith(`<!-- ${MAGIC}`);
  const comments: DocComment[] = [];
  const preface: string[] = [];
  let cur: DocComment | null = null;
  let quoteLines: string[] = [];
  let anchor: Partial<SessionPinnedQuote> & { view?: string } = {};
  let post: DocCommentPost | null = null;
  // Blank lines inside a post: kept only when more of the post follows them.
  let blanks = 0;
  const finish = () => {
    if (!cur) return;
    cur.text = quoteLines.join('\n').trim();
    const flat = cur.text.replace(/\n+/g, '');
    cur.quote = {
      exact: typeof anchor.exact === 'string' && anchor.exact ? anchor.exact : flat,
      ...(typeof anchor.prefix === 'string' && anchor.prefix ? { prefix: anchor.prefix } : {}),
      ...(typeof anchor.suffix === 'string' && anchor.suffix ? { suffix: anchor.suffix } : {}),
    };
    if (anchor.view === 'source') cur.view = 'source';
    comments.push(cur);
    cur = null; post = null; quoteLines = []; anchor = {}; blanks = 0;
  };
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const head = SECTION.exec(line);
    if (head) {
      finish();
      cur = { id: head[1]!, ...parseStatus(head[2]), quote: { exact: '' }, text: '', thread: [] };
      return;
    }
    if (!cur) {
      if (!(i === 0 && isWalnutFile)) preface.push(raw);
      return;
    }
    const c: DocComment = cur;
    const a = ANCHOR.exec(line);
    if (a && !post) {
      try { anchor = JSON.parse(a[1]!) as typeof anchor; } catch { (c.extra ??= []).push(line); }
      return;
    }
    if (!post && /^>/.test(line) && c.thread.length === 0) {
      quoteLines.push(line.replace(/^>\s?/, ''));
      return;
    }
    const p = /^[-*]\s/.test(raw) ? parsePost(line) : null;
    if (p) { post = p; blanks = 0; c.thread.push(p); return; }
    if (!line.trim()) { if (post) blanks += 1; return; }
    if (post) {
      // A later line of the post: indented as Walnut writes it, or as an agent wrote it.
      post.text = `${post.text}${'\n'.repeat(blanks + 1)}${raw.replace(/^ {2}/, '').trimEnd()}`;
      blanks = 0;
      return;
    }
    (c.extra ??= []).push(line);
  });
  finish();
  while (preface.length && !preface[preface.length - 1]!.trim()) preface.pop();
  while (preface.length && !preface[0]!.trim()) preface.shift();
  return { comments, preface, isWalnutFile };
}

export function parseDocComments(source: string): DocComment[] {
  return parseDocCommentsFile(source).comments;
}

function quoteBlock(text: string): string {
  return text.split('\n').map((l) => (l.trim() ? `> ${l.trimEnd()}` : '>')).join('\n');
}

function postLines(p: DocCommentPost): string {
  const [first, ...more] = p.text.replace(/\r\n?/g, '\n').trim().split('\n');
  const head = `- **${p.author}** · ${p.at ? `${p.at} · ` : ''}${first ?? ''}`;
  return [head, ...more.map((l) => (l.trim() ? `  ${l.trimEnd()}` : ''))].join('\n');
}

/** JSON on one line inside an HTML comment: `-->` in the words must not end it. */
function anchorLine(c: DocComment): string {
  const json = JSON.stringify({
    exact: c.quote.exact,
    ...(c.quote.prefix ? { prefix: c.quote.prefix } : {}),
    ...(c.quote.suffix ? { suffix: c.quote.suffix } : {}),
    ...(c.view === 'source' ? { view: 'source' } : {}),
  }).replace(/>/g, '\\u003e').replace(/</g, '\\u003c');
  return `<!-- anchor ${json} -->`;
}

export function serializeDocComments(docName: string, comments: readonly DocComment[], preface: readonly string[] = []): string {
  const blocks = comments.map((c) => {
    const status = c.status === 'resolved'
      ? ['resolved', c.resolvedBy, c.resolvedAt].filter(Boolean).join(' · ')
      : 'open';
    return [
      `## ${c.id} · ${status}`,
      anchorLine(c),
      ...(c.text ? [quoteBlock(c.text)] : []),
      ...(c.extra?.length ? ['', ...c.extra] : []),
      '',
      ...c.thread.map(postLines),
    ].join('\n');
  });
  const head = preface.length ? `${HEADER(docName)}\n\n${preface.join('\n')}` : HEADER(docName);
  return `${head}\n\n${blocks.join('\n\n')}\n`;
}

/** A new comment id: short, stable in the file, unique enough for one document. */
export function newDocCommentId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  const hex = c && typeof c.randomUUID === 'function'
    ? c.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `c-${hex.slice(0, 8)}`;
}

/**
 * The edits the viewer makes. Each is a function of the list on disk, so a write
 * that lost a race (the AI replied in the meantime) is replayed on the fresh read
 * instead of merged: nobody's post is ever lost. Each is idempotent, so a write
 * that landed although its answer was lost (a timeout) is not applied twice.
 */
export type DocCommentEdit = (list: readonly DocComment[]) => DocComment[];

export const addDocComment = (c: DocComment): DocCommentEdit => (list) =>
  (list.some((x) => x.id === c.id) ? [...list] : [...list, c]);

const samePost = (a: DocCommentPost, b: DocCommentPost) => a.author === b.author && a.at === b.at && a.text === b.text;

export const addDocPost = (id: string, post: DocCommentPost): DocCommentEdit => (list) =>
  list.map((c) => (c.id === id && !c.thread.some((p) => samePost(p, post)) ? { ...c, thread: [...c.thread, post] } : c));

export const setDocResolved = (id: string, resolved: boolean, by: string, at: string): DocCommentEdit => (list) =>
  list.map((c) => {
    if (c.id !== id) return c;
    const { resolvedBy: _b, resolvedAt: _a, ...rest } = c;
    return resolved ? { ...rest, status: 'resolved', resolvedBy: by, resolvedAt: at } : { ...rest, status: 'open' };
  });

export const deleteDocComment = (id: string): DocCommentEdit => (list) => list.filter((c) => c.id !== id);

/** The newest post's time, else '' (for "Resolved 5 min ago" and ordering). */
export function lastActivity(c: DocComment): string {
  return [c.resolvedAt ?? '', ...c.thread.map((p) => p.at)].reduce((a, b) => (b > a ? b : a), '');
}
