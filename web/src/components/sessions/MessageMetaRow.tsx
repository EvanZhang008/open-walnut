import { memo, useCallback } from 'react';
import { CopyMessageButtons } from '@/components/common/CopyMessageButtons';
import { useSessionPinsApi } from '@/contexts/SessionPinsContext';
import { useSessionRewindApi } from '@/contexts/SessionRewindContext';
import { timeAgo } from '@/utils/time';
import { pinLabelFor } from '@/hooks/useSessionPins';

/** Pin glyph, outline when unpinned and filled once pinned (the only state the
 *  row shows — the TOC is the other half of the feedback). */
const ICON_PIN = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.5 2.5l4 4-1.4 1.4-.7-.7-2.5 2.5.4 2.6-1 1-4.6-4.6 1-1 2.6.4 2.5-2.5-.7-.7z" />
    <path d="M5.2 10.8L2.5 13.5" />
  </svg>
);

const ICON_PIN_FILLED = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.5 2.5l4 4-1.4 1.4-.7-.7-2.5 2.5.4 2.6-1 1-4.6-4.6 1-1 2.6.4 2.5-2.5-.7-.7z" />
    <path d="M5.2 10.8L2.5 13.5" fill="none" />
  </svg>
);

/** Tape-deck rewind: a bar the tape winds back TO, plus two left triangles.
 *  Deliberately NOT the circular counter-clockwise arrow that was here first —
 *  that glyph is the universal "restart / reload" and read as "run this again",
 *  which is the opposite of what the button does. */
const ICON_REWIND = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" stroke="none" aria-hidden="true">
    <rect x="2" y="3.4" width="1.5" height="9.2" rx="0.6" />
    <path d="M9 3.9v8.2L4.6 8.3a.4.4 0 010-.6z" />
    <path d="M14.2 3.9v8.2L9.8 8.3a.4.4 0 010-.6z" />
  </svg>
);

/** The CLI's transcript uuids are v4 UUIDs; every other msgId shape (synthetic
 *  `queue-…` ids, API `msg_…` ids) is unknown to `--resume-session-at`, so the
 *  rewind button must not offer itself there. Same predicate as the server's
 *  isRewindableMessageId — kept in both places on purpose: the server refuses,
 *  the client doesn't offer. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function absoluteTime(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString([], {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export interface MessageMetaRowProps {
  msgId?: string;
  role: 'user' | 'assistant' | 'system';
  text?: string;
  timestamp?: string;
  /** Keep the row visible instead of hover-only (the live tail's last reply). */
  alwaysVisible?: boolean;
}

/**
 * The hover strip under a transcript message: copy, pin, rewind (own messages
 * only), and the time.
 *
 * The time reads as a relative age ("2h ago", "last month") and carries the exact
 * timestamp in a tooltip, because that is the question people actually ask of a
 * transcript — "how long ago was this?" first, "when exactly?" second. Hidden
 * until hover so a long transcript stays a conversation, not a log file.
 */
export const MessageMetaRow = memo(function MessageMetaRow({
  msgId, role, text, timestamp, alwaysVisible,
}: MessageMetaRowProps) {
  const { isPinned, toggle } = useSessionPinsApi();
  const rewind = useSessionRewindApi();
  const pinned = isPinned(msgId);
  const canRewind = rewind.available && role === 'user' && !!msgId && UUID_RE.test(msgId);

  const onPin = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    toggle({ msgId, role, text, timestamp });
  }, [toggle, msgId, role, text, timestamp]);

  const onRewind = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (msgId) rewind.request(msgId, pinLabelFor(text, 'this message'));
  }, [rewind, msgId, text]);

  const hasText = !!text && !!text.trim();
  const abs = timestamp ? absoluteTime(timestamp) : '';
  const rel = timestamp ? timeAgo(timestamp) : '';

  // Nothing to offer (no id to pin, no text to copy, no timestamp) — render
  // nothing rather than an empty strip that still reserves a hover target.
  if (!msgId && !hasText && !timestamp) return null;

  return (
    <div className={`session-msg-actions${alwaysVisible ? ' session-msg-actions--sticky' : ''}`}>
      {hasText && <CopyMessageButtons markdown={text!} />}
      {msgId && (
        <button
          type="button"
          className={`msg-copy-btn msg-pin-btn${pinned ? ' is-pinned' : ''}`}
          onClick={onPin}
          title={pinned ? 'Unpin this message' : 'Pin this message (adds it to the outline)'}
          aria-label={pinned ? 'Unpin this message' : 'Pin this message'}
          aria-pressed={pinned}
        >
          {pinned ? ICON_PIN_FILLED : ICON_PIN}
        </button>
      )}
      {canRewind && (
        <button
          type="button"
          className="msg-copy-btn msg-rewind-btn"
          onClick={onRewind}
          title="Rewind the session back to this message"
          aria-label="Rewind to this message"
        >
          {ICON_REWIND}
        </button>
      )}
      {rel && (
        <span className="msg-time" data-tip={abs} title={abs}>{rel}</span>
      )}
    </div>
  );
});
