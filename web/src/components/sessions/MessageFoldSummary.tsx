/**
 * The line a folded session-message card shows: who, and the title. The whole
 * line is the toggle, so a click anywhere on it opens the message (message-fold.ts).
 */
import type { ReactNode } from 'react';

export function MessageFoldSummary({
  glyph, direction, sender, senderTitle, title, open, onToggle, after,
}: {
  glyph: string;
  /** "Reply from", "To", … */
  direction: string;
  sender: string;
  /** The sender's full name, as a tooltip (the line shows the short one). */
  senderTitle?: string;
  title?: string;
  open: boolean;
  onToggle: () => void;
  /** Shown under the title even while folded (an error the reader must see). */
  after?: ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        className="provenance-fold"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
      >
        <span className="provenance-fold-from">
          <span className="provenance-glyph" aria-hidden="true">{glyph}</span>
          <span className="provenance-fold-dir">{direction}</span>
          <span className="provenance-fold-sender" title={senderTitle ?? sender}>{sender}</span>
          <span className="provenance-fold-chevron" aria-hidden="true">›</span>
        </span>
        {title && <span className="provenance-fold-title">{title}</span>}
      </button>
      {after}
    </>
  );
}
