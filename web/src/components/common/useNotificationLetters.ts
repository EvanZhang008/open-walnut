/**
 * The notification center's letters: the Inbox list (read from the letter store, not the feed),
 * its Unread filter and layout, the letter open in the reader, and the letter mutations (read,
 * pin, archive). Split out of NotificationPanel.tsx, which renders the reader and the Inbox pane.
 *
 * Letters live in their OWN store (durable documents), so the rail reads them from there instead
 * of from the 200-entry feed, which can have dropped a letter's envelope while the letter itself
 * is still in the inbox. Fetching is gated on the panel being open; every letter WS event
 * refreshes it (D8).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { takeInboxReturn } from '@/components/inbox/item-drafts';
import { isInboxLayout, type InboxLayout } from '@/components/inbox/InboxPane';
import { filterInboxLetters, readUnreadOnlyPref, writeUnreadOnlyPref } from '@/components/inbox/inbox-filter';
import { useHumanInbox } from '@/hooks/useHumanInbox';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { usePageView } from '@/utils/view-memory';
import { log } from '@/utils/log';
import { useNotifications } from '@/contexts/notifications';
import {
  setLetterArchived, setLetterPinned, setLetterRead,
  type LetterEnvelope,
} from '@/api/human-inbox';
import type { RailSection } from './NotificationRail';

export function useNotificationLetters(open: boolean, section: RailSection) {
  const { markLocalRead } = useNotifications();
  const [showArchived, setShowArchived] = useState(false);
  const [openLetterId, setOpenLetterId] = useState<string | null>(null);
  // Cards remain the default for existing installs; an explicit Split choice is kept.
  const [inboxLayout, setInboxLayout] = usePageView<InboxLayout>('inbox', 'layout', 'cards', isInboxLayout);
  const inboxSplit = section === 'inbox' && inboxLayout === 'split';
  const location = useLocation();
  const returningLetter = useRef<string | undefined>(undefined);
  // A letter a link opened onto a closed center: closing it takes the center with it, back to where the link was.
  const linkOpened = useRef(false);
  const linkPending = useRef(false);
  useEffect(() => {
    const restoreReturn = () => {
      const letterId = takeInboxReturn();
      if (!letterId) return;
      returningLetter.current = letterId;
      // Both the Sidebar and this panel install listeners on mount. Restore after those effects.
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('notification:open-center', { detail: { letterId } })));
    };
    restoreReturn();
    window.addEventListener('popstate', restoreReturn);
    return () => window.removeEventListener('popstate', restoreReturn);
  }, [location.key, location.pathname, location.search]);
  useEffect(() => {
    const restore = (event: Event) => {
      const letterId = (event as CustomEvent).detail?.letterId;
      if (typeof letterId === 'string') {
        returningLetter.current = letterId;
        if (open) { setOpenLetterId(letterId); returningLetter.current = undefined; }
        else linkPending.current = (event as CustomEvent).detail?.link === true;
      }
    };
    window.addEventListener('notification:open-center', restore);
    return () => window.removeEventListener('notification:open-center', restore);
  }, [open]);
  useEffect(() => {
    if (open && returningLetter.current) {
      linkOpened.current = linkPending.current;
      linkPending.current = false;
      setOpenLetterId(returningLetter.current);
      returningLetter.current = undefined;
    }
  }, [open]);
  const inbox = useHumanInbox({ enabled: open, archived: showArchived });
  const inboxRef = useRef(inbox);
  inboxRef.current = inbox;

  // The Inbox "Unread" filter. `keptReadIds` are the letters read WHILE it was
  // on: they stay listed until the filter flips or the panel closes, so opening
  // one does not pull its row out from under the cursor (inbox-filter.ts).
  const [unreadOnly, setUnreadOnly] = useState(readUnreadOnlyPref);
  const [keptReadIds, setKeptReadIds] = useState<ReadonlySet<string>>(() => new Set());
  const unreadOnlyRef = useRef(unreadOnly);
  unreadOnlyRef.current = unreadOnly;
  const toggleUnreadOnly = useCallback(() => {
    const next = !unreadOnlyRef.current;
    writeUnreadOnlyPref(next);
    setUnreadOnly(next);
    setKeptReadIds(prev => (prev.size ? new Set() : prev));
  }, []);
  useEffect(() => {
    if (!open) setKeptReadIds(prev => (prev.size ? new Set() : prev));
  }, [open]);
  const inboxRows = useMemo(
    () => filterInboxLetters(inbox.letters, unreadOnly, keptReadIds),
    [inbox.letters, unreadOnly, keptReadIds],
  );

  // Letter mutations: patch locally (the panel must feel instant), call the
  // route, resync on failure. Read state ALSO mirrors onto the feed envelope so
  // the bell badge drops without waiting for the WS round-trip.
  const markLetterRead = useCallback((id: string, read = true) => {
    const current = inboxRef.current.byId.get(id);
    if (current && current.read === read) return;
    markLocalRead([`letter:${id}`], read);
    if (read && unreadOnlyRef.current) {
      setKeptReadIds(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
    }
    // The store stamps `readAt` on the flip (letter-store.ts mergeLetterPatch):
    // that is the clock behind a read decision's grace window (isOpenDecision).
    void inboxRef.current.applyChange(id, { read }, () => setLetterRead(id, read), 'read');
  }, [markLocalRead]);

  const toggleLetterPin = useCallback((letter: LetterEnvelope) => {
    const pinned = !letter.pinned;
    void inboxRef.current.applyChange(letter.id, { pinned }, () => setLetterPinned(letter.id, pinned), 'pin');
  }, []);

  // Archiving moves the letter between the live feed and the Archived view, so
  // the list is re-read once the route settles rather than left showing a row
  // that no longer belongs to the current filter.
  const toggleLetterArchive = useCallback((letter: LetterEnvelope) => {
    const archived = !letter.archived;
    void inboxRef.current
      .applyChange(letter.id, { archived }, () => setLetterArchived(letter.id, archived), 'archive')
      .then(() => inboxRef.current.refresh());
  }, []);

  const openLetter = useCallback((id: string) => {
    linkOpened.current = false;
    setOpenLetterId(id);
    log.info('inbox', 'letter reader opened', { letterId: id });
  }, []);

  const changeInboxLayout = useLeanCallback((next: InboxLayout) => {
    // A choice to leave the right reader is not a request to open a modal over the list.
    if (inboxSplit && next !== 'split') setOpenLetterId(null);
    setInboxLayout(next);
  }, [inboxSplit, setInboxLayout]);

  // Closing the panel closes the reader with it (the reader renders inside the
  // panel's portal): without this, the next panel open would silently pop the
  // letter the user had already walked away from.
  useEffect(() => { if (!open) { setOpenLetterId(null); linkOpened.current = false; } }, [open]);

  return {
    inbox, inboxRows, inboxLayout, inboxSplit, changeInboxLayout,
    showArchived, toggleArchived: () => setShowArchived(v => !v),
    unreadOnly, toggleUnreadOnly,
    openLetterId, setOpenLetterId, openLetter, linkOpened,
    markLetterRead, toggleLetterPin, toggleLetterArchive,
  };
}
