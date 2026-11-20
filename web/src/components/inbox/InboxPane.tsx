/**
 * The Inbox rail body inside the notification panel: envelope rows from the
 * LETTER STORE (not the notification feed), pinned first then newest.
 *
 * Lives here rather than in NotificationPanel so the inbox feature stays in one
 * folder and the panel file stops growing; the panel owns the state and passes
 * the mutations in.
 */
import { type ReactNode } from 'react';
import { usePageView } from '@/utils/view-memory';
import { LetterEnvelopeRow } from './LetterEnvelopeRow';
import type { LetterEnvelope } from '@/api/human-inbox';
import '@/styles/human-inbox.css';
import '@/styles/inbox-split.css';

export type InboxLayout = 'cards' | 'split';
export const isInboxLayout = (v: unknown): v is InboxLayout => v === 'cards' || v === 'split';
type InboxDensity = 'compact' | 'roomy';
const isInboxDensity = (v: unknown): v is InboxDensity => v === 'compact' || v === 'roomy';

export function InboxPane({
  letters, loaded, error, showArchived, onToggleArchived, unreadOnly, onToggleUnreadOnly,
  onOpen, onNavigate, onTogglePin, onToggleArchive, onToggleRead,
  layout, onLayoutChange, selectedId, reader,
}: {
  layout: InboxLayout;
  onLayoutChange: (layout: InboxLayout) => void;
  selectedId: string | null;
  reader?: ReactNode;
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
  onNavigate: (to: string) => void;
  onTogglePin: (letter: LetterEnvelope) => void;
  onToggleArchive: (letter: LetterEnvelope) => void;
  onToggleRead: (letter: LetterEnvelope) => void;
}) {
  const [density, setDensity] = usePageView<InboxDensity>('inbox', 'density', 'roomy', isInboxDensity);
  const split = layout === 'split';
  const emptyText = !loaded
    ? 'Loading letters…'
    : unreadOnly
      ? (showArchived ? 'Nothing unread in the archive' : 'No unread letters')
      : (showArchived ? 'Nothing archived' : 'No letters yet');
  return (
    <div className={`notification-feed hib-inbox-pane${split ? ' hib-inbox-split' : ''}`} data-density={density} data-layout={layout}>
      <div className="hib-toolbar">
        <div className="hib-view-choices" role="group" aria-label="Inbox layout">
          <button className="hib-row-btn" aria-pressed={!split} onClick={() => onLayoutChange('cards')}>Cards</button>
          <button className="hib-row-btn" aria-pressed={split} onClick={() => onLayoutChange('split')}>Split</button>
        </div>
        <div className="hib-view-choices" role="group" aria-label="Inbox density">
          <button className="hib-row-btn" aria-pressed={density === 'compact'} onClick={() => setDensity('compact')}>Compact</button>
          <button className="hib-row-btn" aria-pressed={density === 'roomy'} onClick={() => setDensity('roomy')}>Roomy</button>
        </div>
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
      <div className="hib-inbox-columns">
        <div className="hib-inbox-index" aria-label="Letters">
      {letters.length === 0 ? (
        <div className="notification-feed-empty">{emptyText}</div>
      ) : (
        <div className="hib-list">
          {letters.map(letter => (
            <LetterEnvelopeRow
              key={letter.id}
              letter={letter}
              indexRow={split}
              selected={split && selectedId === letter.id}
              onOpen={() => onOpen(letter.id)}
              onNavigate={onNavigate}
              onTogglePin={() => onTogglePin(letter)}
              onToggleArchive={() => onToggleArchive(letter)}
              onToggleRead={() => onToggleRead(letter)}
            />
          ))}
        </div>
      )}
        </div>
        {split && <div className="hib-inbox-reader" aria-label="Letter reader">
          {reader ?? <div className="hib-split-empty">Select a letter to read and reply</div>}
        </div>}
      </div>
    </div>
  );
}
