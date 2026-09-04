import { useCallback, useState } from 'react';
import type { ComposerThreadAnchor } from '@/utils/thread-tree';

/**
 * The composer's thread chip: "↳ asking about: <passage>", sitting directly above
 * the input box.
 *
 * It is the one visible answer to "where will this message go?". Anchoring is
 * STICKY (a follow-up stays in the thread without re-selecting anything), which is
 * exactly the kind of hidden state that surprises people — so the chip stays until
 * it is dismissed, and the first one a browser ever shows says what sticky means.
 */

/** Shown once per browser, next to the first chip that ever appears. */
const TIP_KEY = 'walnut:thread-chip-tip-seen';

function tipSeen(): boolean {
  try { return localStorage.getItem(TIP_KEY) === '1'; } catch { return true; }
}

interface ThreadAnchorChipProps {
  anchor: ComposerThreadAnchor;
  /** hsl hue of the thread this anchor belongs to. */
  hue: number;
  onClear: () => void;
}

export function ThreadAnchorChip({ anchor, hue, onClear }: ThreadAnchorChipProps) {
  const [showTip, setShowTip] = useState(() => !tipSeen());

  const dismissTip = useCallback(() => {
    setShowTip(false);
    try { localStorage.setItem(TIP_KEY, '1'); } catch { /* private browsing — it may show again */ }
  }, []);

  // The passage in full on hover: the chip's label is one clipped line, and the
  // user needs to be able to check WHICH passage without sending anything.
  const full = anchor.quote?.exact ?? anchor.label;

  return (
    <div className="thread-anchor-chip-wrap" style={{ ['--thread-hue' as string]: hue } as React.CSSProperties}>
      <div className="thread-anchor-chip" data-testid="thread-anchor-chip" title={full}>
        <span className="thread-anchor-chip-arrow" aria-hidden="true">↳</span>
        <span className="thread-anchor-chip-text">
          asking about: <span className="thread-anchor-chip-label">“{anchor.label}”</span>
        </span>
        <button
          type="button"
          className="thread-anchor-chip-clear"
          title="Back to the top level (this message starts a new thread)"
          aria-label="Clear the thread anchor"
          data-testid="thread-anchor-clear"
          onClick={onClear}
        >
          ×
        </button>
      </div>
      {showTip && (
        <div className="thread-anchor-chip-tip" role="note">
          <span>Asking without a selection stays in this thread. Press × to return to the top level.</span>
          <button
            type="button"
            className="thread-anchor-chip-tip-dismiss"
            onClick={dismissTip}
            aria-label="Dismiss this tip"
          >
            Got it
          </button>
        </div>
      )}
    </div>
  );
}
