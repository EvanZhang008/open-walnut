import { useActiveSessionCron } from '@/hooks/useSessionStatus';
import { cronPillTitle } from '@/utils/cron-job-text';
import '@/styles/session-supervision.css';

export interface CronPillProps {
  sessionId: string | null | undefined;
  onClick?: () => void;
  expanded?: boolean;
}

export function CronPill({ sessionId, onClick, expanded }: CronPillProps) {
  const cron = useActiveSessionCron(sessionId);
  if (!cron) return null;

  const title = cronPillTitle(cron.jobs);

  if (!onClick) {
    return (
      <span
        className="session-cron-pill"
        title={title}
        aria-label="Cron job armed"
        data-cron-presence="active"
        data-cron-source="cron"
      >
        CRON
      </span>
    );
  }

  return (
    <button
      type="button"
      className="session-cron-pill"
      title={title}
      aria-label={expanded ? 'Cron job armed. Hide job details' : 'Cron job armed. Show job details'}
      aria-expanded={!!expanded}
      data-cron-presence="active"
      data-cron-source="cron"
      onClick={(event) => { event.stopPropagation(); onClick(); }}
    >
      CRON
    </button>
  );
}
