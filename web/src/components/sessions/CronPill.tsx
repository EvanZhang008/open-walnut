import { useRef } from 'react';
import { useActiveSessionCron } from '@/hooks/useSessionStatus';
import { useRowPillFold } from '@/hooks/useRowPillFold';
import { cronPillTitle } from '@/utils/cron-job-text';
import '@/styles/session-supervision.css';

export interface CronPillProps {
  sessionId: string | null | undefined;
  onClick?: () => void;
  expanded?: boolean;
}

export function CronPill({ sessionId, onClick, expanded }: CronPillProps) {
  const cron = useActiveSessionCron(sessionId);
  const spanRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useRowPillFold(spanRef, !!cron && !onClick);
  useRowPillFold(buttonRef, !!cron && !!onClick);
  if (!cron) return null;

  const title = cronPillTitle(cron.jobs);

  if (!onClick) {
    return (
      <span
        ref={spanRef}
        className="session-cron-pill task-row-pill"
        title={title}
        aria-label="Cron job armed"
        data-cron-presence="active"
        data-cron-source="cron"
        data-short="C"
      >
        <span className="task-pill-long">CRON</span>
      </span>
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      className="session-cron-pill task-row-pill"
      title={title}
      aria-label={expanded ? 'Cron job armed. Hide job details' : 'Cron job armed. Show job details'}
      aria-expanded={!!expanded}
      data-cron-presence="active"
      data-cron-source="cron"
      // A narrow session header shows this letter instead of the word (CSS only).
      data-short="C"
      onClick={(event) => { event.stopPropagation(); onClick(); }}
    >
      <span className="task-pill-long">CRON</span>
    </button>
  );
}
