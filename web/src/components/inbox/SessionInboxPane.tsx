/**
 * The session panel's Inbox TAB — the letters THIS session wrote, and the reader
 * for one of them, in the split column beside the live chat.
 *
 * Peer of Changed / Files / Terminal / Code: same `.session-panel-diff-col`
 * host, same `barRightSlot` contract for the panel's chat toggle, so chat-left +
 * letter-right comes from the existing split with no new layout machinery.
 *
 * The cross-session notification rail and this tab are two LENSES on one store,
 * never two states: rows come from the shared letter list (`useSessionLetters`),
 * and the letter itself is the same `LetterView` the rail's overlay renders.
 *
 * A file path in a letter opens in the panel's own Files split (via `onOpenFile`),
 * not in a modal — inside a session, a path click has always kept the user in the
 * session, and it keeps Escape single-layer in here.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useNotifications } from '@/contexts/notifications';
import { log } from '@/utils/log';
import {
  setLetterArchived, setLetterPinned, setLetterRead, type LetterEnvelope,
} from '@/api/human-inbox';
import { useSessionLetters } from '@/hooks/useSessionLetters';
import { LetterEnvelopeRow } from './LetterEnvelopeRow';
import { LetterView, type LetterFileTarget } from './LetterView';
import '@/styles/human-inbox.css';

interface SessionInboxPaneProps {
  sessionId: string;
  /** The letter open in place; null = the list. Owned by the panel so the
   *  selection survives a hop to another tab and back. */
  openLetterId: string | null;
  onOpenLetter: (letterId: string | null) => void;
  onNavigate: (to: string) => void;
  onOpenFile: (target: LetterFileTarget) => void;
  /** Chat segment of the full-width bar — see SessionFileExplorer.barRightSlot. */
  barRightSlot?: ReactNode;
}

export function SessionInboxPane({
  sessionId, openLetterId, onOpenLetter, onNavigate, onOpenFile, barRightSlot,
}: SessionInboxPaneProps) {
  // Destructured: `applyChange` / `mergeLetter` / `refresh` are stable, so the
  // row callbacks below don't churn on every render of the panel.
  const {
    letters, loaded, error, unreadCount, applyChange, refresh, mergeLetter, ownsLetter,
  } = useSessionLetters(sessionId);
  const { markLocalRead } = useNotifications();

  // Read state: patch the shared list AND the feed envelope, so the row, the tab
  // badge and the sidebar bell all drop without waiting for the WS round-trip.
  // The letter store stays canonical (the route is what actually decides).
  //
  // Via a ref, and skipped when nothing changes: opening a letter always asks for
  // read=true, and re-POSTing that for an already-read letter is one pointless
  // write per open (the callback must also not churn on every list update).
  const lettersRef = useRef(letters);
  lettersRef.current = letters;
  const markRead = useCallback((id: string, read = true) => {
    const current = lettersRef.current.find(l => l.id === id);
    if (current && current.read === read) return;
    markLocalRead([`letter:${id}`], read);
    void applyChange(id, { read }, () => setLetterRead(id, read), 'read');
  }, [applyChange, markLocalRead]);

  const onMarkRead = useCallback((id: string) => markRead(id, true), [markRead]);

  const togglePin = useCallback((letter: LetterEnvelope) => {
    const pinned = !letter.pinned;
    void applyChange(letter.id, { pinned }, () => setLetterPinned(letter.id, pinned), 'pin');
  }, [applyChange]);

  // Archiving takes the letter OUT of this tab (the archive shelf lives in the
  // notification rail), so the list is re-read once the route settles and an
  // archived letter that was open in place closes back to the list.
  const toggleArchive = useCallback((letter: LetterEnvelope) => {
    const archived = !letter.archived;
    void applyChange(letter.id, { archived }, () => setLetterArchived(letter.id, archived), 'archive')
      .then(() => {
        refresh();
        if (archived && openLetterId === letter.id) onOpenLetter(null);
      });
  }, [applyChange, refresh, openLetterId, onOpenLetter]);

  const open = useCallback((id: string) => {
    onOpenLetter(id);
    log.info('inbox', 'session letter opened', { sessionId, letterId: id });
  }, [onOpenLetter, sessionId]);

  // A letter id is untrusted input: it can arrive from a hand-written or stale
  // `?tab=inbox&letter=…` URL. Rendering another session's letter here would mark
  // it read, show a "← Letters" list it isn't in, and route its file paths at THIS
  // session's host (a remote path would resolve on the wrong machine). Only a
  // confirmed FOREIGN letter is refused — `null` (not in the live index: still
  // loading, or archived) still opens.
  const foreign = openLetterId !== null && ownsLetter(openLetterId) === false;
  useEffect(() => {
    if (!foreign || !openLetterId) return;
    log.warn('inbox', 'letter is not this session — showing the list', {
      sessionId, letterId: openLetterId,
    });
    onOpenLetter(null);
  }, [foreign, openLetterId, onOpenLetter, sessionId]);
  const readerId = foreign ? null : openLetterId;
  const envelope = readerId ? letters.find(l => l.id === readerId) : undefined;

  return (
    <div className="session-inbox-pane">
      <div className="session-inbox-bar">
        <span className="session-inbox-bar-title">Inbox</span>
        <span className="session-inbox-bar-sub">
          {letters.length === 0
            ? 'letters this session wrote to you'
            : `${letters.length} letter${letters.length === 1 ? '' : 's'}`}
          {unreadCount > 0 ? ` · ${unreadCount} unread` : ''}
        </span>
        <div className="session-inbox-bar-right">{barRightSlot}</div>
      </div>

      {readerId ? (
        <LetterView
          key={readerId}
          letterId={readerId}
          {...(envelope ? { envelope } : {})}
          embedded
          showOpenSession={false}
          headLeading={(
            <button
              className="hib-row-btn hib-back-btn"
              onClick={() => onOpenLetter(null)}
            >
              ← Letters
            </button>
          )}
          onLetterUpdated={mergeLetter}
          onMarkRead={onMarkRead}
          onTogglePin={togglePin}
          onToggleArchive={toggleArchive}
          onNavigate={onNavigate}
          onOpenFile={onOpenFile}
        />
      ) : (
        <div className="session-inbox-body">
          {error && <div className="hib-note hib-note-error">{error}</div>}
          {letters.length === 0 ? (
            <div className="session-inbox-empty">
              {!loaded
                ? 'Loading letters…'
                : 'This session hasn’t written you a letter yet. An agent sends one with '
                  + 'wn tools call human_inbox_send when it finishes something, needs a decision, '
                  + 'or has a report worth reading later.'}
            </div>
          ) : (
            <div className="hib-list">
              {letters.map(letter => (
                <LetterEnvelopeRow
                  key={letter.id}
                  letter={letter}
                  onOpen={() => open(letter.id)}
                  onTogglePin={() => togglePin(letter)}
                  onToggleArchive={() => toggleArchive(letter)}
                  onToggleRead={() => markRead(letter.id, !letter.read)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
