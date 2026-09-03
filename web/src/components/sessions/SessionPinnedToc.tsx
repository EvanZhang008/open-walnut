import { memo, useCallback, useEffect, useRef, useState } from 'react';

/**
 * The transcript outline: one tick per pinned message, parked in the timeline's
 * top-left corner.
 *
 * Collapsed it is a stack of short dashes — enough to say "this conversation has
 * marked places, and roughly where they are" while costing almost no pixels of a
 * reading surface. Hovering (or focusing) expands it into the labelled list;
 * moving away collapses it again, so it never has to be dismissed.
 *
 * Clicking a row jumps to that message and arms "Back", which returns to exactly
 * the scroll position the jump left from. A jump you can't undo is a trap in a
 * long transcript: you lose your place to look at a pin.
 *
 * The rail is `position: sticky` INSIDE the scroll container rather than absolute
 * over it, so it rides along without stacking above the composer or the panel
 * header (both of which own their own layers).
 */

export interface TocEntry {
  /** Pin identity (`pinKeyOf`) — what a jump/unpin acts on. One message can hold
   *  a whole-message pin plus any number of quote pins, so the msgId below is an
   *  anchor, not an identity. */
  key: string;
  /** Anchor: SessionHistoryMessage.msgId. The special value '' = top of session. */
  msgId: string;
  label: string;
  role: 'user' | 'assistant' | 'system';
  /** Rendered as the row's secondary text when present. */
  timestamp?: string;
  /** A pinned PASSAGE rather than the whole message (labelled with a ❝ glyph, and
   *  its tick reads lighter so the rail still says which kind is where). */
  isQuote?: boolean;
}

interface SessionPinnedTocProps {
  entries: TocEntry[];
  onJump: (pinKey: string) => void;
  onUnpin?: (pinKey: string) => void;
  /** A jump happened and the previous position is still restorable. */
  canGoBack: boolean;
  onBack: () => void;
}

/** Close-out delay: a diagonal mouse path from the rail to a row would otherwise
 *  leave the panel for a frame and collapse it under the cursor. */
const COLLAPSE_DELAY_MS = 140;

function timeLabel(ts: string | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export const SessionPinnedToc = memo(function SessionPinnedToc({
  entries, onJump, onUnpin, canGoBack, onBack,
}: SessionPinnedTocProps) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const show = useCallback(() => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), COLLAPSE_DELAY_MS);
  }, []);

  const jump = useCallback((e: React.MouseEvent, pinKey: string) => {
    e.stopPropagation();
    onJump(pinKey);
    setOpen(false);
  }, [onJump]);

  // No pins → no outline at all. The feature announces itself by appearing when
  // the first message is pinned, so an unused session shows nothing.
  if (entries.length === 0) return null;

  return (
    <div
      className={`session-toc${open ? ' is-open' : ''}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <button
        type="button"
        className="session-toc-rail"
        aria-expanded={open}
        aria-label={`Outline — ${entries.length} pinned ${entries.length === 1 ? 'message' : 'messages'}`}
        onClick={() => setOpen((p) => !p)}
      >
        {entries.map((entry) => (
          <span
            key={entry.key || 'top'}
            className={`session-toc-tick session-toc-tick--${entry.role}${entry.isQuote ? ' session-toc-tick--quote' : ''}`}
          />
        ))}
      </button>
      {open && (
        <div className="session-toc-panel" role="menu">
          {entries.map((entry) => (
            <div key={entry.key || 'top'} className="session-toc-row">
              <button
                type="button"
                className="session-toc-item"
                role="menuitem"
                onClick={(e) => jump(e, entry.key)}
                title={entry.label}
              >
                <span className={`session-toc-dash session-toc-dash--${entry.role}${entry.isQuote ? ' session-toc-dash--quote' : ''}`} />
                <span className="session-toc-label">{entry.label}</span>
                {timeLabel(entry.timestamp) && (
                  <span className="session-toc-time">{timeLabel(entry.timestamp)}</span>
                )}
              </button>
              {onUnpin && entry.key && (
                <button
                  type="button"
                  className="session-toc-unpin"
                  title="Remove from the outline"
                  aria-label={`Unpin ${entry.label}`}
                  onClick={(e) => { e.stopPropagation(); onUnpin(entry.key); }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {canGoBack && (
            <button
              type="button"
              className="session-toc-back"
              onClick={(e) => { e.stopPropagation(); onBack(); setOpen(false); }}
            >
              ← Back to where I was
            </button>
          )}
        </div>
      )}
    </div>
  );
});
