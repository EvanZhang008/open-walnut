/**
 * A transfer runs as a job: packing and copying a workspace can take minutes,
 * and no request may hold a connection that long (a pinned response starves
 * the browser's six-connection pool). POST starts the job and waits a bounded
 * while; anything still running answers 202 with the job id, and
 * GET /transfers/:id reads it back (bounded too).
 *
 * In memory on purpose: a transfer is one server's work, a restart ends it,
 * and what it made (the new task, the source's links) is already stored. A
 * Claude to Claude transfer whose new task still reads `transfer_state:
 * 'pending'` once no job holds it is `unconfirmed`: nobody knows whether its
 * fork started, so nothing completes or removes anything on its own.
 */
import { randomUUID } from 'node:crypto';
import { log } from '../../logging/index.js';
import type { TransferRequest } from './planner.js';
import type { TransferResult } from './transfer.js';

export type TransferJobState = 'running' | 'done' | 'error' | 'unconfirmed';

export interface TransferJob {
  id: string;
  taskId: string;
  state: TransferJobState;
  startedAt: string;
  finishedAt?: string;
  result?: TransferResult;
  error?: { message: string; status: number; code?: string };
  /** An unconfirmed transfer: the task it made, which keeps its stage. */
  newTaskId?: string;
}

const KEEP_MS = 60 * 60_000;
const KEEP_MAX = 50;
/** Longest any request waits on a job. */
export const MAX_WAIT_MS = 25_000;

const jobs = new Map<string, TransferJob>();
const settled = new Map<string, Promise<void>>();

function prune(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.state !== 'running' && job.finishedAt && now - Date.parse(job.finishedAt) > KEEP_MS) { jobs.delete(id); settled.delete(id); }
  }
  while (jobs.size > KEEP_MAX) {
    const oldest = [...jobs.values()].find((j) => j.state !== 'running');
    if (!oldest) break;
    jobs.delete(oldest.id); settled.delete(oldest.id);
  }
}

/** The running job for a task, if any: a second click joins it instead of moving the work twice. */
export function runningTransferFor(taskId: string): TransferJob | undefined {
  return [...jobs.values()].find((j) => j.taskId === taskId && j.state === 'running');
}

export function startTransferJob(
  req: TransferRequest,
  run: (req: TransferRequest, transferId: string) => Promise<TransferResult>,
): TransferJob {
  const existing = runningTransferFor(req.taskId);
  if (existing) return existing;
  prune();
  // A full uuid: the id names the private stage dir, whose shape the daemon checks.
  const job: TransferJob = { id: `xf-${randomUUID()}`, taskId: req.taskId, state: 'running', startedAt: new Date().toISOString() };
  jobs.set(job.id, job);
  settled.set(job.id, run(req, job.id).then((result) => {
    job.state = 'done';
    job.result = result;
  }, (err: unknown) => {
    const e = err as { status?: unknown; code?: unknown };
    job.state = 'error';
    job.error = {
      message: err instanceof Error ? err.message : String(err),
      status: typeof e.status === 'number' ? e.status : 500,
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
    };
    log.session.warn('transfer job failed', { transferId: job.id, taskId: job.taskId, error: job.error.message, code: job.error.code });
  }).finally(() => { job.finishedAt = new Date().toISOString(); }));
  return job;
}

export function getTransferJob(id: string): TransferJob | undefined {
  return jobs.get(id);
}

/** A transfer this server no longer holds whose new task is still pending (a restart): unconfirmed. */
export async function unconfirmedTransferJob(id: string): Promise<TransferJob | undefined> {
  if (!/^xf-[0-9a-f-]{8,36}$/.test(id)) return undefined;
  const { listTasks } = await import('../task-manager.js');
  const made = (await listTasks()).find((t) => t.transfer?.id === id && t.transfer_state === 'pending');
  if (!made) return undefined;
  return {
    id, taskId: made.transferred_from ?? '', state: 'unconfirmed', startedAt: made.created_at,
    ...(made.transfer?.error ? { error: { message: made.transfer.error, status: 409, code: 'transfer_unconfirmed' } } : {}),
    newTaskId: made.id,
  };
}

/** Wait up to `ms` (capped) for the job to finish; returns it either way. */
export async function waitForTransferJob(job: TransferJob, ms: number): Promise<TransferJob> {
  const wait = Math.max(0, Math.min(MAX_WAIT_MS, Number.isFinite(ms) ? ms : 0));
  const done = settled.get(job.id);
  if (job.state !== 'running' || !done || wait === 0) return job;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([done, new Promise<void>((r) => { timer = setTimeout(r, wait); })]);
  clearTimeout(timer);
  return job;
}

export function _resetTransferJobsForTesting(): void {
  jobs.clear();
  settled.clear();
}
