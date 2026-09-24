import { useEffect, useState } from 'react';
import type { SessionCronJob } from '@open-walnut/core';
import { useActiveSessionCron } from '@/hooks/useSessionStatus';
import { changeSessionSupervision, type SupervisionSnapshot } from '@/stores/session-supervision-store';
import { cronPromptPreview, formatCronClock, formatCronDistance } from '@/utils/cron-job-text';
import { onPageVisible } from '@/utils/page-visibility';
import '@/styles/session-supervision.css';

const RECOVERY_STATE: Record<string, string> = {
  watching: 'Watching',
  restarting: 'Restarting',
  checking: 'Checking',
  disabled: 'Off',
  inactive: 'Idle',
  blocked: 'Blocked',
};

const RECOVERY_STARTUP: Record<string, string> = {
  boot: 'host starts the daemon at boot',
  login: 'host starts the daemon at login',
  'on-demand': 'daemon starts on demand',
  service: 'service running, startup not verified',
  unavailable: 'host unavailable',
};

/** Re-renders each minute while mounted so "in 12m" stays honest; a hidden tab
 *  catches up the moment it becomes visible. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 60_000);
    const off = onPageVisible(tick);
    return () => { clearInterval(timer); off(); };
  }, []);
  return now;
}

function JobRow({ job, now }: { job: SessionCronJob; now: number }) {
  const [promptOpen, setPromptOpen] = useState(false);
  const schedule = job.schedule || job.cron || 'Schedule not reported';
  const facts: string[] = [];
  facts.push(job.recurring ? 'Recurring' : 'Runs once');
  facts.push(job.durable ? 'Saved to disk' : 'Session-only');
  if (job.recurring && job.expiresAt !== null) facts.push(`Expires ${formatCronClock(job.expiresAt, now)}`);
  if (job.createdAt !== null) facts.push(`Created ${formatCronClock(job.createdAt, now)}`);
  facts.push(`Job ${job.id}`);
  const preview = cronPromptPreview(job.prompt);
  return (
    <li className="session-cron-job" data-job-id={job.id}>
      <div className="session-cron-job-heading">
        <strong>{schedule}</strong>
        {/* The CLI echoes the raw expression as its own wording when it cannot
            phrase one, so only show the chip when it adds something. */}
        {job.cron && job.schedule && job.cron !== job.schedule && <code title="Cron expression">{job.cron}</code>}
      </div>
      <div className="session-cron-job-next">
        {job.nextRunAt !== null
          ? <>Next run <time dateTime={new Date(job.nextRunAt).toISOString()}>{formatCronClock(job.nextRunAt, now)}</time> ({formatCronDistance(job.nextRunAt, now)})</>
          : 'Next run not computable from this expression'}
      </div>
      <div className="session-cron-job-facts">{facts.join(' · ')}</div>
      {job.prompt ? (
        <div className="session-cron-prompt" data-open={promptOpen}>
          <button
            type="button"
            className="session-cron-prompt-toggle"
            aria-expanded={promptOpen}
            onClick={() => setPromptOpen((open) => !open)}
          >
            <span className="session-cron-prompt-label">Prompt</span>
            {!promptOpen && <span className="session-cron-prompt-preview">{preview}</span>}
          </button>
          {promptOpen && (
            <>
              <pre className="session-cron-prompt-text">{job.prompt}</pre>
              {job.promptTruncated && <p className="session-cron-prompt-note">Showing the first {job.prompt.length.toLocaleString()} characters.</p>}
            </>
          )}
        </div>
      ) : (
        <div className="session-cron-prompt-note">Prompt not reported for this job.</div>
      )}
    </li>
  );
}

/**
 * What the header's CRON pill opens: the session's live cron jobs as the CLI
 * reported them. Automatic recovery is a different feature and gets one compact
 * switch row at the bottom, only when the host supports it; stop, error and
 * blocked states render themselves through SessionSupervisionBar regardless.
 */
export function CronJobsCard({ sid, snapshot, open, onClose, archived }: {
  sid: string;
  snapshot: SupervisionSnapshot;
  open: boolean;
  onClose: () => void;
  archived?: boolean;
}) {
  const cron = useActiveSessionCron(sid);
  const now = useMinuteClock();
  // The pill is the only way in, so when it goes (job deleted, expired, session
  // stopped) the open flag goes with it instead of springing back hours later.
  useEffect(() => { if (open && !cron) onClose(); }, [open, cron, onClose]);
  if (!open || !cron) return null;
  const jobs = cron.jobs;
  // A failed write is SessionSupervisionBar's job: it forces itself open above
  // this card, so the error and its retry live in exactly one place.
  const { value, writing, stopping, stopPending, requestedEnabled, unavailable } = snapshot;
  const supervision = value?.supervision;
  const recoveryEnabled = requestedEnabled ?? supervision?.enabled ?? false;
  // An unreachable host is SessionSupervisionBar's forced case; no second, dead switch here.
  const recoveryStale = unavailable || value?.available === false;
  const recoveryTitle = [
    supervision?.reason ? supervision.reason.replace(/-/g, ' ') : null,
    value?.startup ? RECOVERY_STARTUP[value.startup] : null,
  ].filter(Boolean).join('; ');
  return (
    <section className="session-cron-detail" aria-label="Cron jobs" data-job-count={jobs?.length ?? 'unknown'}>
      <div className="session-cron-detail-heading">
        <strong role="status">{jobs === undefined ? 'Cron job' : `Cron job${jobs.length === 1 ? '' : 's'} · ${jobs.length}`}</strong>
        <button type="button" className="session-cron-detail-close" onClick={onClose} aria-label="Hide cron job details" title="Hide">×</button>
      </div>
      {/* The list scrolls on its own so a full card never pushes the chat or the
          composer out of the panel; heading and recovery row stay put. */}
      <div className="session-cron-detail-body">
        {jobs === undefined && (
          <p className="session-cron-prompt-note">The host confirmed a live cron job but its daemon predates job details. They appear after the daemon updates.</p>
        )}
        {jobs && jobs.length === 0 && (
          <p className="session-cron-prompt-note">The host reports a live cron job but sent no job details.</p>
        )}
        {jobs && jobs.length > 0 && (
          <ul className="session-cron-jobs">
            {jobs.map((job) => <JobRow key={job.id} job={job} now={now} />)}
          </ul>
        )}
      </div>
      {supervision && !archived && !recoveryStale && (
        <div className="session-cron-recovery">
          <label className="session-supervision-toggle" title="Only changes automatic recovery after a host restart; it never touches the cron job or the running session">
            <input type="checkbox" role="switch" aria-label="Automatic cron recovery" checked={recoveryEnabled}
              disabled={writing || stopping || stopPending}
              onChange={(event) => { void changeSessionSupervision(sid, event.target.checked); }} />
            Auto-recover after host restart
          </label>
          <span className="session-cron-recovery-state" title={recoveryTitle || undefined}>
            {RECOVERY_STATE[supervision.state] ?? supervision.state}
          </span>
          {requestedEnabled !== null && <span role="status">Saving…</span>}
        </div>
      )}
    </section>
  );
}
