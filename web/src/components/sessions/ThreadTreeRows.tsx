/**
 * The tree drawer's list (spec 6.4 to 6.7): flattens the tree through the pure
 * thread-tree-rows helpers, renders `role="tree"`, owns the keyboard cursor
 * (roving tabindex, so WebKit's VoiceOver and :focus-visible both work), the
 * inline actions and their placeholders.
 *
 *  - inline Done keeps the drawer open and the row where it is (`sticky`, faded
 *    under `Open`) until the filter or search changes or the drawer closes;
 *  - inline Remove confirms first when there are visible follow-ups, then leaves
 *    a 44px `Removed · Undo` row with its OWN Undo for 8s (the toast only keeps
 *    the newest action), and moves the cursor to the next surviving sibling,
 *    else the previous one, else the parent;
 *  - a second click on the same action within 400ms is ignored.
 */
import {
  forwardRef, useCallback, useDeferredValue, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent,
} from 'react';
import type {
  ThreadActions, ThreadDraftRow, ThreadDrawerFilter, ThreadNavVia, ThreadPendingPage,
} from '@/components/sessions/thread-ui-contract';
import type { SessionPinnedMessage } from '@/types/session';
import type { SessionPinsApi } from '@/contexts/SessionPinsContext';
import { ThreadConfirm } from '@/components/sessions/ThreadConfirm';
import { alsoDoneTitle } from '@/components/sessions/ThreadStackHeader';
import { REMOVE_CONFIRM_BODY, removeQuestionTitle } from '@/components/sessions/ThreadStackMenu';
import { useThreadToast } from '@/components/sessions/ThreadPanelToast';
import { ThreadTreeRow, type TreeRowAction } from '@/components/sessions/ThreadTreeRow';
import { canRestorePins } from '@/hooks/useSessionPins';
import type { ThreadTree } from '@/utils/thread-tree';
import { statusOf, type ThreadLiveState, type ThreadMetaIndex } from '@/utils/thread-meta';
import {
  arrowLeft, arrowRight, firstMatchRowId, firstRowId, flattenTree, isNavigable, isTypeToSearchKey, lastRowId,
  noResultsText, stepRowId, survivorAfterRemove, type RemovedPinPlaceholder, type TreeRow,
} from '@/utils/thread-tree-rows';
import { log } from '@/utils/log';

export const PLACEHOLDER_MS = 8000;
/** A pin as logs name it: its id, or the message it sits on. A pin key without
 *  an id is NUL-joined with the passage itself, which never goes to a log. */
const pinLogRef = (pinKey: string): string => pinKey.split('\u0000')[0];

const DOUBLE_CLICK_MS = 400;

/**
 * Scroll a row into view inside the drawer's OWN scroller only (block: nearest).
 * `scrollIntoView` also scrolls every ancestor, which on the Homepage nudged the
 * horizontally scrolling session columns and moved the transcript (C7).
 */
function revealRow(el: HTMLElement | null): void {
  const box = el?.closest<HTMLElement>('.thread-drawer-scroll');
  if (!el || !box) return;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top;
  else if (r.bottom > b.bottom) box.scrollTop += Math.min(r.bottom - b.bottom, r.top - b.top);
}

/** `Answered 12 min ago` for the unread dot's tooltip. */
export function answeredAgo(atMs: number | undefined, nowMs: number): string | undefined {
  if (atMs === undefined) return undefined;
  const min = Math.floor(Math.max(0, nowMs - atMs) / 60_000);
  if (min < 1) return 'Answered just now';
  if (min < 60) return `Answered ${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Answered ${h} h ago`;
  return `Answered ${Math.floor(h / 24)} d ago`;
}

export interface ThreadTreeRowsHandle {
  focusCursor: () => void;
  focusFirstMatch: () => void;
  /** Enter in the search box: open the first match. False when there is none. */
  openFirstMatch: () => boolean;
}

export interface ThreadTreeRowsProps {
  sessionId: string;
  tree: ThreadTree;
  index: ThreadMetaIndex;
  pins: SessionPinnedMessage[];
  pinsApi: SessionPinsApi;
  live: ReadonlyMap<string, ThreadLiveState>;
  drafts: ThreadDraftRow[];
  pending?: ThreadPendingPage;
  currentKey: string;
  unreadKeys: ReadonlySet<string>;
  answeredAt: ReadonlyMap<string, number>;
  actions: ThreadActions;
  filter: ThreadDrawerFilter;
  query: string;
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (key: string) => void;
  doneGroupsOpen: ReadonlySet<string>;
  onToggleDoneGroup: (key: string) => void;
  showHidden: boolean;
  loading: boolean;
  revealNonce: number;
  onNavigate: (key: string, via: ThreadNavVia) => void;
  onJumpPin: (pinKey: string, threadKey: string) => void;
  /** A row jump happened: close the drawer. */
  onJumped: () => void;
  onEscape: () => void;
  onTypeToSearch: (char: string) => void;
  onFocusSearch: () => void;
  onShowAll: () => void;
  /** A confirm layer opened or closed (peek must not close meanwhile). */
  onOverlayChange: (open: boolean) => void;
}

interface ConfirmState {
  /** Remove with visible follow-ups, or Done with open ones (N20: the same
   *  question the page header asks, `Also archive <N> follow-ups?`). */
  kind: 'remove' | 'done';
  row: TreeRow;
  anchor: HTMLElement;
  count: number;
}

export const ThreadTreeRows = forwardRef<ThreadTreeRowsHandle, ThreadTreeRowsProps>(function ThreadTreeRows(p, ref) {
  const toast = useThreadToast();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [sticky, setSticky] = useState<ReadonlySet<string>>(() => new Set());
  const [removedThreads, setRemovedThreads] = useState<ReadonlySet<string>>(() => new Set());
  const [removedPins, setRemovedPins] = useState<readonly RemovedPinPlaceholder[]>([]);
  const removedPinObjects = useRef(new Map<string, SessionPinnedMessage>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const lastClick = useRef(new Map<string, number>());
  const [cursorId, setCursorId] = useState<string | undefined>(undefined);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [pulseId, setPulseId] = useState<string | null>(null);

  // Settled rows leave once the view changes (spec 6.5).
  useEffect(() => { setSticky(new Set()); }, [p.filter, p.query]);
  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); }, []);
  useEffect(() => { p.onOverlayChange(confirm !== null); }, [confirm]); // eslint-disable-line react-hooks/exhaustive-deps

  // The list follows the search through a deferred value: a keystroke paints the
  // input at once and the rows re-render right after, interruptibly (C38). Enter
  // and ArrowDown in the search read a FRESH flatten, never the lagging list.
  const query = useDeferredValue(p.query);
  const optsFor = useCallback((q: string) => ({
    filter: p.filter, query: q, collapsed: p.collapsed, doneGroupsOpen: p.doneGroupsOpen,
    showHidden: p.showHidden, pending: p.pending, drafts: p.drafts, currentKey: p.currentKey,
    sticky, removedThreads, removedPins,
  }), [p.filter, p.collapsed, p.doneGroupsOpen, p.showHidden, p.pending, p.drafts, p.currentKey,
    sticky, removedThreads, removedPins]);
  const flat = useMemo(() => flattenTree(p.tree, p.index, p.pins, p.live, optsFor(query)),
    [p.tree, p.index, p.pins, p.live, optsFor, query]);
  const freshRows = () => (query === p.query ? rowsRef.current : flattenTree(p.tree, p.index, p.pins, p.live, optsFor(p.query)).rows);
  const rows = flat.rows;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const currentRowId = useMemo(() => rows.find((r) => r.current)?.id, [rows]);
  // Keep the cursor on a live row: the current page first, then the top.
  const cursor = cursorId && rows.some((r) => r.id === cursorId && isNavigable(r)) ? cursorId : currentRowId ?? firstRowId(rows);

  // Compared by value, never by selector: a quote key carries a NUL separator,
  // which CSS.escape turns into U+FFFD, so an attribute selector never matches.
  const elOf = useCallback((id: string | undefined): HTMLElement | null => {
    if (!id || !listRef.current) return null;
    for (const el of listRef.current.querySelectorAll<HTMLElement>('[data-row-id]')) {
      if (el.getAttribute('data-row-id') === id) return el;
    }
    return null;
  }, []);
  /** `scroll: false` after a removal: the rows around a placeholder never move (C66). */
  const focusRow = useCallback((id: string | undefined, scroll = true) => {
    if (!id) return;
    setCursorId(id);
    // The row may render a frame later (deferred list): retry a few frames.
    let tries = 0;
    const go = () => {
      const el = elOf(id);
      if (!el && tries++ < 6) { requestAnimationFrame(go); return; }
      el?.focus({ preventScroll: true });
      if (scroll) revealRow(el);
    };
    requestAnimationFrame(go);
  }, [elOf]);

  const dropTimer = (id: string) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
  };
  const dropThreadPlaceholder = useCallback((key: string) => {
    dropTimer(`t:${key}`);
    setRemovedThreads((s) => { if (!s.has(key)) return s; const n = new Set(s); n.delete(key); return n; });
  }, []);
  const dropPinPlaceholder = useCallback((pinKey: string) => {
    dropTimer(`p:${pinKey}`);
    setRemovedPins((l) => l.filter((r) => r.pinKey !== pinKey));
  }, []);

  const removeThread = useCallback(async (row: TreeRow) => {
    const survivor = survivorAfterRemove(rowsRef.current, row.id);
    setRemovedThreads((s) => new Set(s).add(row.key));
    timers.current.set(`t:${row.key}`, setTimeout(() => dropThreadPlaceholder(row.key), PLACEHOLDER_MS));
    if (survivor) focusRow(survivor, false);
    const ok = await p.actions.remove(row.key);
    if (!ok) dropThreadPlaceholder(row.key);
  }, [p.actions, focusRow, dropThreadPlaceholder]);

  const removePin = useCallback((row: TreeRow) => {
    if (!row.pinKey) return;
    const pinKey = row.pinKey;
    const survivor = survivorAfterRemove(rowsRef.current, row.id);
    const removed = p.pinsApi.unpin(pinKey) as SessionPinnedMessage | undefined | void;
    log.info('threads', 'pin removed from the drawer', { sessionId: p.sessionId, pinRef: pinLogRef(pinKey) });
    if (survivor) focusRow(survivor, false);
    if (!removed || !canRestorePins(p.pinsApi)) return;
    const api = p.pinsApi;
    removedPinObjects.current.set(pinKey, removed);
    const at = rowsRef.current.filter((r) => r.parentRowId === row.parentRowId && (r.kind === 'pin' || r.removedOf === 'pin'))
      .findIndex((r) => r.id === row.id);
    setRemovedPins((l) => [...l, { pinKey, threadKey: row.key, at: at < 0 ? undefined : at }]);
    timers.current.set(`p:${pinKey}`, setTimeout(() => dropPinPlaceholder(pinKey), PLACEHOLDER_MS));
    toast.show({
      text: 'Removed pin', ms: PLACEHOLDER_MS,
      action: { label: 'Undo', run: () => { api.restorePin(removed); dropPinPlaceholder(pinKey); } },
    });
  }, [p.pinsApi, p.sessionId, focusRow, toast, dropPinPlaceholder]);

  /** Remove, confirming first when the question has visible follow-ups. */
  const askRemove = useCallback((row: TreeRow, anchor: HTMLElement | null) => {
    if (row.kind === 'pin') { removePin(row); return; }
    if (row.kind !== 'thread') return;
    const count = p.actions.visibleDescendantCount(row.key);
    if (count > 0 && anchor) setConfirm({ kind: 'remove', row, anchor, count });
    else void removeThread(row);
  }, [p.actions, removePin, removeThread]);

  const markDone = useCallback((row: TreeRow, anchor: HTMLElement | null = null, withFollowUps?: boolean) => {
    const open = withFollowUps === undefined ? p.actions.openBelowCount(row.key) : 0;
    const at = anchor ?? elOf(row.id);
    if (open > 0 && at) { setConfirm({ kind: 'done', row, anchor: at, count: open }); return; }
    setSticky((s) => new Set(s).add(row.key));
    setCursorId(row.id);
    void (withFollowUps ? p.actions.doneWithFollowUps(row.key) : p.actions.done(row.key));
  }, [p.actions, elOf]);

  const onAction = useCallback((row: TreeRow, action: TreeRowAction, el: HTMLElement | null) => {
    const id = `${action}\u0000${row.id}`;
    const now = Date.now();
    const prev = lastClick.current.get(id);
    if (prev !== undefined && now - prev < DOUBLE_CLICK_MS) return;
    lastClick.current.set(id, now);
    if (action === 'done') markDone(row, el?.closest<HTMLElement>('.thread-tree-row') ?? el);
    else if (action === 'reopen') void p.actions.reopen(row.key);
    else if (action === 'not-yet') void p.actions.notYet(row.key);
    else if (action === 'restore') void p.actions.restore(row.key);
    else if (action === 'remove') askRemove(row, el?.closest<HTMLElement>('.thread-tree-row') ?? el);
    else if (action === 'undo-removed') {
      if (row.removedOf === 'pin' && row.pinKey) {
        const pin = removedPinObjects.current.get(row.pinKey);
        if (pin && canRestorePins(p.pinsApi)) p.pinsApi.restorePin(pin);
        dropPinPlaceholder(row.pinKey);
      } else {
        void p.actions.restore(row.key);
        dropThreadPlaceholder(row.key);
      }
      log.info('threads', 'undo from a drawer placeholder', {
        sessionId: p.sessionId, headId: p.tree.byKey.get(row.key)?.headId ?? '',
        ...(row.pinKey ? { pinRef: pinLogRef(row.pinKey) } : {}),
      });
    }
  }, [p.actions, p.pinsApi, p.sessionId, markDone, askRemove, dropPinPlaceholder, dropThreadPlaceholder]);

  const activate = useCallback((row: TreeRow) => {
    setCursorId(row.id);
    switch (row.kind) {
      case 'done-group': if (!row.disclosureDisabled) p.onToggleDoneGroup(row.key); return;
      case 'hidden': onAction(row, 'restore', null); return;
      case 'pin': p.onJumpPin(row.pinKey ?? '', row.key); p.onJumped(); return;
      case 'root': case 'thread': case 'pending': case 'draft':
        if (!row.current) p.onNavigate(row.key, 'drawer');
        p.onJumped();
        return;
      default:
    }
  }, [p, onAction]);

  const onFocusRow = useCallback((row: TreeRow) => setCursorId(row.id), []);

  const toggleRow = useCallback((row: TreeRow) => {
    if (row.kind === 'done-group') { if (!row.disclosureDisabled) p.onToggleDoneGroup(row.key); }
    else p.onToggleCollapsed(row.key);
  }, [p]);

  const toggleDone = useCallback((row: TreeRow) => {
    if (row.kind !== 'thread') return;
    if (statusOf(p.tree.byKey.get(row.key), p.index) === 'resolved') onAction(row, 'reopen', null);
    else onAction(row, 'done', null);
  }, [p.tree, p.index, onAction]);

  const renameSave = useCallback((row: TreeRow, text: string) => {
    setRenamingId(null);
    void p.actions.rename(row.key, text);
    focusRow(row.id);
  }, [p.actions, focusRow]);
  const renameCancel = useCallback(() => {
    const id = renamingId;
    setRenamingId(null);
    if (id) focusRow(id);
  }, [renamingId, focusRow]);

  // Rows are memoized: hand them callbacks that never change identity and read
  // the newest handlers (one search keystroke then re-renders only the rows
  // whose content changed, C38).
  const latest = useRef({ activate, toggleRow, onAction, renameSave, renameCancel, onFocusRow });
  latest.current = { activate, toggleRow, onAction, renameSave, renameCancel, onFocusRow };
  const stable = useMemo(() => ({
    activate: (r: TreeRow) => latest.current.activate(r),
    toggleRow: (r: TreeRow) => latest.current.toggleRow(r),
    onAction: (r: TreeRow, a: TreeRowAction, el: HTMLElement) => latest.current.onAction(r, a, el),
    renameSave: (r: TreeRow, t: string) => latest.current.renameSave(r, t),
    renameCancel: () => latest.current.renameCancel(),
    onFocusRow: (r: TreeRow) => latest.current.onFocusRow(r),
  }), []);

  useImperativeHandle(ref, () => ({
    focusCursor: () => focusRow(cursor),
    focusFirstMatch: () => focusRow(firstMatchRowId(freshRows())),
    openFirstMatch: () => {
      const fresh = freshRows();
      const id = firstMatchRowId(fresh);
      const row = fresh.find((r) => r.id === id);
      if (!row || row.kind === 'root' && flat.filtering) return false;
      activate(row);
      return true;
    },
  }), [focusRow, cursor, activate, flat.filtering, query, p.query, p.tree, p.index, p.pins, p.live, optsFor]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (renamingId || e.nativeEvent.isComposing) return;
    const all = rowsRef.current;
    const row = all.find((r) => r.id === cursor);
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    const take = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Escape') { take(); p.onEscape(); return; }
    if (!plain) return; // modifier combos pass through (the drawer chord is routed elsewhere)
    switch (e.key) {
      case 'ArrowDown': take(); focusRow(stepRowId(all, cursor, 1) ?? undefined); return;
      case 'ArrowUp': {
        take();
        const up = stepRowId(all, cursor, -1);
        if (up === null) p.onFocusSearch(); else focusRow(up);
        return;
      }
      case 'Home': take(); focusRow(firstRowId(all)); return;
      case 'End': take(); focusRow(lastRowId(all)); return;
      case 'ArrowRight': {
        take();
        const r = arrowRight(all, cursor);
        if (r.type === 'expand') toggleRow(r.row);
        else if (r.type === 'move') focusRow(r.id);
        return;
      }
      case 'ArrowLeft': {
        take();
        const r = arrowLeft(all, cursor);
        if (r.type === 'collapse') toggleRow(r.row);
        else if (r.type === 'move') focusRow(r.id);
        return;
      }
      case 'Enter': take(); if (row) activate(row); return;
      case ' ': take(); if (row) toggleDone(row); return;
      case 'Delete': case 'Backspace': take(); if (row) askRemove(row, elOf(row.id)); return;
      case 'F2': take(); if (row?.kind === 'thread') setRenamingId(row.id); return;
      default:
        if (isTypeToSearchKey(e)) { take(); p.onTypeToSearch(e.key); }
    }
  }, [renamingId, cursor, p, focusRow, toggleRow, activate, toggleDone, askRemove, elOf]);

  // Opening: the current row scrolls in (nearest). `Show in tree` also pulses it.
  const revealed = useRef(-1);
  useLayoutEffect(() => {
    const id = currentRowId;
    if (!id) return;
    revealRow(elOf(id));
    if (revealed.current !== -1 && revealed.current !== p.revealNonce) {
      setPulseId(id);
      const t = setTimeout(() => setPulseId(null), 1200);
      revealed.current = p.revealNonce;
      return () => clearTimeout(t);
    }
    revealed.current = p.revealNonce;
    return undefined;
  }, [p.revealNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const now = Date.now();
  if (p.loading) {
    return (
      <div className="thread-tree" role="tree" aria-label="All questions" aria-busy="true">
        {[0, 1, 2].map((i) => <div key={i} className="thread-tree-skeleton" aria-hidden="true" />)}
      </div>
    );
  }
  return (
    <>
      <div ref={listRef} className="thread-tree" role="tree" aria-label="All questions" onKeyDown={onKeyDown}>
        {rows.map((row) => (
          <ThreadTreeRow
            key={row.id}
            row={row}
            cursor={row.id === cursor}
            pulse={row.id === pulseId}
            renaming={row.id === renamingId}
            unreadTitle={p.unreadKeys.has(row.key) && row.kind === 'thread' ? answeredAgo(p.answeredAt.get(row.key), now) ?? 'Answered' : undefined}
            onActivate={stable.activate}
            onToggle={stable.toggleRow}
            onAction={stable.onAction}
            onRenameSave={stable.renameSave}
            onRenameCancel={stable.renameCancel}
            onFocusRow={stable.onFocusRow}
          />
        ))}
        {flat.noResults && (
          <div className="thread-tree-empty" role="presentation">
            <span>{noResultsText(query.trim())}</span>
            <button type="button" className="thread-tree-text-btn" onClick={p.onShowAll}>Show all</button>
          </div>
        )}
      </div>
      {confirm?.kind === 'done' && (
        <ThreadConfirm
          anchorEl={confirm.anchor}
          title={alsoDoneTitle(confirm.count)}
          confirmLabel="Archive all"
          cancelLabel="Only this one"
          neutral
          onConfirm={() => { const r = confirm.row; setConfirm(null); markDone(r, null, true); focusRow(r.id); }}
          onCancel={() => { const r = confirm.row; setConfirm(null); markDone(r, null, false); focusRow(r.id); }}
          onDismiss={() => { const r = confirm.row; setConfirm(null); focusRow(r.id); }}
        />
      )}
      {confirm?.kind === 'remove' && (
        <ThreadConfirm
          anchorEl={confirm.anchor}
          title={removeQuestionTitle(confirm.count)}
          body={REMOVE_CONFIRM_BODY}
          confirmLabel="Remove"
          cancelLabel="Cancel"
          danger
          onConfirm={() => { const r = confirm.row; setConfirm(null); void removeThread(r); }}
          onCancel={() => { const r = confirm.row; setConfirm(null); focusRow(r.id); }}
        />
      )}
    </>
  );
});

