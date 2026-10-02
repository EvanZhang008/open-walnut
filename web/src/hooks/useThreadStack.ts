/**
 * The question stack of one session panel (spec 5.4, 5.5): the path from the
 * main conversation to the page on screen, push / pop / cross-branch jumps, the
 * pending page an Ask opens, per-page drafts and landing records, reload
 * restore, the key router registration (Esc pops, Cmd/Ctrl+Shift+E toggles the
 * drawer) and `data-thread-depth` on the panel root.
 *
 * Only the page on screen renders; the timeline (SessionChatHistory) filters the
 * ONE row pipeline by `currentKey`. The pure rules live in thread-stack-state.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { SessionPinnedQuote, SessionThreadAnchor } from '@/types/session';
import type { ThreadStackApi, ThreadStackNav } from '@/contexts/SessionThreadsContext';
import type {
  ThreadDraftRow, ThreadDrawerFilter, ThreadDrawerMode, ThreadMetaIndex, ThreadNavBridge, ThreadNavVia,
  ThreadPendingPage, ThreadToastApi,
} from '@/components/sessions/thread-ui-contract';
import { usePanelKeyRouter } from '@/hooks/usePanelKeyRouter';
import { ROOT_THREAD_KEY, fileOfParent, findSamePassageThread, type ThreadTree } from '@/utils/thread-tree';
import { fallbackTitle } from '@/utils/thread-meta';
import {
  DRAFT_ROW_LABEL, composerDraftKey, escapeDecision, isPendingKey, pendingPageKey, planNavigation,
  stackPathOf, widthTier, type PageLanding,
} from '@/utils/thread-stack-state';
import {
  headIdsOfPath, pathForLeaf, readPersistedStack, readUrlLeaf, restorePath, setThreadLeaf,
  writePersistedStack, type PersistedStack,
} from '@/utils/thread-stack-persist';
import { nextSamePassageKeys } from '@/utils/thread-same-passage';
import { log } from '@/utils/log';

/** The widths `panelWidth` is compared against (the drawer toggle's narrow form, 560). */
const PANEL_WIDTH_TIERS = [560, 600, 720] as const;

export const HEAD_GONE_TEXT = 'This question is no longer in the transcript.';

export interface ComposerProbe {
  /** Is the composer's textarea focused? */
  focused: () => boolean;
  /** The composer's text right now (composed, chips included). */
  text: () => string;
}

export interface UseThreadStackArgs {
  sessionId: string;
  tree: ThreadTree;
  anchors: SessionThreadAnchor[];
  hiddenKeys: ReadonlySet<string>;
  metaIndex: ThreadMetaIndex;
  panelRef: RefObject<HTMLElement | null>;
  /** Tree Mode is chosen (not Conversation Mode). The stack is live when
   *  this holds AND the session has questions (or a pending page). */
  stackView: boolean;
  composer: ComposerProbe;
  toast: ThreadToastApi;
  /** Focus the composer without moving the timeline. */
  focusComposer: () => void;
  /** The whole transcript is loaded (not phase 1, not a windowed tail). Until
   *  then a reload restore whose page head is missing keeps waiting for it. */
  historyComplete?: boolean;
}

/** What a reload asks to land on: the stored path (head ids), else the URL's leaf. */
export type RestoreWant = { path: readonly string[] } | { leaf: string };

/**
 * One reload-restore attempt: the path to land on, `null` to give up (the root,
 * no toast), or `'wait'` while the page head may sit in a part of the transcript
 * that is not loaded yet (phase 1, a windowed tail).
 */
export function restoreAttempt(
  tree: ThreadTree,
  want: RestoreWant | null,
  hiddenKeys: ReadonlySet<string>,
  historyComplete: boolean,
): string[] | null | 'wait' {
  if (!want) return null;
  const path = 'path' in want ? restorePath(tree, want.path) : pathForLeaf(tree, want.leaf);
  if (!path) return historyComplete ? null : 'wait';
  if (path.length < 2 || path.some((k) => hiddenKeys.has(k))) return null;
  return path;
}

export interface ThreadDrawerState {
  mode: ThreadDrawerMode;
  setMode: (mode: ThreadDrawerMode) => void;
  filter?: ThreadDrawerFilter;
  revealNonce: number;
  showHidden: boolean;
  setShowHidden: (show: boolean) => void;
  open: (filter?: ThreadDrawerFilter) => void;
  reveal: () => void;
}

export interface ThreadStackHandle {
  api: ThreadStackApi;
  bridge: ThreadNavBridge;
  drawer: ThreadDrawerState;
  /** A pending page's first send landed under `key`: swap it in place. */
  promotePending: (key: string) => void;
  /** Head id to when that page was last on screen. */
  lastViewedAt: ReadonlyMap<string, number>;
  /** The stack is live (stack view, and questions or a pending page exist). */
  enabled: boolean;
  /**
   * Questions exist (or a pending page / a draft does), whichever view is on.
   * In Conversation Mode the path is not a page but the composer's TARGET: the
   * question a click on a turn label or a sidebar row selected, or the pending
   * question an Ask opened; the timeline stays unfiltered. Esc clears it.
   */
  active: boolean;
  /** The panel's width TIER (widthTier: 0 unmeasured or no questions; the
   *  toggle's narrow label reads it). */
  panelWidth: number;
}

interface StackState {
  path: string[];
  pending?: ThreadPendingPage;
  nav: ThreadStackNav | null;
  /** Pages on the path that carry the same-passage note (thread-same-passage.ts). */
  samePassageKeys: string[];
}

const ROOT_STATE: StackState = { path: [ROOT_THREAD_KEY], nav: null, samePassageKeys: [] };

function writeDraft(key: string, text: string) {
  try {
    if (text.trim()) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch { /* private browsing */ }
}

export function useThreadStack(args: UseThreadStackArgs): ThreadStackHandle {
  const { sessionId, tree } = args;
  const [state, setState] = useState<StackState>(ROOT_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const argsRef = useRef(args);
  argsRef.current = args;
  const landings = useRef(new Map<string, PageLanding>()).current;
  const capture = useRef<((from: string, to: string, pending?: ThreadPendingPage) => void) | null>(null);
  const seq = useRef(0);
  const [drafts, setDrafts] = useState<Map<string, ThreadPendingPage>>(() => new Map());
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  // A draft question (an unsent page left with text) keeps the stack on too: its
  // row is the way back to it.
  const active = tree.threads.length > 1 || !!state.pending || drafts.size > 0;
  const enabled = args.stackView && active;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const activeRef = useRef(active);
  activeRef.current = active;
  const lastViewed = useRef(new Map<string, number>());
  const [viewedTick, setViewedTick] = useState(0);
  /** The reload restore is decided (landed, given up, or the reader moved first). */
  const restored = useRef(false);
  /** What storage / the URL asked for, read once per session (later writes of
   *  this tab must not change what the reload wanted). */
  const restoreWant = useRef<{ want: RestoreWant | null; pages: PersistedStack['pages'] } | null>(null);
  const grace = useRef(new Map<string, number>());

  // Session switch: a fresh stack (never carry a page across transcripts).
  useEffect(() => {
    setState(ROOT_STATE);
    landings.clear();
    lastViewed.current = new Map();
    setDrafts(new Map());
    restored.current = false;
    restoreWant.current = null;
  }, [sessionId, landings]);

  const headOf = useCallback((key: string) => (key === ROOT_THREAD_KEY || isPendingKey(key)
    ? key : argsRef.current.tree.byKey.get(key)?.headId ?? key), []);

  const persist = useCallback(() => {
    const s = stateRef.current;
    const t = argsRef.current.tree;
    const pages: PersistedStack['pages'] = {};
    for (const [key, rec] of landings) {
      if (isPendingKey(key)) continue;
      pages[key === ROOT_THREAD_KEY ? '' : headOf(key)] = rec;
    }
    writePersistedStack(argsRef.current.sessionId, {
      path: headIdsOfPath(t, s.path),
      pages,
      lastViewedAt: Object.fromEntries(lastViewed.current),
      drafts: [...draftsRef.current.values()],
    });
  }, [landings, headOf]);

  const markViewed = useCallback((key: string) => {
    if (key === ROOT_THREAD_KEY || isPendingKey(key)) return;
    lastViewed.current.set(headOf(key), Date.now());
    setViewedTick((n) => n + 1);
  }, [headOf]);

  /** Every navigation goes through here: plan, capture the page being left,
   *  keep or drop a pending page's draft, then swap the path. */
  const navigate = useCallback((toPath: string[], via: ThreadNavVia, toPending?: ThreadPendingPage) => {
    const s = stateRef.current;
    const plan = planNavigation(s.path, toPath);
    if (plan.direction === 'none') return;
    // The reader moved before a waiting reload restore found its page: his move wins.
    restored.current = true;
    const a = argsRef.current;
    const text = a.composer.text();
    writeDraft(composerDraftKey(a.sessionId, plan.from, a.tree), text);
    if (s.pending && plan.from === s.pending.pageKey) {
      const left = s.pending;
      setDrafts((prev) => {
        const next = new Map(prev);
        if (text.trim()) next.set(left.pageKey, left); else next.delete(left.pageKey);
        return next;
      });
    }
    capture.current?.(plan.from, plan.pushed[0] ?? plan.to, toPending ?? s.pending);
    markViewed(plan.from);
    markViewed(plan.to);
    seq.current += 1;
    const firstEntry = !landings.has(plan.to);
    const pending = toPending ?? (s.pending && toPath.includes(s.pending.pageKey) ? s.pending : undefined);
    const next: StackState = {
      path: toPath,
      ...(pending ? { pending } : {}),
      nav: { seq: seq.current, from: plan.from, to: plan.to, direction: plan.direction, via, popped: plan.popped, firstEntry },
      samePassageKeys: nextSamePassageKeys(s.samePassageKeys, toPath, plan, via),
    };
    stateRef.current = next;
    setState(next);
    log.info('threads', plan.direction, {
      sessionId: a.sessionId, headId: headOf(plan.to), from: headOf(plan.from), to: headOf(plan.to), via,
    });
    queueMicrotask(persist);
  }, [landings, markViewed, headOf, persist]);

  const pushTo = useCallback((key: string, via: ThreadNavVia) => {
    const draft = draftsRef.current.get(key);
    if (draft) {
      navigate([...stackPathOf(argsRef.current.tree, draft.parentKey), draft.pageKey], via, draft);
      return;
    }
    // The pending page is no tree node: its path is its parent's plus itself
    // (the tree would path an unknown key to Main and drop the page).
    const pending = stateRef.current.pending;
    if (pending && key === pending.pageKey) {
      navigate([...stackPathOf(argsRef.current.tree, pending.parentKey), pending.pageKey], via, pending);
      return;
    }
    navigate(stackPathOf(argsRef.current.tree, key), via);
  }, [navigate]);

  const popTo = useCallback((key: string, via: ThreadNavVia) => {
    const path = stateRef.current.path;
    const at = path.indexOf(key);
    navigate(at >= 0 ? path.slice(0, at + 1) : stackPathOf(argsRef.current.tree, key), via);
  }, [navigate]);

  const back = useCallback((via: ThreadNavVia) => {
    const path = stateRef.current.path;
    if (path.length > 1) navigate(path.slice(0, -1), via);
  }, [navigate]);

  const popToVisibleAncestor = useCallback((key: string) => {
    const path = stateRef.current.path;
    const at = path.indexOf(key);
    if (at <= 0) return;
    let target = at - 1;
    while (target > 0 && argsRef.current.hiddenKeys.has(path[target])) target--;
    navigate(path.slice(0, target + 1), 'remove');
  }, [navigate]);

  /** Ask on a passage (spec 5.4): the question already about this exact passage,
   *  or a pending page on top of the page the passage is on. Nothing is written. */
  const ask = useCallback((target: { msgId: string; quote: SessionPinnedQuote; line?: number }, opts?: { focusComposer?: boolean }) => {
    const a = argsRef.current;
    const focus = opts?.focusComposer !== false;
    const same = findSamePassageThread(a.tree, a.anchors, a.hiddenKeys, { parent: target.msgId, quote: target.quote });
    if (same) {
      navigate(stackPathOf(a.tree, same), 'same-passage');
      if (focus) a.focusComposer();
      return;
    }
    // A passage in an answer that is still streaming (or not refetched yet) is
    // not in the tree: it is on the page on screen, so the question goes on top
    // of THAT page, never under Main (C4). A passage of a FILE hangs off root.
    const s = stateRef.current;
    const isFile = fileOfParent(target.msgId) !== null;
    const onScreen = s.pending ? s.pending.parentKey : (s.path[s.path.length - 1] ?? ROOT_THREAD_KEY);
    const known = isFile ? ROOT_THREAD_KEY : a.tree.byRow.get(target.msgId)?.key;
    const parentKey = known ?? onScreen;
    const pending: ThreadPendingPage = {
      pageKey: pendingPageKey(target.msgId, target.quote.exact),
      parentKey,
      parentMsgId: target.msgId,
      quote: target.quote,
      ...(isFile && target.line ? { line: target.line } : {}),
      title: fallbackTitle(target.quote.exact),
    };
    const base = known !== undefined ? stackPathOf(a.tree, parentKey) : (s.pending ? s.path.slice(0, -1) : s.path);
    navigate([...(base.length ? base : [ROOT_THREAD_KEY]), pending.pageKey], 'ask', pending);
    if (focus) a.focusComposer();
  }, [navigate]);

  const openDraft = useCallback((pageKey: string) => pushTo(pageKey, 'draft'), [pushTo]);

  /** The first send of a pending page: the page becomes the question in place
   *  (same scroll box, no animation), its draft row and draft text go away. */
  const promotePending = useCallback((key: string) => {
    const s = stateRef.current;
    if (!s.pending) return;
    const pageKey = s.pending.pageKey;
    writeDraft(composerDraftKey(argsRef.current.sessionId, pageKey, argsRef.current.tree), '');
    setDrafts((prev) => {
      if (!prev.has(pageKey)) return prev;
      const next = new Map(prev);
      next.delete(pageKey);
      return next;
    });
    const rec = landings.get(pageKey);
    if (rec) { landings.set(key, rec); landings.delete(pageKey); }
    grace.current.set(key, Date.now() + 15_000);
    const next: StackState = {
      path: s.path.map((k) => (k === pageKey ? key : k)),
      nav: s.nav,
      samePassageKeys: s.samePassageKeys.filter((k) => k !== pageKey),
    };
    stateRef.current = next;
    setState(next);
    log.info('threads', 'pending page sent', { sessionId: argsRef.current.sessionId, headId: headOf(key) });
    queueMicrotask(persist);
  }, [landings, headOf, persist]);

  // ── Reload restore (C69): once per session, when the tree knows its questions.
  // Every head on the stored path must still exist, else the root, silently.
  const treeReady = tree.threads.length > 1;
  const historyComplete = args.historyComplete ?? true;
  useEffect(() => {
    if (restored.current || !treeReady) return;
    if (!restoreWant.current) {
      const stored = readPersistedStack(sessionId);
      if (stored) {
        lastViewed.current = new Map(Object.entries(stored.lastViewedAt));
        if (stored.drafts.length) setDrafts(new Map(stored.drafts.map((d) => [d.pageKey, d])));
      }
      let want: RestoreWant | null = null;
      if (stored && stored.path.length > 0) want = { path: stored.path };
      else {
        const leaf = typeof window === 'undefined' ? null : readUrlLeaf(window.location.search, sessionId);
        if (leaf) want = { leaf };
      }
      restoreWant.current = { want, pages: stored?.pages ?? {} };
    }
    const { want, pages } = restoreWant.current;
    // Each attempt: the remembered scroll of every page the tree knows so far.
    for (const node of tree.threads) {
      const rec = pages[node.key === ROOT_THREAD_KEY ? '' : node.headId];
      if (rec && !landings.has(node.key)) landings.set(node.key, rec);
    }
    const path = restoreAttempt(tree, want, argsRef.current.hiddenKeys, historyComplete);
    if (path === 'wait') return;
    restored.current = true;
    if (!path) return;
    seq.current += 1;
    const leafKey = path[path.length - 1];
    const next: StackState = {
      path,
      nav: { seq: seq.current, from: ROOT_THREAD_KEY, to: leafKey, direction: 'none', via: 'reload', popped: [], firstEntry: !landings.has(leafKey) },
      samePassageKeys: [],
    };
    stateRef.current = next;
    setState(next);
    log.info('threads', 'restored', { sessionId, headId: headOf(leafKey), depth: path.length - 1 });
  }, [treeReady, tree, sessionId, landings, headOf, historyComplete]);

  // Drafts changed (a pending page left with text, or sent): persist.
  useEffect(() => { if (restored.current) persist(); }, [drafts, persist]);

  // The page's question left the transcript (a rewrite): back to the root, once.
  // A just-promoted page gets a grace period: the tree that knows it is published
  // by the timeline one render later.
  const pathGone = treeReady && state.path.some((k) => k !== ROOT_THREAD_KEY && !isPendingKey(k)
    && !tree.byKey.has(k) && (grace.current.get(k) ?? 0) < Date.now());
  useEffect(() => {
    if (!pathGone) return;
    log.warn('threads', 'page head is gone from the transcript, back to the root', { sessionId });
    navigate([ROOT_THREAD_KEY], 'head-gone');
    argsRef.current.toast.show({ text: HEAD_GONE_TEXT, ms: 4000 });
  }, [pathGone, navigate, sessionId]);

  // ── Drawer state (P4's ThreadTreeDrawer is controlled from here) ──
  const [drawerMode, setDrawerMode] = useState<ThreadDrawerMode>('closed');
  const [drawerFilter, setDrawerFilter] = useState<ThreadDrawerFilter | undefined>(undefined);
  const [revealNonce, setRevealNonce] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const drawerModeRef = useRef(drawerMode);
  drawerModeRef.current = drawerMode;
  useEffect(() => { setDrawerMode('closed'); setShowHidden(false); setDrawerFilter(undefined); }, [sessionId]);
  const openDrawer = useCallback((filter?: ThreadDrawerFilter) => {
    setDrawerFilter(filter);
    setDrawerMode('open');
  }, []);
  const reveal = useCallback(() => { setDrawerMode('open'); setRevealNonce((n) => n + 1); }, []);

  // ── Keys: one router picks ONE panel per press (focus first, pointer second).
  usePanelKeyRouter(args.panelRef, {
    sessionId,
    onEscape: () => {
      if (!activeRef.current) return false;
      if (drawerModeRef.current !== 'closed') { setDrawerMode('closed'); return true; }
      const c = argsRef.current.composer;
      const decision = escapeDecision({ depth: stateRef.current.path.length - 1, composerFocused: c.focused(), composerText: c.text() });
      if (decision !== 'pop') return false;
      back('esc');
      return true;
    },
    onToggleDrawer: () => {
      if (!activeRef.current) return false;
      setDrawerMode((m) => (m === 'closed' ? 'open' : 'closed'));
      return true;
    },
    hasEscapeLayer: () => activeRef.current && drawerModeRef.current !== 'closed',
  });

  const depth = state.path.length - 1;
  // `data-thread-depth` on the panel root: useFullscreen and the key router read
  // it, so one Esc never pops a page AND leaves fullscreen.
  useEffect(() => {
    const el = args.panelRef.current;
    if (!el) return;
    if (active) el.setAttribute('data-thread-depth', String(depth));
    else el.removeAttribute('data-thread-depth');
  }, [args.panelRef, active, depth]);

  // The leaf rides the URL (`t<n>` beside the column's `s<n>`).
  const leafKey = state.path[state.path.length - 1];
  const leafHead = enabled && depth > 0 && !isPendingKey(leafKey) ? tree.byKey.get(leafKey)?.headId ?? null : null;
  useEffect(() => { setThreadLeaf(sessionId, leafHead); }, [sessionId, leafHead]);
  useEffect(() => () => setThreadLeaf(sessionId, null), [sessionId]);

  const draftRows = useMemo<ThreadDraftRow[]>(() => [...drafts.values()]
    .filter((d) => d.pageKey !== leafKey)
    .map((d) => ({ pageKey: d.pageKey, parentKey: d.parentKey, label: DRAFT_ROW_LABEL })), [drafts, leafKey]);

  const draftPages = useMemo(() => [...drafts.values()].filter((d) => d.pageKey !== leafKey), [drafts, leafKey]);

  const setCapture = useCallback((fn: ((from: string, to: string, pending?: ThreadPendingPage) => void) | null) => { capture.current = fn; }, []);

  const api = useMemo<ThreadStackApi>(() => ({
    path: state.path,
    currentKey: leafKey,
    depth,
    ...(state.pending && state.path.includes(state.pending.pageKey) ? { pending: state.pending } : {}),
    nav: state.nav,
    pushTo,
    popTo,
    back,
    ask,
    landings,
    setCapture,
    samePassageKey: state.samePassageKeys.includes(leafKey) ? leafKey : null,
    drafts: draftRows,
    draftPages,
    openDraft,
    persist,
  }), [state, leafKey, depth, pushTo, popTo, back, ask, landings, setCapture, draftRows, draftPages, openDraft, persist]);

  const bridge = useMemo<ThreadNavBridge>(() => ({
    currentKey: leafKey, depth, pushTo, popTo, popToVisibleAncestor,
  }), [leafKey, depth, pushTo, popTo, popToVisibleAncestor]);

  const drawer = useMemo<ThreadDrawerState>(() => ({
    mode: drawerMode,
    setMode: setDrawerMode,
    ...(drawerFilter ? { filter: drawerFilter } : {}),
    revealNonce,
    showHidden,
    setShowHidden,
    open: openDrawer,
    reveal,
  }), [drawerMode, drawerFilter, revealNonce, showHidden, openDrawer, reveal]);

  // viewedTick re-derives the map identity so unread consumers re-render.
  const lastViewedAt = useMemo(() => new Map(lastViewed.current), [viewedTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // The panel's width TIER (its readers only compare against these), observed
  // only while the session has questions: a resize of a session without them
  // never re-renders the panel, and one with them only when a tier is crossed.
  const [panelWidth, setPanelWidth] = useState(0);
  const hasQuestions = tree.threads.length > 1 || !!state.pending || drafts.size > 0;
  useEffect(() => {
    const el = args.panelRef.current;
    if (!hasQuestions || !el || typeof ResizeObserver === 'undefined') return;
    const read = () => setPanelWidth(widthTier(el.getBoundingClientRect().width, PANEL_WIDTH_TIERS));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [args.panelRef, hasQuestions]);

  return { api, bridge, drawer, promotePending, lastViewedAt, enabled, active, panelWidth };
}
