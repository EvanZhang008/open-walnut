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
  letters, loaded, error, showArchived, onToggleArchived, onOpen, onTogglePin, onToggleArchive,
  onToggleRead,
}: {
  letters: LetterEnvelope[];
  loaded: boolean;
  error: string | null;
  showArchived: boolean;
  onToggleArchived: () => void;
  onOpen: (id: string) => void;
  onTogglePin: (letter: LetterEnvelope) => void;
  onToggleArchive: (letter: LetterEnvelope) => void;
  onToggleRead: (letter: LetterEnvelope) => void;
}) {
  return (
    <div className="notification-feed">
      <div className="hib-toolbar">
        <button className="hib-row-btn" onClick={onToggleArchived}>
          {showArchived ? '← Back to inbox' : 'Archived'}
        </button>
      </div>
      {error && <div className="hib-note hib-note-error">{error}</div>}
      {letters.length === 0 ? (
        <div className="notification-feed-empty">
          {!loaded ? 'Loading letters…' : showArchived ? 'Nothing archived' : 'No letters yet'}
        </div>
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
