/**
 * Long words cut to a few lines, with "Show more" / "Show less" under them: the one fold behind
 * every card's long text (2026-11-22, UI audit: a Needs you card's long body pushed its choices and
 * its box off the first screen; a Done card's body took most of the pane). The ask card's question
 * and why (actions/AskCard.tsx), a thread card's words (org/thread-card-text.tsx CardWords) and a
 * thread's answers and his own words all fold through here, so they cut, measure and open alike.
 *
 * The caller's class cuts the box (a line clamp or a max height in lines); `useCutOff` measures
 * whether it hides anything, so the toggle shows only when there is more. While folded, a click on
 * the text opens it too (a link, a pill, a picture or a selection keeps its own click). A click on
 * the toggle ends the hover peek first, so Show less cuts the text at once.
 */
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { DisclosureButton } from '@/components/controls';
import { useCutOff } from '@/hooks/useCutOff';
import { hidePeek } from '@/utils/truncation-peek';

/** The toggle's words, the same on every fold. */
export const FOLD_LABELS = { more: 'Show more', less: 'Show less' } as const;

export interface TextFoldState {
  ref: RefObject<HTMLDivElement | null>;
  /** Shown whole now (read for one look, never kept). */
  whole: boolean;
  setWhole: (whole: boolean) => void;
  /** The cut hides some of it. */
  cut: boolean;
}

export function useTextFold({ parts, slack }: {
  /** The cut texts inside the box (useCutOff `parts`); absent, the box itself. */
  parts?: string;
  slack?: number;
} = {}): TextFoldState {
  const ref = useRef<HTMLDivElement>(null);
  const [whole, setWhole] = useState(false);
  const cut = useCutOff(ref, { parts, whole, ...(slack !== undefined ? { slack } : {}) });
  return { ref, whole, setWhole, cut };
}

/** Show more / Show less, only while there is more (or it is open). */
export function FoldToggle({ fold, testId, className }: { fold: TextFoldState; testId: string; className?: string }) {
  if (!fold.cut && !fold.whole) return null;
  return (
    <DisclosureButton expanded={fold.whole} className={className} data-testid={testId} onClick={() => { hidePeek(); fold.setWhole(!fold.whole); }}>
      {fold.whole ? FOLD_LABELS.less : FOLD_LABELS.more}
    </DisclosureButton>
  );
}

/** What keeps its own click inside folded text. */
const OWN_CLICK = 'a, button, img, summary, details, input, [data-source], [data-lightbox-src]';

/** A box of words cut by `className`, its toggle under it (`<testId>-more`). */
export function TextFold({ children, className, testId, toggleClassName, slack = 4, data }: {
  children: ReactNode;
  /** Cuts the box (its lines), plus its look. */
  className: string;
  testId: string;
  toggleClassName?: string;
  slack?: number;
  data?: Record<`data-${string}`, string | undefined>;
}) {
  const fold = useTextFold({ slack });
  const folded = fold.cut && !fold.whole;
  return (
    <>
      <div
        ref={fold.ref}
        className={`${className}${fold.whole ? ' is-whole' : ''}${folded ? ' is-folded' : ''}`}
        data-testid={testId}
        data-text-fold=""
        {...data}
        onClick={folded ? (e) => {
          if ((e.target as HTMLElement).closest(OWN_CLICK)) return;
          if (window.getSelection()?.isCollapsed === false) return;
          fold.setWhole(true);
        } : undefined}
      >
        {children}
      </div>
      <FoldToggle fold={fold} testId={`${testId}-more`} className={toggleClassName} />
    </>
  );
}
