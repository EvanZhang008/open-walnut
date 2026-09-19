import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { outlineTimeLabel } from './outline-order';

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
  /** Thread nesting of the row's turn (0 = top level). Indents the row, so the
   *  outline shows the conversation's SHAPE and not just its marks. */
  depth?: number;
  /** hsl hue of the row's thread branch — colours the dash. */
  hue?: number;
  /** Set when this row belongs to a thread (the key `onAskThread` acts on). */
  threadKey?: string;
  /** This row opens a thread, so it gets the "Ask here" action. A thread head that
   *  is ALSO pinned is one row: the pin's key wins, these fields ride along. */
  isThreadHead?: boolean;
  /** The row exists ONLY because a thread starts here — there is no pin behind it,
   *  so it has nothing to unpin. */
  isThreadOnly?: boolean;
  /** Turns in the thread — its size, in the unit the transcript is made of. Filled
   *  in the node view only: the rail shows places, the map shows sizes too. */
  turns?: number;
  /** Rows landed in this thread since it was last looked at (node view only). */
  hasNew?: boolean;
}

interface SessionPinnedTocProps {
  entries: TocEntry[];
  onJump: (pinKey: string) => void;
  onUnpin?: (pinKey: string) => void;
  /** A jump happened and the previous position is still restorable. */
  canGoBack: boolean;
  onBack: () => void;
  /** Point the composer at this thread (the row's hover action). */
  onAskThread?: (threadKey: string) => void;
  /** Pointer entered/left a thread row — tints that thread's timeline rows. */
  onHoverThread?: (threadKey: string | null) => void;
  /** Node view only: the thread on screen, marked `is-current`. In the timeline
   *  view nothing is "current" — every thread is visible at once. */
  currentThreadKey?: string;
}

/** Close-out delay: a diagonal mouse path from the rail to a row would otherwise
 *  leave the panel for a frame and collapse it under the cursor. */
const COLLAPSE_DELAY_MS = 140;

/** Today's rows show the clock, any other day shows its date too (outline-order.ts). */
const timeLabel = (ts: string | undefined): string => outlineTimeLabel(ts);

/** Per-row style: the thread's hue for the dash, its depth for the indent. Both
 *  ride CSS vars so the indent step and the colour recipe live in one place. */
function rowStyle(entry: TocEntry): React.CSSProperties | undefined {
  if (!entry.depth && entry.hue === undefined) return undefined;
  return {
    ...(entry.depth ? { ['--thread-indent' as string]: entry.depth } : {}),
    ...(entry.hue !== undefined ? { ['--thread-hue' as string]: entry.hue } : {}),
  } as React.CSSProperties;
}

export const SessionPinnedToc = memo(function SessionPinnedToc({
  entries, onJump, onUnpin, canGoBack, onBack, onAskThread, onHoverThread, currentThreadKey,
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

  // Nothing pinned and no threads → no outline at all. The feature announces
  // itself by appearing with the first mark, so an unused session shows nothing.
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
        aria-label={`Outline — ${entries.length} marked ${entries.length === 1 ? 'place' : 'places'}`}
        onClick={() => setOpen((p) => !p)}
      >
        {entries.map((entry) => (
          <span
            key={entry.key || 'top'}
            className={`session-toc-tick session-toc-tick--${entry.role}${entry.isQuote ? ' session-toc-tick--quote' : ''}${entry.threadKey ? ' session-toc-tick--thread' : ''}`}
            style={rowStyle(entry)}
          />
        ))}
      </button>
      {open && (
        <div className="session-toc-panel" role="menu">
          {entries.map((entry) => (
            <div
              key={entry.key || 'top'}
              className={`session-toc-row${entry.threadKey ? ' session-toc-row--thread' : ''}${
                currentThreadKey !== undefined && entry.threadKey === currentThreadKey ? ' is-current' : ''}`}
              style={rowStyle(entry)}
              onMouseEnter={() => onHoverThread?.(entry.threadKey ?? null)}
              onMouseLeave={() => onHoverThread?.(null)}
            >
              <button
                type="button"
                className="session-toc-item"
                role="menuitem"
                onClick={(e) => {
                  // A thread row is a NODE of the map, so going there means going
                  // there in both senses: scroll to it, and point the composer at
                  // it. The outline used to carry a separate "Ask here" button for
                  // the second half; a map is for navigating, and one click that
                  // does what tree mode's node click already does beats an action
                  // button in a list of places.
                  if (entry.isThreadHead && entry.threadKey) onAskThread?.(entry.threadKey);
                  jump(e, entry.key);
                }}
                title={entry.isThreadHead ? `${entry.label} — go here and ask in this thread` : entry.label}
              >
                <span className={`session-toc-dash session-toc-dash--${entry.role}${entry.isQuote ? ' session-toc-dash--quote' : ''}${entry.threadKey ? ' session-toc-dash--thread' : ''}`} />
                <span className="session-toc-label">{entry.label}</span>
                {timeLabel(entry.timestamp) && (
                  <span className="session-toc-time">{timeLabel(entry.timestamp)}</span>
                )}
              </button>
              {onUnpin && entry.key && !entry.isThreadOnly && (
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
