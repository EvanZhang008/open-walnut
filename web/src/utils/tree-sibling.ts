/**
 * Tree Mode's sibling box (2026-11-04, the user: "if there is sibling ... show
 * 2, the up and down, up 1/3 down 2/3, up one light weight box"; then "only show
 * the max 2, if there are 10 still show the current one and previous"; design 8
 * of ten, a swap knob on a draggable divider). The page on the right whose
 * question has a sibling (another question asked on the same page) shows one of
 * them above it, a regular page with its own timeline and composer (2026-11-05,
 * the user: "just regular session panel ... with a lightweight input box"); a
 * swap trades the two. Pure rules; unit-tested in tests/web/tree-sibling.test.ts.
 */
import { ROOT_THREAD_KEY, type ThreadTree } from '@/utils/thread-tree';

/** The box's share of the right page's height: 1/3 by default, the divider moves it. */
export const SIBLING_SHARE_DEFAULT = 1 / 3;
export const SIBLING_SHARE_MIN = 0.15;
export const SIBLING_SHARE_MAX = 0.6;
/** A panel shorter than this has no room for a second chat above the page. */
export const SIBLING_MIN_PANEL_HEIGHT = 600;

export interface SiblingPartner {
  /** The sibling the box shows. */
  key: string;
  /** Its place among the visible siblings, 1-based, and how many there are. */
  position: number;
  count: number;
  /** It was asked before the page's question (the previous one), or after it. */
  before: boolean;
}

/** The visible questions asked on the same page as `key` (the path bar's list of
 *  its level), in the order they were asked. */
export function siblingsOf(tree: ThreadTree, key: string, hidden: ReadonlySet<string>): string[] {
  const node = tree.byKey.get(key);
  if (!node || key === ROOT_THREAD_KEY || node.parentKey === undefined) return [];
  const parent = tree.byKey.get(node.parentKey);
  if (!parent) return [];
  return parent.childKeys.filter((k) => tree.byKey.has(k) && (k === key || !hidden.has(k)));
}

/**
 * The sibling shown above `key`: the one the reader swapped from (`swappedFrom`,
 * so a swap trades the two places) while it is still a visible sibling, else
 * the one asked just before it, else (the first asked) the one after it. Never
 * more than one: with ten siblings the box still shows only this one, and the
 * rest are on the path bar's list.
 */
export function siblingPartner(
  tree: ThreadTree,
  key: string,
  hidden: ReadonlySet<string>,
  swappedFrom?: string,
): SiblingPartner | null {
  const sibs = siblingsOf(tree, key, hidden);
  const at = sibs.indexOf(key);
  if (at < 0 || sibs.length < 2) return null;
  const pick = swappedFrom && swappedFrom !== key && sibs.includes(swappedFrom)
    ? swappedFrom
    : sibs[at - 1] ?? sibs[at + 1];
  const i = sibs.indexOf(pick);
  return { key: pick, position: i + 1, count: sibs.length, before: i < at };
}

export function clampSiblingShare(share: number): number {
  if (!Number.isFinite(share)) return SIBLING_SHARE_DEFAULT;
  return Math.min(SIBLING_SHARE_MAX, Math.max(SIBLING_SHARE_MIN, share));
}

/** The box's grid rows as `fr` (the box, then the page's own timeline), from its share. */
export function siblingRows(share: number): { top: string; body: string } {
  const s = clampSiblingShare(share);
  return { top: `${(s / (1 - s)).toFixed(4)}fr`, body: '1fr' };
}
