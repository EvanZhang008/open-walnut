import type { RecapTipFields } from '@/stores/recap-tip-store';
import { useRecapTip } from '@/stores/recap-tip-store';
import '@/styles/session-recap.css';

/**
 * The recap tip above the composer: two rows the turn-complete self-report
 * writes onto the session record, so the user re-orients on a long session
 * without re-reading the transcript.
 *
 *   Overall  what the whole session is about and where it stands (`overview`)
 *   Latest   what just happened in the last turn(s)                (`recap`)
 *
 * Both texts are written in the user's display language (config.agent.language);
 * the server owns that. The two row labels are UI chrome and stay English like
 * every other label in the app. A record from before the overview existed shows
 * the Latest row alone.
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

export function SessionRecapTip({ sessionId, session, hidden = false }: SessionRecapTipProps) {
  const tip = useRecapTip(sessionId, session);
  const overview = tip.overview?.trim() ?? '';
  const recap = tip.recap?.trim() ?? '';
  if (hidden || (!overview && !recap) || tip.dismissed) return null;

  return (
    <div className="session-recap-tip" role="note" aria-label="Session recap" data-testid="session-recap-tip">
      <span className="session-recap-tip-icon" aria-hidden="true">💬</span>
      <div className="session-recap-tip-rows">
        {overview && (
          <div className="session-recap-tip-row" data-testid="session-recap-overview">
            <span className="session-recap-tip-label">Overall</span>
            <span className="session-recap-tip-text" title={overview}>{overview}</span>
          </div>
        )}
        {recap && (
          <div className="session-recap-tip-row" data-testid="session-recap-latest">
            <span className="session-recap-tip-label">Latest</span>
            <span className="session-recap-tip-text" title={recap}>{recap}</span>
          </div>
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
