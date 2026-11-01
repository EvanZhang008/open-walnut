/**
 * Quotes and comments left on passages of a transcript (the selection pill's
 * Quote / Comment, 2026-11-01). Pure, so the order and merge rules are tested
 * without a browser.
 *
 *   pending   no `sentAt`: listed above the composer, and the next accepted send
 *             carries each one (quote, then its comment) ahead of the typed words
 *   sent      stays a mark on the words it was left on
 *
 * The list lives on the session record (`passage_comments`), like quote pins.
 */
import type { SessionPassageComment } from '@/types/session';
import { buildPassagePrefill } from '@/components/sessions/diffPrefill';
import { sidecarPathOf } from '@/utils/doc-comments';

/** Still waiting for a send: neither sent nor taken out. */
export const isPending = (c: SessionPassageComment): boolean => !c.sentAt && !c.removedAt;
/** Shown as a mark on its words in the transcript (a doc comment's mark is in its doc). */
export const isMarked = (c: SessionPassageComment): boolean =>
  !c.doc && !c.removedAt && (!c.sentAt || !!c.comment.trim());

/** Said once after the doc comments of a message: where the AI answers them. */
export const DOC_COMMENTS_HOW = 'Each doc comment\'s thread is in the `.comments.md` file named with it: reply there under '
  + 'its `## c-…` heading as a list item `- **AI** · <ISO time> · <your words>` (later lines indented two spaces), and '
  + 'once the doc is changed so the comment is settled, write `resolved · AI · <ISO time>` in place of `open` in that heading.\n\n';

function docHead(c: SessionPassageComment): string {
  const d = c.doc!;
  const where = `\`${d.path}\`${d.host ? ` on ${d.host}` : ''}`;
  const what = d.reply ? `My reply in comment ${d.commentId}` : `Comment ${d.commentId}`;
  return `${what} on ${where} (thread in \`${sidecarPathOf(d.path)}\`):\n`;
}

/** The server's caps (session-lifecycle.ts): past them a passage keeps the text path. */
export const MAX_COMMENTS = 100;
export const MAX_TEXT_CHARS = 4000;
export const MAX_COMMENT_CHARS = 4000;
/** A tombstone lives a day: long enough for every stale copy to have been read. */
const TOMBSTONE_MS = 24 * 3600_000;

/**
 * The message the model receives: every pending item in the order it was added,
 * each as its quote with the comment under it (the transcript's first, then the
 * doc ones, each headed by its doc and comment id, then once how to answer them
 * in their sidecar), then what the user typed. Nothing pending = the typed words
 * untouched.
 */
export function composeWithComments(pending: readonly SessionPassageComment[], typed: string): string {
  if (pending.length === 0) return typed;
  const chat = pending.filter((c) => !c.doc).map((c) => buildPassagePrefill(c.text, c.comment)).join('');
  const docs = pending.filter((c) => c.doc);
  const doc = docs.length ? `${docs.map((c) => docHead(c) + buildPassagePrefill(c.text, c.comment)).join('')}${DOC_COMMENTS_HOW}` : '';
  const head = chat + doc;
  const tail = typed.trim();
  return tail ? `${head}${tail}` : head.replace(/\s+$/, '');
}

/**
 * The send carrying `ids` was accepted at `at`: each comment among them becomes a
 * sent mark, and each plain Quote is done (taken out: it leaves no mark). Entries
 * added while the send was in flight stay pending.
 */
export function markSent(list: readonly SessionPassageComment[], ids: ReadonlySet<string>, at: string): SessionPassageComment[] {
  return list.map((c) => {
    if (!ids.has(c.id) || c.sentAt || c.removedAt) return c;
    // A doc comment's mark stays in its doc; here it was only the way to the model.
    return c.comment.trim() && !c.doc ? { ...c, sentAt: at } : { ...c, sentAt: at, removedAt: at };
  });
}

/** Take one out (a tombstone, see mergeComments). */
export function markRemoved(list: readonly SessionPassageComment[], id: string, at: string): SessionPassageComment[] {
  return list.map((c) => (c.id === id && !c.removedAt ? { ...c, removedAt: at } : c));
}

const newest = (c: SessionPassageComment): string =>
  [c.createdAt, c.updatedAt, c.sentAt, c.removedAt].reduce<string>((a, b) => (b && b > a ? b : a), '');

/**
 * Two copies of the list (ours and the record's, or the record's and another
 * window's) become one: every id either holds, in the order first seen. Sent and
 * taken out are one-way, so either copy's stamp stands; otherwise the copy edited
 * last wins. Nothing is ever dropped here, so neither a stale read nor a write from
 * another window can lose a comment, un-send one, or bring a removed one back.
 */
export function mergeComments(a: readonly SessionPassageComment[], b: readonly SessionPassageComment[]): SessionPassageComment[] {
  const byId = new Map<string, SessionPassageComment>();
  for (const c of [...a, ...b]) {
    const prev = byId.get(c.id);
    if (!prev) { byId.set(c.id, c); continue; }
    const winner = newest(c) > newest(prev) ? c : prev;
    const sentAt = prev.sentAt ?? c.sentAt;
    const removedAt = prev.removedAt ?? c.removedAt;
    byId.set(c.id, { ...winner, ...(sentAt ? { sentAt } : {}), ...(removedAt ? { removedAt } : {}) });
  }
  return [...byId.values()];
}

/**
 * What a write stores: tombstones older than a day go, and past the cap the oldest
 * sent marks go first (pending ones never do).
 */
export function pruneComments(list: readonly SessionPassageComment[], now: number): SessionPassageComment[] {
  const cutoff = new Date(now - TOMBSTONE_MS).toISOString();
  let out = list.filter((c) => !c.removedAt || c.removedAt > cutoff);
  let over = out.length - MAX_COMMENTS;
  if (over > 0) {
    const drop = new Set(out
      .filter((c) => !isPending(c))
      .sort((x, y) => (x.removedAt ? 0 : 1) - (y.removedAt ? 0 : 1) || newest(x).localeCompare(newest(y)))
      .slice(0, over)
      .map((c) => c.id));
    out = out.filter((c) => !drop.has(c.id));
    over = out.length - MAX_COMMENTS;
  }
  return over > 0 ? out.slice(over) : out;
}

/** Can this passage be kept as a comment, or must it take the text path? */
export function fitsAsComment(text: string, comment: string, list: readonly SessionPassageComment[]): boolean {
  if (text.length > MAX_TEXT_CHARS || comment.length > MAX_COMMENT_CHARS) return false;
  return list.filter(isPending).length < MAX_COMMENTS;
}

/** One line of a passage for a row: whitespace folded, cut at `max` with an ellipsis. */
export function snippetOf(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** "1 comment", "2 comments", "1 quote", "2 quotes, 1 comment". */
export function countLabel(pending: readonly SessionPassageComment[]): string {
  const comments = pending.filter((c) => c.comment.trim()).length;
  const quotes = pending.length - comments;
  const part = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (!quotes) return part(comments, 'comment');
  if (!comments) return part(quotes, 'quote');
  return `${part(comments, 'comment')}, ${part(quotes, 'quote')}`;
}
