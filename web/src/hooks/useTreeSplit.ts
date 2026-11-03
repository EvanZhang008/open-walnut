/**
 * Tree Mode's split screen for one session panel (design 4, the path bar): the
 * trail the path bar shows, split or single, which pair is on screen, and the
 * moves (Cmd+[ / Cmd+], a segment click, a pick from a level's list, closing a
 * half). The rules are tree-split-state.ts; the choice and the trail are kept
 * with the panel's view (panel-view.ts), so a reload shows the same pair.
 *
 * The question stack stays the one owner of the page on the RIGHT (its path is
 * root..right page): every move here is a stack navigation, so drafts, landing,
 * Esc and the URL keep working as they did. The left half is the right page's
 * parent and has no state of its own.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ThreadStackApi } from '@/contexts/SessionThreadsContext';
import type { ThreadMetaIndex } from '@/utils/thread-meta';
import type { ThreadTree } from '@/utils/thread-tree';
import { questionLabels } from '@/utils/question-tag';
import { widthTier } from '@/utils/thread-stack-state';
import {
  PATH_BAR_NARROW, SPLIT_MIN_WIDTH, barShown as barShownOf, closeHalfTarget, isPrefix, levelPickMoves, pairMoveTarget, segmentRoles,
  segmentTarget, splitShown as splitShownOf, trailFor, trailHeadsOf, trailKeysOf, type SegmentRole, type TreeSplitRecord,
} from '@/utils/tree-split-state';
import { log } from '@/utils/log';

/** The panel's own composer (the one that stays when the split closes). */
const MAIN_COMPOSER = '.session-panel-input:not(.tree-split-input) .chat-input-textarea';

const WIDTH_TIERS = [PATH_BAR_NARROW, SPLIT_MIN_WIDTH] as const;

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
}

export interface TreeSplit {
  /** The path bar is on screen (Tree Mode, a level besides Main). */
  barShown: boolean;
  /** Two halves on screen. */
  splitShown: boolean;
  /** The chat area has room for two halves (the single header offers Split). */
  wide: boolean;
  /** Narrower than PATH_BAR_NARROW: the bar shows titles only on the pages on screen. */
  narrowBar: boolean;
  /** Root first. */
  trail: string[];
  /** The right page's index on the trail (the single page's when not split). */
  shownIndex: number;
  roles: SegmentRole[];
  /** The left half's page, when split. */
  leftKey: string | null;
  rightKey: string;
  labels: ReadonlyMap<string, string>;
  /** Cmd+[ / Cmd+]: true when the key was Tree Mode's (the bar is on screen). */
  moveBy: (dir: -1 | 1) => boolean;
  goToSegment: (j: number) => void;
  /** A question picked from segment `j`'s list. */
  pickAtLevel: (j: number, key: string) => void;
  closeHalf: (side: 'L' | 'R') => void;
  openSplit: () => void;
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

  // Asking splits (the level it was asked in on the left, the new question on the right).
  const navSeq = stack.nav?.seq;
  const navVia = stack.nav?.via;
  const stackModeRef = useRef(stackMode);
  stackModeRef.current = stackMode;
  useEffect(() => {
    if (navSeq === undefined || !stackModeRef.current) return;
    if (navVia !== 'ask' && navVia !== 'same-passage') return;
    setRecord((prev) => (prev.split ? prev : { ...prev, split: true }));
    log.info('threads', 'tree split on ask', { sessionId: a.sessionId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per navigation
  }, [navSeq]);

  // The chat area's width TIER: a resize re-renders only across a tier.
  const [widthBucket, setWidthBucket] = useState(0);
  const { panelRef, chatColRef } = a;
  useLayoutEffect(() => {
    if (!stackMode) return;
    const read = () => {
      const w = chatColRef.current?.getBoundingClientRect().width || panelRef.current?.getBoundingClientRect().width || 0;
      setWidthBucket(widthTier(w, WIDTH_TIERS));
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

  const shownIndex = stack.path.length - 1;
  const split = stackMode && splitShownOf({ split: record.split, width: widthBucket, depth: shownIndex });
  const bar = barShownOf({ stackMode, trailLength: trail.length });
  const roles = useMemo(() => segmentRoles(trail.length, shownIndex, split), [trail.length, shownIndex, split]);
  const leftKey = split ? stack.path[stack.path.length - 2] ?? null : null;
  const labels = useMemo(() => questionLabels(tree, a.metaIndex), [tree, a.metaIndex]);

  // The left half's question is on screen: viewed, again when an answer lands there.
  const leftAnsweredAt = leftKey !== null ? a.answeredAtOf(leftKey) : undefined;
  const markViewedRef = useRef(a.markViewed);
  markViewedRef.current = a.markViewed;
  useEffect(() => { if (leftKey) markViewedRef.current(leftKey); }, [leftKey, leftAnsweredAt]);

  const live = useRef({ trail, shownIndex, split, bar, stack });
  live.current = { trail, shownIndex, split, bar, stack };

  const goTo = useCallback((t: number, via: string) => {
    const { trail: tr, shownIndex: at, stack: s } = live.current;
    const key = tr[t];
    if (key === undefined || t === at) return;
    if (t < at) s.popTo(key, via);
    else s.pushTo(key, via);
  }, []);

  const moveBy = useCallback((dir: -1 | 1) => {
    const l = live.current;
    if (!l.bar) return false;
    const t = pairMoveTarget(l.trail.length, l.shownIndex, dir, l.split);
    if (t !== null) goTo(t, dir < 0 ? 'pair-left' : 'pair-right');
    return true;
  }, [goTo]);

  const goToSegment = useCallback((j: number) => {
    const l = live.current;
    goTo(segmentTarget(l.trail.length, j, l.split), 'path-bar');
  }, [goTo]);

  const pickAtLevel = useCallback((j: number, key: string) => {
    const l = live.current;
    if (!levelPickMoves(l.trail, j, key)) return;
    l.stack.pushTo(key, 'path-bar-list');
  }, []);

  const closeHalf = useCallback((side: 'L' | 'R') => {
    const l = live.current;
    // The left half goes away with either close: focus in it (its composer,
    // its close button) moves to the composer that stays, never to <body>.
    // Safari gives a clicked button no focus, so a press on Close drops the
    // composer's focus onto <body> before this runs: that counts as the half's.
    const panel = panelRef.current;
    const active = document.activeElement;
    const leftHadFocus = !active || active === document.body
      || !!panel?.querySelector('.tree-split-left')?.contains(active);
    setRecord((prev) => (prev.split ? { ...prev, split: false } : prev));
    goTo(closeHalfTarget(side, l.shownIndex), side === 'R' ? 'close-right' : 'close-left');
    if (leftHadFocus) {
      requestAnimationFrame(() => {
        panel?.querySelector<HTMLTextAreaElement>(MAIN_COMPOSER)?.focus({ preventScroll: true });
      });
    }
  }, [goTo, setRecord, panelRef]);

  const openSplit = useCallback(() => {
    setRecord((prev) => (prev.split ? prev : { ...prev, split: true }));
  }, [setRecord]);

  return {
    barShown: bar, splitShown: split, wide, narrowBar, trail, shownIndex, roles, leftKey,
    rightKey: stack.currentKey, labels, moveBy, goToSegment, pickAtLevel, closeHalf, openSplit,
  };
}
