/**
 * Tree Mode's split screen (the path bar design, 2026-11-03: the user picked
 * design 4 of ten): the pure rules. No React, no DOM; unit-tested in
 * tests/web/tree-split-state.test.ts.
 *
 * The question stack (useThreadStack) keeps the path to the page on the RIGHT
 * (the one its composer and Esc work on). The path bar shows the TRAIL: that
 * path, plus the deeper levels the reader went down to before moving left
 * (Cmd+[ or a segment click), so moving back right (Cmd+]) needs no search.
 * Split, the pages left of it are the levels above it on the path (`Main`
 * included), up to three pages in all; single, the page alone.
 *
 *   Main conversation  >  6 title  >  [L] 6.1 title  >  [R] 6.1.2 title
 *
 * The trail is kept as head ids (a key carries a quote, a head id is the
 * question's identity on the record), so a reload brings it back once the tree
 * knows those questions.
 */
import { ROOT_THREAD_KEY, type ThreadTree } from '@/utils/thread-tree';
import type { PageLandings } from '@/utils/thread-stack-state';

/** Narrower than this (the chat area, not the window), Tree Mode shows one page: two pages of about 450px read well, two of 340px do not. */
export const SPLIT_MIN_WIDTH = 900;
/** From this width (the chat area), three pages fit side by side (about 345px each: the full-screen sheet of a 1440px window is about 1100px). */
export const THREE_PANES_MIN_WIDTH = 1040;
/** Narrower than this, the path bar shows titles only on the pages on screen. */
export const PATH_BAR_NARROW = 720;
/** The most pages Tree Mode shows side by side. */
export const MAX_PANES = 3;

/**
 * What a panel place keeps (panel-view.ts): how many pages the reader lets the
 * split show (`panes`, 1 to 3: 1 is the one-page view he turned on himself),
 * and the trail. `split` is `panes > 1`, written for older builds that read it.
 * A record from before `panes` existed reads as 3: its `split: false` was the
 * old default, not the reader's choice (2026-11-04, the user: a single page "is
 * something the user turns on explicitly, never a side effect").
 */
export interface TreeSplitRecord {
  split: boolean;
  /** Head ids of the trail below the main conversation, shallowest first. */
  trail: string[];
  panes?: number;
  /** The sibling question above the right page (tree-sibling.ts): `false` once the
   *  reader closed it (absent = shown), and its share of the column's height. */
  sibling?: boolean;
  siblingShare?: number;
}

export const NO_TREE_SPLIT: TreeSplitRecord = { split: true, trail: [], panes: MAX_PANES };

export function isTreeSplitRecord(v: unknown): v is TreeSplitRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.split === 'boolean' && Array.isArray(r.trail) && r.trail.every((x) => typeof x === 'string')
    && (r.panes === undefined || (typeof r.panes === 'number' && Number.isInteger(r.panes) && r.panes >= 1 && r.panes <= MAX_PANES))
    && (r.sibling === undefined || typeof r.sibling === 'boolean')
    && (r.siblingShare === undefined || (typeof r.siblingShare === 'number' && r.siblingShare > 0 && r.siblingShare < 1));
}

/** How many pages the reader lets the split show (a record without `panes` is an old default). */
export function paneCap(r: TreeSplitRecord): number {
  return r.panes ?? MAX_PANES;
}

/** The record with a new cap (`split` follows it for older builds). */
export function withPaneCap(r: TreeSplitRecord, panes: number): TreeSplitRecord {
  const p = Math.min(Math.max(Math.round(panes), 1), MAX_PANES);
  return r.panes === p && r.split === p > 1 ? r : { ...r, panes: p, split: p > 1 };
}

export function sameTreeSplit(a: TreeSplitRecord, b: TreeSplitRecord): boolean {
  return a.split === b.split && a.panes === b.panes && a.sibling === b.sibling && a.siblingShare === b.siblingShare
    && a.trail.length === b.trail.length && a.trail.every((h, i) => h === b.trail[i]);
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

/** How many pages fit side by side in a chat area this wide (0 = not measured yet: one). */
export function roomFor(width: number): number {
  if (width >= THREE_PANES_MIN_WIDTH) return 3;
  if (width >= SPLIT_MIN_WIDTH) return 2;
  return 1;
}

/**
 * How many pages are on screen: the reader's cap, the room, and the pages the
 * path holds (the page on screen and the levels above it). The pages shown are
 * the LAST that many of the path: the question stack's page (the panel's own
 * timeline and composer) is always the rightmost.
 */
export function paneCount(s: { cap: number; width: number; pathLength: number }): number {
  return Math.max(1, Math.min(s.cap, roomFor(s.width), s.pathLength));
}

/** Split is shown: more than one page on screen. */
export function splitShown(s: { cap: number; width: number; depth: number }): boolean {
  return paneCount({ cap: s.cap, width: s.width, pathLength: s.depth + 1 }) > 1;
}

/** The path bar is shown in Tree Mode once there is a level to show besides the main conversation. */
export function barShown(s: { stackMode: boolean; trailLength: number }): boolean {
  return s.stackMode && s.trailLength >= 2;
}

/** What each segment wears: `L`, `M` and `R` (the pages on screen, left to
 *  right), `only` (one page), or nothing. */
export type SegmentRole = 'L' | 'M' | 'R' | 'only' | null;

export function segmentRoles(trailLength: number, shownIndex: number, panes: number): SegmentRole[] {
  const n = Math.max(1, panes);
  const first = shownIndex - n + 1;
  return Array.from({ length: trailLength }, (_, i) => {
    if (n === 1) return i === shownIndex ? 'only' : null;
    if (i < first || i > shownIndex) return null;
    if (i === shownIndex) return 'R';
    return i === first ? 'L' : 'M';
  });
}

/**
 * Cmd+[ (-1) / Cmd+] (+1): the index the right page moves to on the trail, or
 * null at an end. The pages on screen move together and the split never shrinks
 * on the way: the right page never comes nearer the main conversation than the
 * number of pages on screen allows (Main is at most the left page).
 */
export function pairMoveTarget(trailLength: number, shownIndex: number, dir: -1 | 1, panes: number): number | null {
  const next = shownIndex + dir;
  const min = Math.max(panes, 1) - 1;
  if (next < min || next > trailLength - 1) return null;
  return next;
}

/** A click on segment `j`, as a move of the right page: a level on screen
 *  stays where it is (`null`: it only takes the focus); one left of the pages
 *  on screen becomes the left page; one right of them becomes the right page. */
export function segmentTarget(trailLength: number, j: number, shownIndex: number, panes: number): number | null {
  const n = Math.max(1, panes);
  const at = Math.min(Math.max(j, 0), Math.max(trailLength - 1, 0));
  if (at > shownIndex) return at;
  if (at > shownIndex - n) return null;
  return Math.min(at + n - 1, trailLength - 1);
}

/** Does a pick from segment `j`'s list change anything? Picking the question
 *  that segment already shows does not, whichever segment it is (the pair stays
 *  where it is); any other pick goes to it and cuts the trail back to it. */
export function levelPickMoves(trail: readonly string[], j: number, key: string): boolean {
  return trail[j] !== key;
}

/**
 * Navigations that end a level on purpose: they go where they say, and the split
 * follows. Everything else that lands on a level of the trail (a row of the
 * question map or the drawer, a path bar chip, a crumb, an Asked-from card, a
 * list pick) is a move along the trail and keeps the pages on screen (2026-11-04,
 * the user: "after click here it go to single panel mode, what? tree mode is
 * already multi panel"). tests/web/tree-nav-keeps-panes.test.ts reads every via
 * the code navigates with and fails on one this list and that test do not place.
 */
export const CUTTING_VIAS: ReadonlySet<string> = new Set([
  // Esc and the one-page header's Back: the reader leaves the page.
  'esc', 'back',
  // The question left the screen: archived, done, gone from the transcript, an undo.
  'remove', 'head-gone', 'done', 'done-chain', 'undo',
  // The right page's close, and an Ask not sent closed (its card, its chip's x).
  'close-right', 'card-close', 'quote-clear',
  // A reload lands where the stored path says.
  'reload',
]);

/**
 * The split's own slides (Cmd+[ / Cmd+], a path bar segment off the pages):
 * useTreeSplit already worked out the path that keeps the pages on screen
 * (pairMoveTarget, segmentTarget; a segment on screen it focuses itself), so
 * they go as asked. Read as a move onto a level on screen they would only focus
 * it and the pages would never slide (2026-11-05).
 */
export const SLIDE_VIAS: ReadonlySet<string> = new Set(['pair-left', 'pair-right', 'path-bar']);

export type NavRetarget =
  /** The level is on screen already: it takes the focus, nothing moves. */
  | { kind: 'focus'; key: string }
  /** Go here instead: the pages on screen slide to show the level. */
  | { kind: 'path'; path: string[] };

/**
 * A navigation to `toPath` while the split shows `panes` pages of `path`, with
 * `trail` the path bar's levels and `room` the pages that fit: what it does
 * instead, or null to go as asked. Only a move onto a level of the trail at or
 * above the page on screen is changed; a deeper level, a pending page, another
 * question and a cut (CUTTING_VIAS) go as asked.
 */
export function retargetNav(s: {
  path: readonly string[];
  trail: readonly string[];
  panes: number;
  room: number;
  toPath: readonly string[];
  via: string;
}): NavRetarget | null {
  if (CUTTING_VIAS.has(s.via) || SLIDE_VIAS.has(s.via) || s.room <= 1 || s.toPath.length === 0) return null;
  if (!isPrefix(s.toPath, s.trail) || !isPrefix(s.path, s.trail)) return null;
  const t = s.toPath.length - 1;
  const shown = s.path.length - 1;
  if (t >= shown) return null;
  const n = Math.max(1, s.panes);
  if (t > shown - n) return { kind: 'focus', key: s.trail[t] };
  // Left of the pages on screen: it becomes the left page, as many pages as fit.
  const leaf = Math.min(t + Math.min(s.room, s.trail.length) - 1, s.trail.length - 1);
  if (leaf === shown) return { kind: 'focus', key: s.trail[t] };
  return { kind: 'path', path: s.trail.slice(0, leaf + 1) };
}

/** Closing a page: the right one closes its level (the page left of it is the
 *  right page now, more pages come in from the left as they fit); a left one
 *  shows one page fewer, its level and every one left of it out of sight. */
export function closePaneMove(side: 'L' | 'R', shownIndex: number, panes: number): { target: number; panes: number } {
  if (side === 'R') return { target: Math.max(shownIndex - 1, 0), panes: Math.max(panes, 1) };
  return { target: shownIndex, panes: Math.max(panes - 1, 1) };
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
  /** The named page's own path, when it is no level of the stack's (the sibling page above the right one). */
  onScreenPath?: readonly string[];
}): { parentKey: string; base: string[] } {
  const named = a.onScreenKey !== undefined ? a.path.indexOf(a.onScreenKey) : -1;
  if (named < 0 && a.onScreenKey !== undefined && a.onScreenPath?.length && a.onScreenPath[a.onScreenPath.length - 1] === a.onScreenKey) {
    return { parentKey: a.known ?? a.onScreenKey, base: [...a.onScreenPath] };
  }
  const pending = a.pendingParentKey !== undefined;
  const onScreen = named >= 0 ? a.path[named]
    : pending ? a.pendingParentKey! : (a.path[a.path.length - 1] ?? ROOT_THREAD_KEY);
  const base = named >= 0 ? a.path.slice(0, named + 1) : pending ? a.path.slice(0, -1) : [...a.path];
  return { parentKey: a.known ?? onScreen, base };
}

/**
 * The pages a running turn answers (Tree Mode, 2026-11-05: every page's composer
 * showed Stop while one page was answered). A question's page is answering when
 * its live state says so; a turn answering no question is the main
 * conversation's. Null when no turn runs. Only those pages' composers offer Stop;
 * every other page sends (its message waits for the turn, as any send does).
 */
export function answeringPages(streaming: boolean, live: ReadonlyMap<string, string>): ReadonlySet<string> | null {
  if (!streaming) return null;
  const keys = new Set<string>();
  for (const [key, state] of live) if (state === 'answering' && key !== ROOT_THREAD_KEY) keys.add(key);
  if (keys.size === 0) keys.add(ROOT_THREAD_KEY);
  return keys;
}
