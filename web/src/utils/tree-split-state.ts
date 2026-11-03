/**
 * Tree Mode's split screen (the path bar design, 2026-11-03: the user picked
 * design 4 of ten): the pure rules. No React, no DOM; unit-tested in
 * tests/web/tree-split-state.test.ts.
 *
 * The question stack (useThreadStack) keeps the path to the page on the RIGHT
 * (the one its composer and Esc work on). The path bar shows the TRAIL: that
 * path, plus the deeper levels the reader went down to before moving left
 * (Cmd+[ or a segment click), so moving back right (Cmd+]) needs no search.
 * Split, the left half is the right page's parent (`Main` included); single,
 * the page alone.
 *
 *   Main conversation  >  6 title  >  [L] 6.1 title  >  [R] 6.1.2 title
 *
 * The trail is kept as head ids (a key carries a quote, a head id is the
 * question's identity on the record), so a reload brings it back once the tree
 * knows those questions.
 */
import { ROOT_THREAD_KEY, type ThreadTree } from '@/utils/thread-tree';
import type { PageLandings } from '@/utils/thread-stack-state';

/** Narrower than this (the chat area, not the window), Tree Mode shows one page. */
export const SPLIT_MIN_WIDTH = 900;
/** Narrower than this, the path bar shows titles only on the pages on screen. */
export const PATH_BAR_NARROW = 720;

/** What a panel place keeps (panel-view.ts): split or single, and the trail. */
export interface TreeSplitRecord {
  split: boolean;
  /** Head ids of the trail below the main conversation, shallowest first. */
  trail: string[];
}

export const NO_TREE_SPLIT: TreeSplitRecord = { split: false, trail: [] };

export function isTreeSplitRecord(v: unknown): v is TreeSplitRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.split === 'boolean' && Array.isArray(r.trail) && r.trail.every((x) => typeof x === 'string');
}

export function sameTreeSplit(a: TreeSplitRecord, b: TreeSplitRecord): boolean {
  return a.split === b.split && a.trail.length === b.trail.length && a.trail.every((h, i) => h === b.trail[i]);
}

/** `a` is `b` or the start of it. */
export function isPrefix(a: readonly string[], b: readonly string[]): boolean {
  return a.length <= b.length && a.every((k, i) => k === b[i]);
}

/** The path bar's levels: the kept trail while the page path is the start of
 *  it, else the path itself (the reader went somewhere else: the levels right
 *  of where he left the trail are cut). */
export function trailFor(kept: readonly string[], path: readonly string[]): string[] {
  return isPrefix(path, kept) ? [...kept] : [...path];
}

/**
 * Kept head ids to keys, root first. Each must still be a visible child of the
 * level before it; the trail stops at the first that is not (archived out of
 * sight, gone from the transcript, or not loaded yet).
 */
export function trailKeysOf(tree: ThreadTree, heads: readonly string[], hidden: ReadonlySet<string>): string[] {
  const out = [ROOT_THREAD_KEY];
  for (const head of heads) {
    const parent = tree.byKey.get(out[out.length - 1]);
    const key = parent?.childKeys.find((k) => tree.byKey.get(k)?.headId === head);
    if (!key || hidden.has(key)) break;
    out.push(key);
  }
  return out;
}

/** Keys to the head ids kept; stops at a page the tree does not hold (an Ask not sent yet). */
export function trailHeadsOf(tree: ThreadTree, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys.slice(1)) {
    const head = tree.byKey.get(key)?.headId;
    if (!head) break;
    out.push(head);
  }
  return out;
}

/** Split is shown: chosen, room for two halves, and a page below the main conversation. */
export function splitShown(s: { split: boolean; width: number; depth: number }): boolean {
  return s.split && s.width >= SPLIT_MIN_WIDTH && s.depth >= 1;
}

/** The path bar is shown in Tree Mode once there is a level to show besides the main conversation. */
export function barShown(s: { stackMode: boolean; trailLength: number }): boolean {
  return s.stackMode && s.trailLength >= 2;
}

/** What each segment wears: `L` and `R` (split), `only` (single), or nothing. */
export type SegmentRole = 'L' | 'R' | 'only' | null;

export function segmentRoles(trailLength: number, shownIndex: number, split: boolean): SegmentRole[] {
  return Array.from({ length: trailLength }, (_, i) => {
    if (split) return i === shownIndex ? 'R' : i === shownIndex - 1 ? 'L' : null;
    return i === shownIndex ? 'only' : null;
  });
}

/**
 * Cmd+[ (-1) / Cmd+] (+1): the index the right page moves to on the trail, or
 * null at an end. Split, the pair moves (the right page never reaches the main
 * conversation: Main is at most the left half); single, the page does.
 */
export function pairMoveTarget(trailLength: number, shownIndex: number, dir: -1 | 1, split: boolean): number | null {
  const next = shownIndex + dir;
  const min = split ? 1 : 0;
  if (next < min || next > trailLength - 1) return null;
  return next;
}

/** A click on segment `j`: split, it becomes the right half and its parent the
 *  left (Main as the left half); single, it is the page on screen. */
export function segmentTarget(trailLength: number, j: number, split: boolean): number {
  const t = split ? Math.max(j, 1) : j;
  return Math.min(Math.max(t, 0), Math.max(trailLength - 1, 0));
}

/** Does a pick from segment `j`'s list change anything? Picking the question
 *  that segment already shows does not, whichever segment it is (the pair stays
 *  where it is); any other pick goes to it and cuts the trail back to it. */
export function levelPickMoves(trail: readonly string[], j: number, key: string): boolean {
  return trail[j] !== key;
}

/** Closing a half: the left one leaves the right page alone; the right one shows its parent. */
export function closeHalfTarget(side: 'L' | 'R', shownIndex: number): number {
  return side === 'R' ? Math.max(shownIndex - 1, 0) : shownIndex;
}

/** The questions at the level of segment `j` (siblings under the same parent;
 *  level 0 lists the questions on the main conversation), visible ones only. */
export function levelKeys(tree: ThreadTree, trail: readonly string[], j: number, hidden: ReadonlySet<string>): string[] {
  const parent = j <= 0 ? ROOT_THREAD_KEY : trail[j - 1];
  const node = tree.byKey.get(parent);
  return (node?.childKeys ?? []).filter((k) => !hidden.has(k) && tree.byKey.has(k));
}

/** The level a segment's list names: `Questions on Main`, `Questions on 6.1`. */
export function levelHeading(j: number, parentLabel: string | undefined): string {
  const level = Math.max(j, 1);
  const on = j <= 1 ? 'Main' : parentLabel ?? 'this question';
  return `Level ${level} \u00b7 questions on ${on}`;
}

/** Is this key press Cmd+[ / Cmd+] (Ctrl elsewhere)? -1, +1, or 0 for any other key. */
export function pairChordDir(
  e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  mac: boolean,
): -1 | 0 | 1 {
  if (e.shiftKey || e.altKey) return 0;
  if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return 0;
  if (e.code === 'BracketLeft' || e.key === '[') return -1;
  if (e.code === 'BracketRight' || e.key === ']') return 1;
  return 0;
}

/**
 * The panel's page landings as the split's LEFT half sees them: read-only
 * (TreeSplitLeft.tsx). The half lands from the panel's own record of the
 * left page (taken when the panel's timeline left it), but its scroll memory
 * must never write there: the left page's key is a page the
 * panel's timeline comes back to, and a bare `{scrollTop}` saved by this half
 * replaced the passage the panel recorded, so Esc back landed a third down the
 * box instead of on the sentence.
 */
export function readOnlyLandings(base: PageLandings): PageLandings {
  return {
    get: (key) => base.get(key),
    has: (key) => base.has(key),
    set: () => undefined,
    delete: () => false,
  };
}

/**
 * Where an Ask about a passage the tree does not know yet (an answer still
 * streaming) goes: on top of the page the passage is on, never under Main (C4).
 * That is the page on screen, or the page a pending Ask hangs off; the split's
 * left half names its own (`onScreenKey`), since its page is the right page's
 * parent and a question asked there hangs on it. `base` is the stack path the
 * pending page is pushed onto. A passage the tree knows (`known`) goes under
 * its own question.
 */
export function askPlacement(a: {
  path: readonly string[];
  pendingParentKey?: string;
  known?: string;
  onScreenKey?: string;
}): { parentKey: string; base: string[] } {
  const named = a.onScreenKey !== undefined ? a.path.indexOf(a.onScreenKey) : -1;
  const pending = a.pendingParentKey !== undefined;
  const onScreen = named >= 0 ? a.path[named]
    : pending ? a.pendingParentKey! : (a.path[a.path.length - 1] ?? ROOT_THREAD_KEY);
  const base = named >= 0 ? a.path.slice(0, named + 1) : pending ? a.path.slice(0, -1) : [...a.path];
  return { parentKey: a.known ?? onScreen, base };
}
