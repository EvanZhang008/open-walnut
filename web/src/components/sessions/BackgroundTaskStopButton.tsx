/**
 * BackgroundTaskStopButton — stops ONE background agent / command / workflow of
 * a session from the Background tasks reader. The turn and the other tasks keep
 * running (CLI `stop_task`, via POST /api/v1/sessions/:id/background-tasks/:taskId/stop).
 *
 * Two clicks: the first arms it ("Stop?") for a few seconds, the second sends.
 * Stopping throws the task's unfinished work away and cannot be undone, and the
 * button sits in a header a reader clicks around in.
 *
 * After a confirmed stop the button stays "Stopping…" until the ledger row's own
 * status leaves running (the CLI's terminal notification, through the usual live
 * event): the reply only says the CLI accepted the request. Mount it with
 * `key={taskId}` so a different task never inherits another's state.
 */

import { useEffect, useRef, useState } from 'react';
import { stopBackgroundTask } from '@/api/sessions';
import { log } from '@/utils/log';
import '@/styles/background-task-stop.css';

/** How long the armed ("Stop?") state waits for the confirming click. */
const ARM_MS = 4_000;
/** A stop the ledger never reflects (a lost terminal event) frees the button after this. */
const STOPPING_MAX_MS = 20_000;

type Phase = 'idle' | 'armed' | 'stopping' | 'error';

function errorText(err: unknown): string {
  const body = (err as { body?: { error?: { message?: unknown } | unknown } } | undefined)?.body;
  const nested = body && typeof body === 'object' ? (body as { error?: { message?: unknown } }).error : undefined;
  if (nested && typeof nested === 'object' && typeof nested.message === 'string') return nested.message;
  return err instanceof Error && typeof err.message === 'string' ? err.message : 'Stop failed';
}

export function BackgroundTaskStopButton({ sessionId, taskId, noun }: {
  sessionId: string;
  taskId: string;
  /** What the task is, for the labels: agent, command, workflow, task. */
  noun: string;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const disarm = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(disarm.current), []);

  const onClick = async () => {
    if (phase === 'stopping') return;
    if (phase !== 'armed') {
      setPhase('armed');
      setError('');
      clearTimeout(disarm.current);
      disarm.current = setTimeout(() => setPhase((p) => (p === 'armed' ? 'idle' : p)), ARM_MS);
      return;
    }
    clearTimeout(disarm.current);
    setPhase('stopping');
    try {
      const res = await stopBackgroundTask(sessionId, taskId);
      log.info('background-tasks', 'stop accepted', { sessionId, taskId, stopped: res.stopped, status: res.status });
      disarm.current = setTimeout(() => setPhase((p) => (p === 'stopping' ? 'idle' : p)), STOPPING_MAX_MS);
    } catch (err) {
      const message = errorText(err);
      log.warn('background-tasks', 'stop failed', { sessionId, taskId, error: message });
      setError(message);
      setPhase('error');
    }
  };

  const label = phase === 'armed' ? `Stop this ${noun}?`
    : phase === 'stopping' ? 'Stopping…'
    : phase === 'error' ? 'Retry stop'
    : 'Stop';
  return (
    <span className="bg-task-stop-wrap">
      {phase === 'error' && <span className="bg-task-stop-error" role="alert" title={error}>{error}</span>}
      <button
        type="button"
        className={`bg-task-stop bg-task-stop--${phase}`}
        data-testid="bg-task-stop"
        data-phase={phase}
        onClick={onClick}
        disabled={phase === 'stopping'}
        aria-label={phase === 'armed' ? `Confirm: stop this ${noun}` : `Stop this ${noun}`}
        title={phase === 'armed' ? 'Click again to stop it. Its unfinished work is lost.' : `Stop this ${noun}; the session keeps running`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" /></svg>
        <span>{label}</span>
      </button>
    </span>
  );
}
