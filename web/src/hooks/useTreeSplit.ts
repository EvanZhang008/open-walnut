/**
 * Tree Mode's split screen for one session panel (design 4, the path bar): the
 * trail the path bar shows, how many pages sit side by side (one to three), and
 * the moves (Cmd+[ / Cmd+], a segment click, a pick from a level's list,
 * closing a page). The rules are tree-split-state.ts; the cap and the trail are
 * kept with the panel's view (panel-view.ts), so a reload shows the same pages.
 *
 * The question stack stays the one owner of the page on the RIGHT (its path is
 * root..right page): every move here is a stack navigation, so drafts, landing,
 * Esc and the URL keep working as they did. The pages left of it are the levels
 * above it on the path and have no state of their own. A navigation onto a level
 * already on screen only focuses it, and one onto a level left of the pages
 * slides them (`retarget`, called by the stack for every navigation): moving
 * along the path never collapses the split.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import type { ThreadStackApi } from '@/contexts/SessionThreadsContext';
import type { ThreadMetaIndex } from '@/utils/thread-meta';
import type { ThreadTree } from '@/utils/thread-tree';
import { questionLabels } from '@/utils/question-tag';
import { stackPathOf, widthTier } from '@/utils/thread-stack-state';
import {
  LEFT_SHARE_DEFAULT, MAX_PANES, PATH_BAR_NARROW, SPLIT_MIN_WIDTH, THREE_BOUNDS_DEFAULT, THREE_PANES_MIN_WIDTH, barShown as barShownOf,
  clampBounds, paneCloseMove, isLeftShare, isPrefix, isThreeBounds, levelPickMoves, moveBound, paneCap, paneCount, pairMoveTarget,
  retargetNav, roomFor, segmentRoles, segmentTarget, siblingOffFor, trailFor, trailHeadsOf, trailKeysOf, withPaneCap, withSiblingOff,
  type NavRetarget, type SegmentRole, type TreeSplitRecord,
} from '@/utils/tree-split-state';
import { log } from '@/utils/log';
import { usePageView } from '@/utils/view-memory';
import { SIBLING_MIN_PANEL_HEIGHT, SIBLING_SHARE_DEFAULT, clampSiblingShare, paneSiblings, type PaneSibling } from '@/utils/tree-sibling';

/** The panel's own composer (the one that stays when the split closes). */
const MAIN_COMPOSER = '.session-panel-input:not(.tree-split-input) .chat-input-textarea';

const WIDTH_TIERS = [SPLIT_MIN_WIDTH, PATH_BAR_NARROW, THREE_PANES_MIN_WIDTH] as const;

export interface UseTreeSplitArgs {
  sessionId: string;
  tree: ThreadTree;
  hiddenKeys: ReadonlySet<string>;
  metaIndex: ThreadMetaIndex;
  stack: ThreadStackApi;
  /** Tree Mode is on and the session has questions (the stack is live). */
  stackMode: boolean;
  record: TreeSplitRecord;
  setRecord: (update: (prev: TreeSplitRecord) => TreeSplitRecord) => void;
  /** The panel, and its chat column (a box only while a view sits beside the chat). */
  panelRef: RefObject<HTMLElement | null>;
  chatColRef: RefObject<HTMLElement | null>;
  /** The reader looked at a question (its unread mark goes). */
  markViewed: (key: string) => void;
  /** When the newest answer of `key` landed, if it has one. */
  answeredAtOf: (key: string) => number | undefined;
  /** A page on screen takes the focus (a move to it changed nothing else); `via`, the move's. */
  onFocusPane: (key: string, via?: string) => void;
}

export interface TreeSplit {
  /** The path bar is on screen (Tree Mode, a level besides Main). */
  barShown: boolean;
  /** More than one page on screen. */
  splitShown: boolean;
  /** The pages on screen, left to right; the last is the stack's page (the panel's own timeline). */
  paneKeys: string[];
  /** The chat area has room for two pages (the single header offers Split). */
  wide: boolean;
  /** Narrower than PATH_BAR_NARROW: the bar shows titles only on the pages on screen. */
  narrowBar: boolean;
  /** Root first. */
  trail: string[];
  /** The right page's index on the trail (the single page's when not split). */
  shownIndex: number;
  roles: SegmentRole[];
  /** The left page, when split (the first of paneKeys). */
  leftKey: string | null;
  rightKey: string;
  labels: ReadonlyMap<string, string>;
  /** Cmd+[ / Cmd+]: true when the key was Tree Mode's (the bar is on screen). */
  moveBy: (dir: -1 | 1) => boolean;
  goToSegment: (j: number) => void;
  /** A question picked from segment `j`'s list. */
  pickAtLevel: (j: number, key: string) => void;
  /** The x of a page: the right one closes its level, a left one shows one page fewer. */
  closePane: (key: string) => void;
  /** Back to as many pages as fit (the one-page view's Split). */
  openSplit: () => void;
  /** What a stack navigation does instead while pages sit side by side (useThreadStack's `retarget`). */
  retarget: (toPath: readonly string[], via: string) => NavRetarget | null;
  /** Each page's sibling box (tree-sibling.ts), left to right as paneKeys. */
  siblings: PaneSibling[];
  /** One share of the column's height for every box. */
  siblingShare: number;
  /** The sibling above page `column` (paneKeys' index) becomes that page; the page that was there comes up. */
  swapSibling: (column: number) => void;
  closeSibling: (column: number) => void;
  showSibling: (column: number) => void;
  /** A box's divider moved (`commit`: the drag ended, keep it with the panel's view). */
  setSiblingShare: (share: number, commit: boolean) => void;
  /** The dividers between the pages: their places as shares of the column's width, left to right. */
  bounds: number[];
  /** Divider `i` moved to `share` of the column `width` wide (`commit`: the drag ended, keep it). */
  setBound: (i: number, share: number, width: number, commit: boolean) => void;
}

export function useTreeSplit(a: UseTreeSplitArgs): TreeSplit {
  const { tree, hiddenKeys, stack, stackMode, record, setRecord } = a;
  const treeReady = tree.threads.length > 1;

  const kept = useMemo(() => trailKeysOf(tree, record.trail, hiddenKeys), [tree, record.trail, hiddenKeys]);
  const pathSig = stack.path.join('\n');
  const keptSig = kept.join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read through the signatures
  const trail = useMemo(() => trailFor(kept, stack.path), [keptSig, pathSig]);

  // The reader went off the kept trail (another question, a new Ask, a sent
  // Ask): the path is the trail now. Only once the tree knows the questions, so
  // a reload never writes the trail away before it could be read back.
  useEffect(() => {
    if (!treeReady || isPrefix(stack.path, kept)) return;
    const heads = trailHeadsOf(tree, stack.path);
    setRecord((prev) => (prev.trail.length === heads.length && prev.trail.every((h, i) => h === heads[i]) ? prev : { ...prev, trail: heads }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read through the signatures
  }, [pathSig, keptSig, treeReady]);

  // Asking shows the pages side by side again when the reader had one page:
  // the level it was asked in beside the new question.
  const navSeq = stack.nav?.seq;
  const navVia = stack.nav?.via;
  const stackModeRef = useRef(stackMode);
  stackModeRef.current = stackMode;
  useEffect(() => {
    if (navSeq === undefined || !stackModeRef.current) return;
    if (navVia !== 'ask' && navVia !== 'same-passage') return;
    setRecord((prev) => (paneCap(prev) > 1 ? prev : withPaneCap(prev, MAX_PANES)));
    log.info('threads', 'tree split on ask', { sessionId: a.sessionId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per navigation
  }, [navSeq]);

  // The chat area's width TIER: a resize re-renders only across a tier. The
  // panel's height only says whether a second chat fits above the right page.
  const [widthBucket, setWidthBucket] = useState(0);
  const [tall, setTall] = useState(false);
  const { panelRef, chatColRef } = a;
  useLayoutEffect(() => {
    if (!stackMode) return;
    const read = () => {
      const w = chatColRef.current?.getBoundingClientRect().width || panelRef.current?.getBoundingClientRect().width || 0;
      setWidthBucket(widthTier(w, WIDTH_TIERS));
      setTall((panelRef.current?.getBoundingClientRect().height ?? 0) >= SIBLING_MIN_PANEL_HEIGHT);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    if (panelRef.current) ro.observe(panelRef.current);
    if (chatColRef.current) ro.observe(chatColRef.current);
    return () => ro.disconnect();
  }, [stackMode, panelRef, chatColRef]);
  const wide = widthBucket >= SPLIT_MIN_WIDTH;
  const narrowBar = widthBucket > 0 && widthBucket < PATH_BAR_NARROW;

  const cap = paneCap(record);
  /** Pages that may sit side by side: the reader's cap and the room. */
  const room = Math.min(cap, roomFor(widthBucket));
  const shownIndex = stack.path.length - 1;
  const panes = stackMode ? paneCount({ cap, width: widthBucket, pathLength: stack.path.length }) : 1;
  const split = panes > 1;
  const bar = barShownOf({ stackMode, trailLength: trail.length });
  const roles = useMemo(() => segmentRoles(trail.length, shownIndex, panes), [trail.length, shownIndex, panes]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read through the signature
  const paneKeys = useMemo(() => stack.path.slice(stack.path.length - panes), [pathSig, panes]);
  const leftKey = split ? paneKeys[0] : null;
  const labels = useMemo(() => questionLabels(tree, a.metaIndex), [tree, a.metaIndex]);

  // The pages beside the stack's are on screen: viewed, again when an answer lands there.
  const sideKeys = paneKeys.slice(0, -1);
  const sideSig = sideKeys.map((k) => `${k}\u0001${a.answeredAtOf(k) ?? ''}`).join('\n');
  const markViewedRef = useRef(a.markViewed);
  markViewedRef.current = a.markViewed;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read through the signature
  useEffect(() => { for (const k of sideKeys) markViewedRef.current(k); }, [sideSig]);

  const onFocusPaneRef = useRef(a.onFocusPane);
  onFocusPaneRef.current = a.onFocusPane;
  const live = useRef({ trail, shownIndex, split, bar, stack, panes, room, paneKeys });
  live.current = { trail, shownIndex, split, bar, stack, panes, room, paneKeys };

  const goTo = useLeanCallback((t: number, via: string) => {
    const { trail: tr, shownIndex: at, stack: s } = live.current;
    const key = tr[t];
    if (key === undefined || t === at) return;
    if (t < at) s.popTo(key, via);
    else s.pushTo(key, via);
  }, []);

  const moveBy = useLeanCallback((dir: -1 | 1) => {
    const l = live.current;
    if (!l.bar) return false;
    const t = pairMoveTarget(l.trail.length, l.shownIndex, dir, l.panes);
    if (t !== null) goTo(t, dir < 0 ? 'pair-left' : 'pair-right');
    return true;
  }, [goTo]);

  const goToSegment = useLeanCallback((j: number) => {
    const l = live.current;
    const t = segmentTarget(l.trail.length, j, l.shownIndex, l.panes);
    if (t === null) { const key = l.trail[j]; if (key !== undefined) onFocusPaneRef.current(key); return; }
    goTo(t, 'path-bar');
  }, [goTo]);

  const pickAtLevel = useLeanCallback((j: number, key: string) => {
    const l = live.current;
    if (!levelPickMoves(l.trail, j, key)) {
      if (l.paneKeys.includes(key)) onFocusPaneRef.current(key);
      else goToSegment(j);
      return;
    }
    l.stack.pushTo(key, 'path-bar-list');
  }, [goToSegment]);

  const openSplit = useLeanCallback(() => {
    setRecord((prev) => withPaneCap(prev, MAX_PANES));
  }, [setRecord]);

  const retarget = useLeanCallback((toPath: readonly string[], via: string): NavRetarget | null => {
    const l = live.current;
    if (!stackModeRef.current) return null;
    const r = retargetNav({ path: l.stack.path, trail: l.trail, panes: l.panes, room: l.room, toPath, via });
    if (r?.kind === 'focus') onFocusPaneRef.current(r.key, via);
    if (r) log.info('threads', 'tree split keeps its pages', { sessionId: a.sessionId, via, kind: r.kind });
    return r;
  }, [a.sessionId]);

  // Every page's sibling box: the one the reader swapped from, else the previous
  // one asked. Only where pages may sit side by side (one page, the reader's
  // one-page view or a column with room for one, is the plain page).
  // `swaps`: a swap's new page -> the page it came from and the right page then,
  // so a swap back in a left column goes down to where the reader was.
  const [swaps, setSwaps] = useState<ReadonlyMap<string, { from: string; leaf: string }>>(() => new Map());
  const headOf = useLeanCallback((key: string) => tree.byKey.get(key)?.headId, [tree]);
  const siblings = useMemo(
    () => (stackMode && treeReady
      ? paneSiblings(tree, paneKeys, hiddenKeys, {
        room, panelHeight: tall ? Infinity : 0, swappedFrom: (k) => swaps.get(k)?.from, off: (k) => siblingOffFor(record, headOf(k)),
      })
      : paneKeys.map(() => ({ partner: null, closed: false }))),
    [stackMode, treeReady, tree, paneKeys, hiddenKeys, room, tall, swaps, record, headOf],
  );
  const [dragShare, setDragShare] = useState<number | null>(null);
  const siblingShare = clampSiblingShare(dragShare ?? record.siblingShare ?? SIBLING_SHARE_DEFAULT);
  const siblingsRef = useRef(siblings);
  siblingsRef.current = siblings;
  // The siblings on screen are viewed too, again when an answer lands there.
  const sibSig = siblings.map((x) => (x.partner ? `${x.partner.key}\u0001${a.answeredAtOf(x.partner.key) ?? ''}` : '')).join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read through the signature
  useEffect(() => { for (const x of siblingsRef.current) if (x.partner) markViewedRef.current(x.partner.key); }, [sibSig]);
  const swapSibling = useLeanCallback((column: number) => {
    const sib = siblingsRef.current[column]?.partner;
    const l = live.current;
    const from = l.paneKeys[column];
    if (!sib || from === undefined) return;
    const leaf = l.stack.currentKey;
    // Back to the page a swap came from: down to the page that was on the right then.
    const back = swaps.get(from);
    const to = back?.from === sib.key && back.leaf !== sib.key && stackPathOf(tree, back.leaf).includes(sib.key) ? back.leaf : sib.key;
    setSwaps((prev) => new Map(prev).set(sib.key, { from, leaf }));
    log.info('threads', 'tree sibling swapped', { sessionId: a.sessionId, from, to: sib.key, column });
    l.stack.pushTo(to, 'sibling');
  }, [a.sessionId, swaps, tree]);
  const focusMain = useLeanCallback(() => {
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLTextAreaElement>(MAIN_COMPOSER)?.focus({ preventScroll: true }));
  }, [panelRef]);
  const closeSibling = useLeanCallback((column: number) => {
    const head = headOf(live.current.paneKeys[column] ?? '');
    if (!head) return;
    setRecord((prev) => withSiblingOff(prev, head, true));
    focusMain();
  }, [setRecord, headOf, focusMain]);
  const showSibling = useLeanCallback((column: number) => {
    const l = live.current;
    const head = headOf(l.paneKeys[column] ?? '');
    if (!head) return;
    // The other pages on screen whose box is shut keep it shut (an old every-page
    // `sibling: false` becomes their own entries).
    const shut = l.paneKeys.filter((_, i) => i !== column && siblingsRef.current[i]?.closed === true)
      .map(headOf).filter((h): h is string => !!h);
    setRecord((prev) => withSiblingOff(prev, head, false, shut));
  }, [setRecord, headOf]);
  const setSiblingShare = useLeanCallback((share: number, commit: boolean) => {
    const s = clampSiblingShare(share);
    if (!commit) { setDragShare(s); return; }
    setDragShare(null);
    setRecord((prev) => (prev.siblingShare === s ? prev : { ...prev, siblingShare: s }));
  }, [setRecord]);

  const closePane = useLeanCallback((key: string) => {
    const l = live.current;
    const column = l.paneKeys.indexOf(key);
    const above = siblingsRef.current[column]?.partner?.key;
    const move = paneCloseMove({ paneKeys: l.paneKeys, key, shownIndex: l.shownIndex, panes: l.panes, ...(above ? { above } : {}) });
    if (!move) return;
    // The page goes away with its close: focus in it (its composer, its close
    // button) moves to the composer that stays, never to <body>. Safari gives a
    // clicked button no focus, so a press on Close drops the composer's focus
    // onto <body> before this runs: that counts as the page's.
    const panel = panelRef.current;
    const active = document.activeElement;
    const sideHadFocus = !active || active === document.body
      || [...(panel?.querySelectorAll('.tree-split-left') ?? [])].some((el) => el.contains(active));
    if (move.kind === 'half') {
      // Only this page closes: the sibling above it is the column's page now,
      // and the box above it stays shut (the closed page would come back there).
      const head = headOf(move.to);
      if (head) setRecord((prev) => withSiblingOff(prev, head, true));
      log.info('threads', 'tree split half closed', { sessionId: a.sessionId, column, to: move.to });
      l.stack.pushTo(move.to, 'close-half');
    } else if (move.kind === 'right') {
      // The page leaves the screen, its level stays on the trail: the path bar
      // shows it greyed after the page that is right now, one click opens it
      // again (2026-11-16, the user: "it shoud also show if the current is the
      // parnet ... show bit grey, but show so user cna know").
      goTo(move.target, 'close-right');
    } else {
      setRecord((prev) => withPaneCap(prev, move.panes));
      log.info('threads', 'tree split pane closed', { sessionId: a.sessionId, panes: move.panes });
    }
    if (sideHadFocus) {
      requestAnimationFrame(() => {
        panel?.querySelector<HTMLTextAreaElement>(MAIN_COMPOSER)?.focus({ preventScroll: true });
      });
    }
  }, [goTo, setRecord, panelRef, headOf, a.sessionId]);

  // The pages' widths: one choice for the user (synced like the layout), not per
  // panel; two pages and three keep theirs apart (the left page's share of two
  // is what the two-page builds kept).
  const [keptLeft, setKeptLeft] = usePageView('session', 'treeLeftShare', LEFT_SHARE_DEFAULT, isLeftShare);
  const [kept3, setKept3] = usePageView<number[]>('session', 'treeCols3', () => [...THREE_BOUNDS_DEFAULT], isThreeBounds);
  const [dragBounds, setDragBounds] = useState<{ panes: number; bounds: number[] } | null>(null);
  const keptBounds = panes === 3 ? kept3 : [keptLeft];
  const bounds = useMemo(
    () => (panes < 2 ? [] : clampBounds(dragBounds?.panes === panes ? dragBounds.bounds : keptBounds, panes)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read through the values
    [panes, dragBounds, keptLeft, kept3],
  );
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const setBound = useLeanCallback((i: number, share: number, width: number, commit: boolean) => {
    const n = live.current.panes;
    if (n < 2) return;
    const next = moveBound(boundsRef.current, n, i, share, width);
    if (!commit) { setDragBounds({ panes: n, bounds: next }); return; }
    setDragBounds(null);
    if (n === 3) setKept3(next);
    else setKeptLeft(next[0]);
  }, [setKept3, setKeptLeft]);

  return {
    barShown: bar, splitShown: split, paneKeys, wide, narrowBar, trail, shownIndex, roles, leftKey,
    rightKey: stack.currentKey, labels, moveBy, goToSegment, pickAtLevel, closePane, openSplit, retarget,
    siblings, siblingShare, swapSibling, closeSibling, showSibling, setSiblingShare, bounds, setBound,
  };
}
