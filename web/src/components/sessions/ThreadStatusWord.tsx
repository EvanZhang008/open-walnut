/**
 * A question's status as a word and a small glyph, with no branch colour: the
 * sidebar, the rail and the turn label read it. Words, not hues, are how one
 * question is told from another (the user's number is the identity; colour
 * per question read as noise). Only `New` (an answer landed since the question
 * was last on screen) and `Answering…` use the accent, the rest stay grey.
 *
 * Glyphs are SVG, never text characters (the question UI bans arrow, dash and
 * check glyph characters in visible text).
 */
import { memo } from 'react';
import type { ThreadViewStatus } from '@/utils/thread-meta';
import '@/styles/thread-stack.css';

export type StatusWordKind = 'waiting' | 'answering' | 'new' | 'answered' | 'check' | 'done' | 'failed' | 'draft' | 'none';

/** Which word a view status shows. `unread`: the newest answer is unseen. */
export function statusWordKind(status: ThreadViewStatus | undefined, unread: boolean): StatusWordKind {
  switch (status) {
    case 'queued': return 'waiting';
    case 'answering': return 'answering';
    case 'failed': return 'failed';
    case 'suggested': return 'check';
    case 'resolved': return 'done';
    case 'pending': return 'waiting';
    case 'draft': return 'draft';
    case 'open': return unread ? 'new' : 'answered';
    case 'older': return 'answered';
    default: return 'none';
  }
}

export const STATUS_WORDS: Record<StatusWordKind, string> = {
  waiting: 'Waiting',
  answering: 'Answering…',
  new: 'New',
  answered: 'Answered',
  check: 'To check',
  done: 'Archived',
  failed: 'No answer',
  draft: 'Draft',
  none: '',
};

function Glyph({ kind }: { kind: StatusWordKind }) {
  switch (kind) {
    case 'waiting':
    case 'draft':
      return <svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
    case 'answering':
      return <svg viewBox="0 0 12 12" aria-hidden="true" className="thread-status-word-spin"><circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="18 9" /></svg>;
    case 'new':
    case 'answered':
      return <svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.4" fill="currentColor" /></svg>;
    case 'check':
      return <svg viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="6" cy="6" r="4.8" /><path d="M3.8 6.2l1.5 1.5 3-3.2" /></svg>;
    case 'done':
      // A box with a lid: archived, not "done" (2026-10-08).
      return <svg viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="M1.6 2.4h8.8v2.1H1.6zM2.4 4.5v4.8c0 .4.3.7.7.7h5.8c.4 0 .7-.3.7-.7V4.5M4.9 6.5h2.2" /></svg>;
    case 'failed':
      return <svg viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="6" cy="6" r="4.8" /><path d="M6 3.4v3.2M6 8.6v.1" /></svg>;
    default:
      return null;
  }
}

export interface ThreadStatusWordProps {
  status: ThreadViewStatus | undefined;
  unread?: boolean;
  /** Glyph only (a narrow column); the word is the tooltip. */
  compact?: boolean;
  /** Tooltip; defaults to the word (and the time an unread answer landed, when given). */
  title?: string;
  className?: string;
}

export const ThreadStatusWord = memo(function ThreadStatusWord({ status, unread, compact, title, className }: ThreadStatusWordProps) {
  const kind = statusWordKind(status, !!unread);
  if (kind === 'none') return null;
  const word = STATUS_WORDS[kind];
  return (
    <span
      className={`thread-status-word${className ? ` ${className}` : ''}`}
      data-kind={kind}
      data-compact={compact ? 'true' : undefined}
      title={title ?? word}
      role="img"
      aria-label={title ?? word}
    >
      <Glyph kind={kind} />
      {!compact && <span className="thread-status-word-text">{word}</span>}
    </span>
  );
});
