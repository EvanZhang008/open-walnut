/**
 * The quote head (spec 4, item 3; 5.4): the passage this page exists for, above
 * its first message, in the branch hue. A click pops back to that passage. A
 * passage under four words borrows its stored prefix / suffix (faint) so it
 * reads in context (C76). Scrolls with the page; it is not chrome.
 */
import { memo } from 'react';
import type { SessionPinnedQuote } from '@/types/session';
import { quoteHeadParts } from '@/utils/thread-stack-state';

export const SAME_PASSAGE_TEXT = 'You already asked about this passage.';

interface ThreadQuoteHeadProps {
  quote?: SessionPinnedQuote;
  hue: number;
  level: number;
  parentTitle: string;
  /** Faint line: the Ask landed on the question already about this passage. */
  samePassage?: boolean;
  onPop: () => void;
}

export const ThreadQuoteHead = memo(function ThreadQuoteHead({
  quote, hue, level, parentTitle, samePassage, onPop,
}: ThreadQuoteHeadProps) {
  const parts = quoteHeadParts(quote);
  return (
    <div className="thread-quote-head-wrap">
      {samePassage && <div className="thread-same-passage" role="status">{SAME_PASSAGE_TEXT}</div>}
      {/* Where the passage came from, in words (N35): the quote alone did not say. */}
      {parts && <div className="thread-quote-from">From <span className="thread-quote-from-title">{parentTitle}</span></div>}
      {parts && (
        <button
          type="button"
          className="thread-quote-head"
          data-thread-level={Math.min(Math.max(level, 1), 4)}
          style={{ ['--thread-hue' as string]: hue }}
          title={`Back to ${parentTitle}`}
          onClick={onPop}
        >
          {parts.prefix && <span className="thread-quote-context">{parts.prefix}</span>}
          <span className="thread-quote-exact">{parts.exact}</span>
          {parts.suffix && <span className="thread-quote-context">{parts.suffix}</span>}
        </button>
      )}
    </div>
  );
});
