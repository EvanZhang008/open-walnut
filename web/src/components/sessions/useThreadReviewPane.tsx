/**
 * The timeline's review pane and the marks' own right-click menu, kept out of
 * SessionChatHistory: the fullscreen sidebar (ThreadReviewSidebar) with its
 * selection, what a mark click does while it shows (selects the card instead
 * of opening the popover), and the menu's "Open question" / "Quote in chat".
 * While the sidebar shows, opening a question (its row, its passage, the menu)
 * opens the question's full card over its review card, where the reader is
 * looking; the timeline stays put.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { useReviewSidebar } from '@/hooks/useReviewSidebar';
import type { SessionHistoryMessage } from '@/types/session';
import type { ThreadMark } from '@/utils/thread-mark-hit';
import type { ThreadMarkState } from '@/utils/thread-mark-state';
import type { ThreadMetaIndex } from '@/utils/thread-meta';
import type { ThreadTree } from '@/utils/thread-tree';
import { log } from '@/utils/log';
import { buildReviewEntries, reviewTurnIndex, ThreadReviewSidebar, withLiveAnswers, withSentQuestions } from './ThreadReviewSidebar';

export interface ThreadReviewPaneArgs {
  sessionId: string;
  containerRef: RefObject<HTMLDivElement | null>;
  conversationMode: boolean;
  hasQuestions: boolean;
  tree: ThreadTree;
  metaIndex: ThreadMetaIndex;
  numbers: ReadonlyMap<string, number>;
  messages: readonly SessionHistoryMessage[];
  /** Question key to the text of its answer streaming now (empty while the
   *  sidebar is not shown: the caller reads `on` back, see SessionChatHistory). */
  liveText: ReadonlyMap<string, string>;
  markStates: ReadonlyMap<string, ThreadMarkState>;
  openCard: (key: string, via: string) => void;
  quoteInChat: (key: string, via: string) => void;
  markViewed: (key: string) => void;
  /** The question whose full card is open over its review card. */
  enlargedKey: string | null;
  /** Question key to its newest question sent and not in history yet. */
  sentText: ReadonlyMap<string, string>;
}

export interface ThreadReviewPane {
  /** The sidebar shows (the history box gets its gutter). */
  on: boolean;
  /** A mark click: true when the pane took it (selected its card). */
  takeMarkClick: (key: string) => boolean;
  onMarkMenu: (key: string, at: { x: number; y: number }) => void;
  onMarks: (marks: readonly ThreadMark[]) => void;
  sidebar: ReactNode;
  menu: ReactNode;
  /** A question's review card on screen now (its open card is placed over it). */
  cardElement: (key: string) => HTMLElement | null;
}

export function useThreadReviewPane(a: ThreadReviewPaneArgs): ThreadReviewPane {
  const review = useReviewSidebar({ containerRef: a.containerRef, conversationMode: a.conversationMode, hasQuestions: a.hasQuestions });
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { setSelected(null); }, [a.sessionId, review.on]);

  const keys = useMemo(() => [...review.anchors].sort((x, y) => x[1] - y[1]).map(([k]) => k), [review.anchors]);
  // Nothing of this runs while the sidebar is not shown. The messages are
  // indexed once per change; a streamed token only redoes its own entry.
  const turns = useMemo(() => (review.on ? reviewTurnIndex(a.messages) : null), [review.on, a.messages]);
  const base = useMemo(() => (turns ? buildReviewEntries({
    keys, tree: a.tree, metaIndex: a.metaIndex, numbers: a.numbers, turns, markStates: a.markStates,
  }) : []), [turns, keys, a.tree, a.metaIndex, a.numbers, a.markStates]);
  const entries = useMemo(() => withLiveAnswers(withSentQuestions(base, a.sentText), a.liveText), [base, a.sentText, a.liveText]);

  const { markViewed, openCard, quoteInChat, sessionId } = a;
  const select = useCallback((key: string, via: string) => {
    setSelected(key);
    // Picked on purpose: its answer has been looked at (the card shows it).
    markViewed(key);
    log.info('threads', 'review card selected', { sessionId, key, via });
  }, [markViewed, sessionId]);
  const cardsRef = useRef(new Map<string, HTMLDivElement>());
  const cardElement = useCallback((key: string) => cardsRef.current.get(key) ?? null, []);
  const open = useCallback((key: string, via: string) => {
    select(key, via);
    openCard(key, 'review-enlarge');
  }, [select, openCard]);
  const openFromCard = useCallback((key: string) => open(key, 'card'), [open]);

  // The picked card shows its answer: one that lands while it is picked has
  // been seen (no red "New answer" on the card being read).
  // Only while the card is on screen and the window is in view: an answer that
  // lands with the reader elsewhere still turns red (the mark's own rule).
  const selectedState = selected ? a.markStates.get(selected) : undefined;
  const { containerRef } = a;
  const pickedInView = (key: string): boolean => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
    const card = cardsRef.current.get(key);
    const box = containerRef.current;
    if (!card || !box) return false;
    const c = card.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return c.bottom > b.top && c.top < b.bottom;
  };
  // Read in this render already (never painted red), stored right after.
  const readNow = review.on && !!selected && selectedState === 'unread' && pickedInView(selected);
  useEffect(() => {
    if (readNow && selected) markViewed(selected);
  }, [readNow, selected, markViewed]);
  const shown = useMemo(() => (readNow && selected
    ? entries.map((e) => (e.key === selected ? { ...e, state: 'read' as const } : e))
    : entries), [readNow, selected, entries]);

  // Closed: the keyboard goes back to its row when nothing else took it (the
  // row hid itself while the card lay over it).
  const lastOpen = useRef<string | null>(null);
  useEffect(() => {
    const was = lastOpen.current;
    lastOpen.current = a.enlargedKey;
    if (!was || a.enlargedKey) return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active && active !== document.body) return;
    cardsRef.current.get(was)?.querySelector<HTMLElement>('button.thread-review-head')?.focus({ preventScroll: true });
  }, [a.enlargedKey]);

  const takeMarkClick = useCallback((key: string) => {
    if (!review.on || !review.anchors.has(key)) return false;
    open(key, 'mark');
    return true;
  }, [review.on, review.anchors, open]);

  const [menuAt, setMenuAt] = useState<{ key: string; point: { x: number; y: number } } | null>(null);
  const onMarkMenu = useCallback((key: string, at: { x: number; y: number }) => setMenuAt({ key, point: at }), []);
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menuAt) return [];
    const key = menuAt.key;
    const inReview = review.on && review.anchors.has(key);
    return [
      { key: 'open', label: 'Open question', onSelect: () => (inReview ? open(key, 'mark-menu') : openCard(key, 'mark-menu')) },
      { key: 'quote', label: 'Quote in chat', onSelect: () => quoteInChat(key, 'mark-menu') },
    ];
  }, [menuAt, openCard, quoteInChat, review.on, review.anchors, open]);

  const sidebar = review.on ? (
    <ThreadReviewSidebar
      layerRef={review.layerRef} entries={shown} anchors={review.anchors} selected={selected}
      onOpen={openFromCard} enlarged={a.enlargedKey} cardsRef={cardsRef}
    />
  ) : null;
  const menu = menuAt ? (
    <ContextMenu point={menuAt.point} items={menuItems} onClose={() => setMenuAt(null)} ariaLabel="Question actions" testId="thread-mark-menu" />
  ) : null;
  return { on: review.on, takeMarkClick, onMarkMenu, onMarks: review.onMarks, sidebar, menu, cardElement };
}
