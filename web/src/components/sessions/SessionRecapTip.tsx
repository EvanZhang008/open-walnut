import { useLayoutEffect, useRef, useState } from 'react';
import type { RecapTipFields } from '@/stores/recap-tip-store';
import { useRecapTip } from '@/stores/recap-tip-store';
import '@/styles/session-recap.css';

/**
 * The recap tip above the composer: two short paragraphs the turn-complete
 * self-report writes onto the session record, so the user re-orients on a long
 * session without re-reading the transcript.
 *
 *   Overall  what the whole session is about and where it stands (`overview`)
 *   Latest   what just happened in the last turn(s)                (`recap`)
 *
 * Each label is an inline run at the start of its paragraph, not a column: a
 * label column and a leading icon cost a narrow session column a third of its
 * width and stacked the card ten lines high (2026-09-19 report). The body is
 * capped at a few lines and scrolls past that, so the full text stays reachable
 * (never ellipsized) without the card swallowing the column. Nothing is drawn
 * for that scroll: a visible bar landed in the same top-right corner as the
 * dismiss button and read as two controls fighting over one spot (same report),
 * so the bar is hidden and the cue is the bottom line fading out while there is
 * more below.
 *
 * Both texts are written in the user's display language (config.agent.language);
 * the server owns that. The labels are UI chrome and stay English like every
 * other label in the app. A record from before the overview existed shows the
 * Latest paragraph alone.
 *
 * Text, live updates and dismissal all come from the recap-tip store, so the
 * main composer, the plan popover's composer and the Todo detail row agree.
 * The × hides THIS text: it comes back on its own when the next self-report
 * writes different text. It is not a global "never show recaps" switch.
 */

interface SessionRecapTipProps {
  sessionId: string;
  /** The panel's record; may still be loading (null), the store fills in. */
  session: RecapTipFields | null;
  /** True while the session streams: live output makes the tip redundant. */
  hidden?: boolean;
}

/**
 * Does the body overflow its capped box, and is it currently scrolled to the
 * end? Both drive the fade that stands in for the hidden scrollbar, and
 * `scrollable` also gates `overflow-y` itself: on macOS with "always show scroll
 * bars", WebKit treats `overflow: auto` as `scroll` even when nothing overflows
 * (see the Slack composer, 2026-09-16), which on a two-line card is exactly the
 * clutter this card is trying to lose.
 */
function useScrollState(ref: React.RefObject<HTMLElement | null>, deps: readonly unknown[]) {
  const [state, setState] = useState({ scrollable: false, atEnd: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setState((prev) => {
      const scrollable = el.scrollHeight > el.clientHeight + 1;
      // A box that cannot scroll is "at its end" — there is nothing to fade.
      const atEnd = !scrollable || el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      return prev.scrollable === scrollable && prev.atEnd === atEnd ? prev : { scrollable, atEnd };
    });
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', measure); ro?.disconnect(); };
  }, deps);
  return state;
}

export function SessionRecapTip({ sessionId, session, hidden = false }: SessionRecapTipProps) {
  const tip = useRecapTip(sessionId, session);
  const overview = tip.overview?.trim() ?? '';
  const recap = tip.recap?.trim() ?? '';
  const shown = !hidden && (!!overview || !!recap) && !tip.dismissed;
  const bodyRef = useRef<HTMLDivElement>(null);
  // `shown` is a dep too: the body only exists while shown, and a tip hidden
  // during streaming comes back with the same text, so the texts alone would
  // never re-measure it.
  const { scrollable, atEnd } = useScrollState(bodyRef, [overview, recap, shown]);
  if (!shown) return null;

  return (
    <div className="session-recap-tip" role="note" aria-label="Session recap" data-testid="session-recap-tip">
      <div
        ref={bodyRef}
        className={`session-recap-tip-body${scrollable ? ' is-scrollable' : ''}${scrollable && !atEnd ? ' has-more' : ''}`}
        data-scrollable={scrollable ? 'true' : 'false'}
        data-more={scrollable && !atEnd ? 'true' : 'false'}
        // A hidden scrollbar still needs a keyboard route to the rest of the
        // text; tabIndex makes the box focusable so arrows scroll it.
        tabIndex={scrollable ? 0 : undefined}
      >
        {overview && (
          <p className="session-recap-tip-row" data-testid="session-recap-overview">
            <span className="session-recap-tip-label">Overall</span>
            <span className="session-recap-tip-text">{overview}</span>
          </p>
        )}
        {recap && (
          <p className="session-recap-tip-row" data-testid="session-recap-latest">
            <span className="session-recap-tip-label">Latest</span>
            <span className="session-recap-tip-text">{recap}</span>
          </p>
        )}
      </div>
      <button
        type="button"
        className="session-recap-tip-close"
        onClick={tip.dismiss}
        title="Hide until the next recap"
        aria-label="Dismiss recap"
        data-testid="session-recap-dismiss"
      >
        ×
      </button>
    </div>
  );
}

/**
 * The dense-list twin: ONE truncated line of the latest recap for a session row
 * (Todo detail). Same store as the tip, so it never lags the column beside it;
 * no overview and no dismissal, because a list row is not a card. Renders
 * nothing without a recap.
 */
export function SessionRecapLine({ sessionId, session, className, style }: {
  sessionId: string;
  session: RecapTipFields | null | undefined;
  className?: string;
  style?: React.CSSProperties;
}) {
  const tip = useRecapTip(sessionId, session);
  const recap = tip.recap?.trim() ?? '';
  if (!recap) return null;
  return (
    <div className={className} style={style} title={recap} data-testid="session-recap-line">
      💬 {recap}
    </div>
  );
}
