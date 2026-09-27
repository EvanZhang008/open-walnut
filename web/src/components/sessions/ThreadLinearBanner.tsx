/**
 * Show all in order (spec 5.9): a thin banner over the linear transcript with
 * the way back to the question page it was opened from.
 */
import { memo } from 'react';

export const LINEAR_BANNER_TEXT = 'Showing every message in order.';
export const BACK_TO_QUESTIONS = 'Back to questions';

export const ThreadLinearBanner = memo(function ThreadLinearBanner({ onBack }: { onBack: () => void }) {
  return (
    <div className="thread-linear-banner" role="status">
      <span className="thread-linear-banner-text">{LINEAR_BANNER_TEXT}</span>
      <button type="button" className="thread-linear-banner-back" data-thread-focus-ring="" onClick={onBack}>
        {BACK_TO_QUESTIONS}
      </button>
    </div>
  );
});
