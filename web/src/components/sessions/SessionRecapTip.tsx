import { useRecapTip, type RecapTipFields } from '@/stores/recap-tip-store';

/*
 * The session recap, two short paragraphs the turn-complete self-report writes
 * onto the session record (Overall: what the whole session is about; Latest:
 * what just happened). The session column shows them on demand from the
 * composer's "+" menu (LatestUpdatePopover); this file keeps the list twin.
 */

/**
 * ONE truncated line of the latest recap for a session row (Todo detail). Same
 * store as the "+" menu's Latest update, so it never lags the column beside it.
 * Renders nothing without a recap.
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
      {recap}
    </div>
  );
}
