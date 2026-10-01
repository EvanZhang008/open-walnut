/**
 * Live progress of an STT setup job (brew installs, the Python environment,
 * model downloads): one row per step, then one row of actions. The steps run in
 * stt-setup-job.ts, outside React, so this view can unmount and mount again
 * without touching them.
 *
 * Class names are `stt-run-*`, NOT the old `stt-setup-progress`/`stt-setup-step`:
 * globals.css still styles those as a bordered, padded box from before the
 * settings redesign, which pushed the bar and tags past the card's edge.
 */

import type { SttSetupJob, StepStatus } from './stt-setup-job';
import { SettingsRow, SettingsTag } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';

interface Props {
  job: SttSetupJob;
  /** Legacy install banner: the finished job waits for this click. Without it, finishing applies on its own. */
  onDone?: () => void;
  onRetry: () => void;
  onCancel: () => void;
}

const STEP_TAG: Record<StepStatus, string> = {
  done: 'Done',
  error: 'Failed',
  running: 'Running',
  pending: 'Waiting',
};

export function SttSetupProgress({ job, onDone, onRetry, onCancel }: Props) {
  const finished = job.status === 'done';
  const failed = job.status === 'failed';
  return (
    <div className="stt-run settings-rows-contents" data-testid="stt-setup-progress" data-status={job.status}>
      {job.states.map((step, i) => (
        <SettingsRow
          key={i}
          indent
          className="stt-run-step"
          data-step-status={step.status}
          label={step.label}
          help={step.message && step.status !== 'pending' ? step.message : undefined}
          state={step.status === 'error' ? 'warning' : undefined}
          control={
            step.status === 'running' ? (
              <span className="settings-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={step.percent ?? undefined}>
                <span className="settings-progress-track">
                  <span className="settings-progress-fill" style={{ width: `${step.percent ?? 0}%` }} />
                </span>
                <span className="settings-progress-pct">{step.percent === null ? '' : `${step.percent}%`}</span>
              </span>
            ) : (
              <SettingsTag tone={step.status === 'done' ? 'success' : step.status === 'error' ? 'warning' : 'neutral'}>
                {STEP_TAG[step.status]}
              </SettingsTag>
            )
          }
        />
      ))}
      <SettingsRow
        indent
        className="stt-run-actions"
        label={finished ? (onDone ? 'Setup finished' : 'Turning dictation on...') : failed ? 'Setup stopped' : 'Setting up'}
        control={
          <span className="settings-control-cluster">
            {finished && onDone && <SettingsButton variant="primary" onClick={onDone}>Done, apply config</SettingsButton>}
            {failed && <SettingsButton variant="primary" onClick={onRetry}>Retry</SettingsButton>}
            {!finished && <SettingsButton onClick={onCancel}>{failed ? 'Close' : 'Cancel'}</SettingsButton>}
          </span>
        }
      />
    </div>
  );
}
