import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { TocEntry } from './SessionPinnedToc';
import { branchCountLabel, turnCountLabel } from '@/utils/thread-map-rows';

/**
 * The node view's permanent map: the whole conversation tree, always expanded, in
 * the timeline's left gutter.
 *
 * It reads the SAME list the outline rail reads (`tocEntries`), so there is one
 * answer to "what places does this conversation have" and one order to read them
 * in. It replaces the rail in tree mode rather than joining it: both park in the
 * top-left corner and would show the same rows twice.
 *
 * Clicking a row goes there in the only sense tree mode has: a thread row shows
 * that thread (and points the composer at it), a plain pin row scrolls to the pin
 * inside whichever thread holds it. Both handlers are the rail's own, passed in.
 */

interface SessionThreadMapProps {
  /** Pins and thread heads in transcript order: the outline, already merged. */
  entries: TocEntry[];
  /** Top-level branches, for the root row's count. */
  topCount: number;
  currentThreadKey: string;
  rootKey: string;
  /** The scroll container: what the map is measured against, and where it parks. */
  containerRef: RefObject<HTMLDivElement | null>;
  onJump: (pinKey: string) => void;
  onNavigate: (threadKey: string) => void;
  /** Pointer entered/left a thread row: tints that thread's timeline rows. */
  onHoverThread?: (key: string | null) => void;
}

/**
 * Below this the panel would eat the column. A session column runs ~400px wide, so
 * the map plus its gutter (200px) would leave too little for a turn to read in;
 * under the threshold it collapses to the rail's ticks and expands on hover, which
 * is the same trade the outline rail makes on every width.
 */
const PANEL_MIN_W = 520;

/** Close-out delay, same reason as the rail's: a diagonal path from the ticks to a
 *  row leaves the panel for a frame and would collapse it under the cursor. */
const COLLAPSE_DELAY_MS = 140;

/** Per-row style: the branch's hue, the row's nesting depth. Both ride CSS vars so
 *  the indent step and the colour recipe stay in the stylesheet. */
function rowVars(entry: TocEntry): React.CSSProperties | undefined {
  if (!entry.depth && entry.hue === undefined) return undefined;
  return {
    ...(entry.depth ? { ['--thread-indent' as string]: entry.depth } : {}),
    ...(entry.hue !== undefined ? { ['--thread-hue' as string]: entry.hue } : {}),
  } as React.CSSProperties;
}

export const SessionThreadMap = memo(function SessionThreadMap({
  entries, topCount, currentThreadKey, rootKey, containerRef, onJump, onNavigate, onHoverThread,
}: SessionThreadMapProps) {
  const [wide, setWide] = useState(false);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  // `offsetWidth`, not clientWidth: clientWidth drops the scrollbar, and the wide
  // layout adds padding (more content height can bring a scrollbar in), so a
  // scrollbar-sensitive measurement can flip back and forth across the threshold.
  //
  // Layout effect, not a plain one: the first measurement decides which of the two
  // shapes to draw at all, and after paint means every entry into tree mode flashes
  // the collapsed ticks for a frame before the panel replaces them.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setWide(el.offsetWidth >= PANEL_MIN_W);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  const show = useCallback(() => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), COLLAPSE_DELAY_MS);
  }, []);

  // The expanded panel needs room the container does not have by default, and a
  // component cannot style its ancestor: it publishes which shape it is in on the
  // scroll container it was handed, and the stylesheet reserves the gutter. Removed
  // on unmount, so linear mode is never left holding a map's padding.
  const shape = entries.length === 0 ? null : wide ? 'panel' : 'rail';
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !shape) return;
    el.setAttribute('data-thread-map', shape);
    return () => el.removeAttribute('data-thread-map');
  }, [containerRef, shape]);

  if (!shape) return null;

  const branches = branchCountLabel(topCount);

  const row = (entry: TocEntry) => {
    const isThread = !!entry.threadKey;
    const isCurrent = isThread && entry.threadKey === currentThreadKey;
    return (
      <button
        key={entry.key || 'top'}
        type="button"
        className={`thread-map-row${isThread ? ' thread-map-row--thread' : ' thread-map-row--pin'}${
          isCurrent ? ' is-current' : ''}`}
        {...(isCurrent ? { 'aria-current': 'true' as const } : {})}
        style={rowVars(entry)}
        title={entry.label}
        onMouseEnter={() => onHoverThread?.(entry.threadKey ?? null)}
        onMouseLeave={() => onHoverThread?.(null)}
        onClick={() => {
          if (entry.isThreadHead && entry.threadKey) onNavigate(entry.threadKey);
          onJump(entry.key);
        }}
      >
        <span className="thread-map-dot" aria-hidden="true" />
        <span className="thread-map-label">{entry.label}</span>
        {entry.turns !== undefined && (
          <span className="thread-map-meta">{turnCountLabel(entry.turns)}</span>
        )}
        {entry.hasNew && <span className="thread-map-new" title="New replies since you were last here">new</span>}
      </button>
    );
  };

  return (
    <div
      className={`thread-map${wide ? ' is-wide' : ''}${open ? ' is-open' : ''}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {!wide && (
        <button
          type="button"
          className="thread-map-rail"
          aria-expanded={open}
          aria-label={`Conversation map: ${entries.length} ${entries.length === 1 ? 'place' : 'places'}`}
          onClick={() => setOpen((p) => !p)}
        >
          {entries.map((entry) => (
            <span
              key={entry.key || 'top'}
              className={`session-toc-tick session-toc-tick--${entry.role}${entry.isQuote ? ' session-toc-tick--quote' : ''}${entry.threadKey ? ' session-toc-tick--thread' : ''}`}
              style={rowVars(entry)}
            />
          ))}
        </button>
      )}
      {(wide || open) && (
        <nav className="thread-map-panel" aria-label="Conversation map">
          <div className="thread-map-title">Map</div>
          <button
            type="button"
            className={`thread-map-row thread-map-row--root${currentThreadKey === rootKey ? ' is-current' : ''}`}
            {...(currentThreadKey === rootKey ? { 'aria-current': 'true' as const } : {})}
            title="The conversation outside every branch"
            onClick={() => onNavigate(rootKey)}
          >
            <span className="thread-map-dot" aria-hidden="true" />
            <span className="thread-map-label">Top level</span>
            {branches && <span className="thread-map-meta">{branches}</span>}
          </button>
          {entries.map(row)}
        </nav>
      )}
    </div>
  );
});
