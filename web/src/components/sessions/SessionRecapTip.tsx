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
 * (never ellipsized) without the card swallowing the column.
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
 * Whether the body's content is taller than its capped box, re-measured when
 * the column resizes. The scrollbar is switched on only then: on macOS with
 * "always show scroll bars", WebKit paints an `overflow: auto` track even when
 * nothing overflows (see the Slack composer, 2026-09-16), and an empty track on
 * a two-line card is exactly the clutter this card is trying to lose.
 */
function useOverflows(ref: React.RefObject<HTMLElement | null>, deps: readonly unknown[]): boolean {
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, deps);
  return overflows;
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
  const scrollable = useOverflows(bodyRef, [overview, recap, shown]);
  if (!shown) return null;

  return (
    <div className="session-recap-tip" role="note" aria-label="Session recap" data-testid="session-recap-tip">
      <div
        ref={bodyRef}
        className={`session-recap-tip-body${scrollable ? ' is-scrollable' : ''}`}
        data-scrollable={scrollable ? 'true' : 'false'}
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
