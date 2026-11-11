/**
 * One envelope row in the Inbox rail — the letter's "outside".
 *
 * Everything on it is stamped by the system (sender session, task, host), so the
 * human sees WHO wrote and FROM WHICH task without the agent spending words on
 * it. Row actions (pin / archive / mark unread) stopPropagation: the row itself
 * opens the reader, and a pin click must never also open it.
 */
import { memo } from 'react';
import { AgentText } from '@/components/common/AgentText';
import { formatRelative } from '@/contexts/notifications';
import { LETTER_TYPE_LABEL, answeredByName, letterOriginOf, type LetterEnvelope } from '@/api/human-inbox';
import { LetterOriginBadge } from './LetterOriginBadge';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { copyTextRobust } from '@/utils/clipboard';
import '@/styles/human-inbox.css';

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
  // Right-click = the row's own buttons without hunting for them, plus the two
  // ids you need when following a letter into the logs or a session.
  const menu = useContextMenu<void>();
  const menuItems = (): ContextMenuItem[] => [
    { key: 'open', label: 'Open', onSelect: onOpen },
    { divider: true },
    { key: 'read', label: letter.read ? 'Mark unread' : 'Mark read', onSelect: onToggleRead },
    { key: 'pin', label: letter.pinned ? 'Unpin' : 'Pin', onSelect: onTogglePin },
    { key: 'archive', label: letter.archived ? 'Unarchive' : 'Archive', onSelect: onToggleArchive },
    { divider: true },
    {
      key: 'copy-subject', label: 'Copy subject', when: !!letter.subject,
      onSelect: () => { void copyTextRobust(letter.subject); },
    },
    {
      key: 'copy-session', label: 'Copy sender session ID',
      when: !!sender.sessionId && sender.sessionId !== 'external',
      title: sender.sessionId,
      onSelect: () => { void copyTextRobust(sender.sessionId!); },
    },
  ];

  return (
    <div
      className={`hib-row${letter.read ? '' : ' hib-unread'}${letter.pinned ? ' hib-pinned' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
      }}
      onContextMenu={(e) => menu.open(e, undefined)}
    >
      {/* Who it is from comes first, in Walnut's colors: a letter is never outside mail. */}
      <div className="hib-row-head">
        <span
          className={`hib-dot${letter.read ? ' hib-dot-read' : ''}`}
          aria-label={letter.read ? 'Read' : 'Unread'}
          role="img"
        />
        {letter.pinned && <span className="hib-pin" title="Pinned"><PinIcon /></span>}
        <LetterOriginBadge letter={letter} />
        <span className="hib-time">{formatRelative(letter.createdAt)}</span>
      </div>

      <div className="hib-row-subject-line">
        <span className="hib-subject">{letter.subject || '(no subject)'}</span>
        <span className={`hib-type hib-type--${letter.type}`}>
          {LETTER_TYPE_LABEL[letter.type] ?? letter.type}
        </span>
      </div>

      <div className="hib-row-chips">
        {/* A triage run's project ("Ask Inbox Triage") only repeats its badge. */}
        {sender.project && letterOriginOf(letter).kind !== 'triage' && <span className="hib-chip">{sender.project}</span>}
        {sender.host && <span className="hib-chip">{sender.host}</span>}
        {replies > 0 && (
          <span className="hib-chip hib-chip-thread">{replies} in thread</span>
        )}
      </div>

      {letter.textPreview && <AgentText text={letter.textPreview} compact className="hib-preview" host={letter.sender?.host} sessionId={letter.sender?.sessionId} unknownSource={!letter.sender?.sessionId} />}

      {answered && (
        <div className="hib-answered-chip">
          Answered: {answered.label || answered.actionId}{answered.by ? ` by ${answeredByName(answered.by)}` : ''} · {formatRelative(answered.at)}
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
      {menu.state && (
        <ContextMenu
          point={menu.state.point}
          items={menuItems()}
          onClose={menu.close}
          ariaLabel="Letter actions"
          testId="letter-ctx-menu"
        />
      )}
    </div>
  );
});
