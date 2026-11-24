/**
 * A node's own words on a card he acknowledged must be news (threads-model.ts updateThread). Server
 * side: the subject words (thread-same-subject.ts) stay out of the web-safe thread-known.ts.
 */
import { ackHoldsResult } from './thread-known.js';
import { subjectWords } from './thread-same-subject.js';
import type { ViewThread } from './thread-view.js';

/**
 * Why a node's own words on `t` would show him again what he acknowledged, or null (2026-11-24, the
 * threads inspection, item 10: the line path was braked after his Acknowledge, a node's own
 * thread_update and its close-reopening-on-news were not). `t` holds a result he acknowledged (still
 * pending, or closed by Walnut's placement as his Acknowledge covered it); `words` add at most one
 * telling word to the summary he acknowledged (a number, a path, a name of its own is news). His own
 * close and a needs hand-over are never judged here. Pure.
 */
export function repeatsAcknowledged(t: ViewThread & { state: string; reply?: string; closed?: { by: string; reacted?: boolean } }, words: string): string | null {
  const acked = !!t.ackedAt && t.ackedResult !== false && (t.closed ? !!t.closed.reacted : ackHoldsResult(t));
  if (!acked || !t.reply?.trim()) return null;
  const had = subjectWords(t.reply);
  const now = [...subjectWords(words)];
  if (now.length < 3 || now.filter((w) => !had.has(w)).length > 1) return null;
  return 'He acknowledged this result already, and these words say it again: nothing new for him, so his card stays as he left it. '
    + 'Write only what changed since (a new number, path or step), or leave the thread as it is.';
}
