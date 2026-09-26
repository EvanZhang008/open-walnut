/**
 * The ONE rendering of a host failure: the banner row, the picker's note, the
 * Settings row and the session error bar all use this, so a failure reads the
 * same everywhere. Text comes from the shared model (@open-walnut/host-problem)
 * and the server's hint verbatim; nothing here rewrites a sentence by kind.
 *
 *   .hft-headline  bold, two lines then clamped, title = full text
 *   .hft-hint      the server hint, `code` rendered as <code>
 *   .hft-details   'Show SSH output' (or 'Show details') -> pre.hft-summary
 *   .hft-when      'Walnut tries again in 3m 12s', only for a real schedule
 */
import { useEffect, useId, useState } from 'react';
import { DETAILS_NOT_SSH_KINDS, retryCountdownText } from '@open-walnut/host-problem';
import { InlineCodeText } from '@/components/common/InlineCodeText';
import { serverNow } from '@/hooks/useHostStatus';
import '@/styles/host-status.css';

export interface HostFailureTextProps {
  headline: string;
  hint?: string;
  /** The raw error (ssh output, a daemon log line): behind a toggle, never inline. */
  summary?: string;
  kind?: string;
  /** Epoch ms (server clock) of Walnut's next real attempt. No retryAt, no promise. */
  retryAt?: number;
  /** Server time of the newest frame for this host (a stale retryAt drops the line). */
  lastFrameAt?: number;
  /** Headline only; hint and summary behind 'Show details' (banner rows after the first). */
  collapsed?: boolean;
  testId?: string;
}

/** The toggle's words: SSH output for ssh kinds, details for filesystem / daemon kinds and collapsed rows. */
export function detailsToggleLabel(kind: string | undefined, expanded: boolean, collapsed = false): string {
  const details = collapsed || (!!kind && DETAILS_NOT_SSH_KINDS.includes(kind));
  if (details) return expanded ? 'Hide details' : 'Show details';
  return expanded ? 'Hide SSH output' : 'Show SSH output';
}

function RetryWhen({ retryAt, lastFrameAt }: { retryAt: number; lastFrameAt?: number }) {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(t);
  }, [retryAt]);
  const text = retryCountdownText(retryAt, now, lastFrameAt);
  if (!text) return null;
  return <div className="hft-when" aria-hidden="true">{text}</div>;
}

export function HostFailureText({ headline, hint, summary, kind, retryAt, lastFrameAt, collapsed, testId }: HostFailureTextProps) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const cleanHint = hint?.trim() ?? '';
  const cleanSummary = summary?.trim() ?? '';
  const hidden = collapsed ? (cleanHint || cleanSummary) : cleanSummary;
  return (
    <div className="hft" data-testid={testId} {...(kind ? { 'data-kind': kind } : {})}>
      <div className="hft-headline" title={headline}>{headline}</div>
      {!collapsed && cleanHint && <div className="hft-hint"><InlineCodeText text={cleanHint} /></div>}
      {typeof retryAt === 'number' && <RetryWhen retryAt={retryAt} lastFrameAt={lastFrameAt} />}
      {hidden && (
        <button
          type="button"
          // WebKit only tabs to buttons with an explicit tabindex (the Mac app).
          tabIndex={0}
          className="hft-details"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((v) => !v)}
        >
          {detailsToggleLabel(kind, expanded, collapsed)}
        </button>
      )}
      {hidden && expanded && (
        <div id={detailsId} className="hft-more">
          {collapsed && cleanHint && <div className="hft-hint"><InlineCodeText text={cleanHint} /></div>}
          {cleanSummary && <pre className="hft-summary">{cleanSummary}</pre>}
        </div>
      )}
    </div>
  );
}
