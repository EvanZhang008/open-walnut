/**
 * Which page of Tree Mode's split screen a timeline renders (useTreeSplit).
 * The panel gives it: `R` to its own timeline while split, `L` (and `M`, the
 * middle of three) to the timelines it mounts for the pages left of it, `S` to
 * the sibling question it mounts above its own (tree-sibling.ts), `only`
 * while a wide pane shows one page (its header then offers Split). Null: no
 * split chrome (a narrow column, Conversation Mode), the stack row as it always was.
 */
import { createContext, useContext } from 'react';

export interface TreeHalf {
  side: 'L' | 'M' | 'R' | 'S' | 'only';
  /** The question's label (its thread id, `6.1`); none for Main or an Ask not sent. */
  number?: string;
  /** The close button on a page (useTreeSplit.closePane). */
  onClose?: () => void;
  /** Single, wide: split again (this page on the right, its parent on the left). */
  onSplit?: () => void;
  /** The sibling page: where it stands among its siblings (`Previous · 1 of 3`),
   *  and its swap with the page below. */
  where?: string;
  onSwap?: () => void;
  /** The right page: its sibling was closed; this shows it again. */
  onShowSibling?: () => void;
}

export const TreeHalfContext = createContext<TreeHalf | null>(null);

export function useTreeHalf(): TreeHalf | null {
  return useContext(TreeHalfContext);
}

/** A page beside the panel's own, left of it or above it (it reads the panel's
 *  timeline, owns nothing panel-wide). */
export function isSidePage(half: TreeHalf | null): boolean {
  return half?.side === 'L' || half?.side === 'M' || half?.side === 'S';
}
