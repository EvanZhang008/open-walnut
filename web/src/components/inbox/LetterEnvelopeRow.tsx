/**
 * One envelope row in the Inbox rail — the letter's "outside".
 *
 * Everything on it is stamped by the system (sender session, task, host), so the
 * human sees WHO wrote and FROM WHICH task without the agent spending words on
 * it. Row actions (pin / archive / mark unread) stopPropagation: the row itself
 * opens the reader, and a pin click must never also open it.
 */
import { memo } from 'react';
import { formatRelative } from '@/contexts/notifications';
import { LETTER_TYPE_LABEL, type LetterEnvelope } from '@/api/human-inbox';
import '@/styles/human-inbox.css';

/** Sender line: friendly session title, else a short id, else "external". */
export function senderLabelOf(letter: LetterEnvelope): string {
  const sender = letter.sender ?? { sessionId: '', host: '' };
  if (sender.sessionTitle) return sender.sessionTitle;
  const sid = sender.sessionId ?? '';
  if (!sid || sid === 'external') return 'External agent';
  if (sid === '__local__') return 'Local session';
  return sid.length > 8 ? `${sid.slice(0, 8)}…` : sid;
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true">
      <path d="M14 2l8 8-3 1-1 5-4-4-6 6-1 4-1-1 4-1 6-6-4-4 5-1 1-3z" />
    </svg>
  );
}

interface LetterEnvelopeRowProps {
  letter: LetterEnvelope;
  onOpen: () => void;
  onTogglePin: () => void;
  onToggleArchive: () => void;
  onToggleRead: () => void;
}

export const LetterEnvelopeRow = memo(function LetterEnvelopeRow({
  letter, onOpen, onTogglePin, onToggleArchive, onToggleRead,
}: LetterEnvelopeRowProps) {
  const sender = letter.sender ?? { sessionId: '', host: '' };
  const replies = letter.thread?.length ?? 0;
  const answered = letter.answered;

  return (
    <div
      className={`hib-row${letter.read ? '' : ' hib-unread'}${letter.pinned ? ' hib-pinned' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
      }}
    >
      <div className="hib-row-head">
        <span
          className={`hib-dot${letter.read ? ' hib-dot-read' : ''}`}
          aria-label={letter.read ? 'Read' : 'Unread'}
          role="img"
        />
        {letter.pinned && <span className="hib-pin" title="Pinned"><PinIcon /></span>}
        <span className="hib-subject">{letter.subject || '(no subject)'}</span>
        <span className={`hib-type hib-type--${letter.type}`}>
          {LETTER_TYPE_LABEL[letter.type] ?? letter.type}
        </span>
        <span className="hib-time">{formatRelative(letter.createdAt)}</span>
      </div>

      <div className="hib-row-chips">
        <span className="hib-chip">{senderLabelOf(letter)}</span>
        {sender.taskTitle && <span className="hib-chip hib-chip-task">{sender.taskTitle}</span>}
        {sender.project && <span className="hib-chip">{sender.project}</span>}
        {sender.host && <span className="hib-chip">{sender.host}</span>}
        {replies > 0 && (
          <span className="hib-chip hib-chip-thread">{replies} in thread</span>
        )}
      </div>

      {letter.textPreview && <div className="hib-preview">{letter.textPreview}</div>}

      {answered && (
        <div className="hib-answered-chip">
          Answered: {answered.label || answered.actionId} · {formatRelative(answered.at)}
        </div>
      )}

      <div className="hib-row-actions">
        <button
          className="hib-row-btn"
          onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
        >
          {letter.pinned ? 'Unpin' : 'Pin'}
        </button>
        <button
          className="hib-row-btn"
          onClick={(e) => { e.stopPropagation(); onToggleRead(); }}
        >
          {letter.read ? 'Mark unread' : 'Mark read'}
        </button>
        <button
          className="hib-row-btn"
          onClick={(e) => { e.stopPropagation(); onToggleArchive(); }}
        >
          {letter.archived ? 'Unarchive' : 'Archive'}
        </button>
      </div>
    </div>
  );
});
