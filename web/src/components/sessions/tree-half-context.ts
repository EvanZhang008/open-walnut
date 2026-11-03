/**
 * Which half of Tree Mode's split screen a timeline renders (useTreeSplit).
 * The panel gives it: `R` to its own timeline while split, `L` to the second
 * timeline it mounts for the left half, `only` while a wide pane shows one page
 * (its header then offers Split). Null: no split chrome (a narrow column,
 * Conversation Mode), the stack row as it always was.
 */
import { createContext, useContext } from 'react';

export interface TreeHalf {
  side: 'L' | 'R' | 'only';
  /** The question's label (its thread id, `6.1`); none for Main or an Ask not sent. */
  number?: string;
  /** The close button on a half: back to one pane. */
  onClose?: () => void;
  /** Single, wide: split again (this page on the right, its parent on the left). */
  onSplit?: () => void;
}

export const TreeHalfContext = createContext<TreeHalf | null>(null);

export function useTreeHalf(): TreeHalf | null {
  return useContext(TreeHalfContext);
}
