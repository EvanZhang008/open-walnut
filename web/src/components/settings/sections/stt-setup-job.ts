/**
 * The running STT setup, kept OUTSIDE React so it outlives the Voice pane.
 *
 * Every settings pane switch unmounts the pane, and the server now stops a
 * setup step when its client goes away (so a closed tab does not keep a 30
 * minute download going). If the steps lived in the component, glancing at
 * another pane mid-download would cancel 2.3 GB of Qwen3-ASR. Here the fetch
 * belongs to the page, not the pane: the pane subscribes, shows the progress
 * when it mounts again, and a closed tab still ends it.
 *
 * One job at a time. `kind` says who started it: the one-button setup, the
 * legacy Homebrew install banner, or a single model download.
 */
import { useSyncExternalStore } from 'react';
import { startSetup, type SetupEvent } from '@/api/stt';
import type { SetupStep } from './stt-setup-plan';

export type StepStatus = 'pending' | 'running' | 'done' | 'error';

export interface StepState {
  label: string;
  status: StepStatus;
  /** null until the step reports one (a download with no known total never does). */
  percent: number | null;
  message: string;
}

export interface SttSetupJob {
  id: number;
  kind: 'setup' | 'install' | 'model';
  /** The engine this job prepares. */
  engine: string;
  steps: SetupStep[];
  states: StepState[];
  status: 'running' | 'done' | 'failed' | 'cancelled';
  /** What to apply once the steps finish (setup kind). */
  apply?: { activateModel?: string };
  /** Set once a mounted pane has taken the finished job over. */
  claimed?: boolean;
}

type Runner = typeof startSetup;

let job: SttSetupJob | null = null;
let controller: AbortController | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: SttSetupJob | null) {
  job = next;
  for (const l of listeners) l();
}

function patch(id: number, fn: (j: SttSetupJob) => SttSetupJob) {
  if (job?.id === id) publish(fn(job));
}

function patchStep(id: number, i: number, update: Partial<StepState>) {
  patch(id, (j) => ({ ...j, states: j.states.map((s, k) => (k === i ? { ...s, ...update } : s)) }));
}

export function getSttSetupJob(): SttSetupJob | null {
  return job;
}

export function subscribeSttSetupJob(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useSttSetupJob(): SttSetupJob | null {
  return useSyncExternalStore(subscribeSttSetupJob, getSttSetupJob, getSttSetupJob);
}

async function runSteps(id: number, steps: SetupStep[], signal: AbortSignal, runner: Runner) {
  for (let i = 0; i < steps.length; i++) {
    if (signal.aborted || job?.id !== id) return;
    patchStep(id, i, { status: 'running', percent: 0, message: 'Starting...' });
    // Assigned inside the event callback, which control-flow narrowing cannot see.
    let outcome = null as 'done' | 'error' | null;
    try {
      await runner(steps[i].action, steps[i].params, (event: SetupEvent) => {
        if (job?.id !== id) return;
        if (event.type === 'progress') {
          const cur = job.states[i];
          patchStep(id, i, { percent: event.percent ?? cur.percent, message: event.message ?? cur.message });
        } else if (event.type === 'done') {
          outcome = 'done';
          patchStep(id, i, { status: 'done', percent: 100, message: event.message ?? 'Done' });
        } else if (event.type === 'error') {
          outcome = 'error';
          patchStep(id, i, { status: 'error', message: event.message ?? 'Failed' });
        }
      }, signal);
    } catch (err) {
      if (signal.aborted) return;
      outcome = 'error';
      const msg = err instanceof Error ? err.message : String(err);
      patchStep(id, i, { status: 'error', message: `Lost the connection to Walnut: ${msg}` });
    }
    if (outcome === null) {
      // Every server step ends with done or error; a stream that just stops
      // means the connection dropped, which is not a success.
      outcome = 'error';
      patchStep(id, i, { status: 'error', message: 'Walnut stopped answering before this step finished.' });
    }
    if (outcome === 'error') {
      patch(id, (j) => ({ ...j, status: 'failed' }));
      return;
    }
  }
  patch(id, (j) => ({ ...j, status: 'done' }));
}

export function startSttSetupJob(
  init: Pick<SttSetupJob, 'kind' | 'engine' | 'steps' | 'apply'>,
  runner: Runner = startSetup,
): SttSetupJob {
  controller?.abort();
  controller = new AbortController();
  const id = nextId++;
  publish({
    ...init,
    id,
    states: init.steps.map((s) => ({ label: s.label, status: 'pending', percent: null, message: '' })),
    status: init.steps.length ? 'running' : 'done',
  });
  if (init.steps.length) void runSteps(id, init.steps, controller.signal, runner);
  return job!;
}

/** Stop the running step (the server stops it too) and forget the job. */
export function cancelSttSetupJob(): void {
  controller?.abort();
  controller = null;
  publish(null);
}

/** Drop a finished or failed job. */
export function clearSttSetupJob(id?: number): void {
  if (id !== undefined && job?.id !== id) return;
  if (job?.status === 'running') controller?.abort();
  controller = null;
  publish(null);
}

/** First caller wins: exactly one mounted pane applies a finished setup. */
export function claimSttSetupJob(id: number): boolean {
  if (job?.id !== id || job.claimed) return false;
  publish({ ...job, claimed: true });
  return true;
}
