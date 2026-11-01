/**
 * The Inbox rail body inside the notification panel: envelope rows from the
 * LETTER STORE (not the notification feed), pinned first then newest.
 *
 * Lives here rather than in NotificationPanel so the inbox feature stays in one
 * folder and the panel file stops growing; the panel owns the state and passes
 * the mutations in.
 */
import { LetterEnvelopeRow } from './LetterEnvelopeRow';
import type { LetterEnvelope } from '@/api/human-inbox';
import '@/styles/human-inbox.css';

export function InboxPane({
  letters, loaded, error, showArchived, onToggleArchived, unreadOnly, onToggleUnreadOnly,
  onOpen, onTogglePin, onToggleArchive, onToggleRead,
}: {
  /** The rows to show — already narrowed by the Unread filter when it is on. */
  letters: LetterEnvelope[];
  loaded: boolean;
  error: string | null;
  showArchived: boolean;
  onToggleArchived: () => void;
  /** The Unread filter: on = only letters not yet read (plus the ones read while it was on). */
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  onOpen: (id: string) => void;
  onTogglePin: (letter: LetterEnvelope) => void;
  onToggleArchive: (letter: LetterEnvelope) => void;
  onToggleRead: (letter: LetterEnvelope) => void;
}) {
  const emptyText = !loaded
    ? 'Loading letters…'
    : unreadOnly
      ? (showArchived ? 'Nothing unread in the archive' : 'No unread letters')
      : (showArchived ? 'Nothing archived' : 'No letters yet');
  return (
    <div className="notification-feed">
      <div className="hib-toolbar">
        {/* A pressed toggle, not a checkbox: it reads as a filter chip in the
            row of buttons and the state is visible without a label change. */}
        <button
          className="hib-row-btn hib-filter-btn"
          aria-pressed={unreadOnly}
          onClick={onToggleUnreadOnly}
          title={unreadOnly ? 'Showing unread letters only' : 'Show unread letters only'}
        >
          Unread
        </button>
        <button className="hib-row-btn" onClick={onToggleArchived}>
          {showArchived ? '← Back to inbox' : 'Archived'}
        </button>
      </div>
      {error && <div className="hib-note hib-note-error">{error}</div>}
      {letters.length === 0 ? (
        <div className="notification-feed-empty">{emptyText}</div>
      ) : (
        <div className="hib-list">
          {letters.map(letter => (
            <LetterEnvelopeRow
              key={letter.id}
              letter={letter}
              onOpen={() => onOpen(letter.id)}
              onTogglePin={() => onTogglePin(letter)}
              onToggleArchive={() => onToggleArchive(letter)}
              onToggleRead={() => onToggleRead(letter)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
