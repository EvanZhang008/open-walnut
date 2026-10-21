/**
 * A transfer runs as a job: packing and copying a workspace can take minutes,
 * and no request may hold a connection that long (a pinned response starves
 * the browser's six-connection pool). POST starts the job and waits a bounded
 * while; anything still running answers 202 with the job id, and
 * GET /transfers/:id reads it back (bounded too).
 *
 * In memory on purpose: a transfer is one server's work, a restart ends it,
 * and what it made (the new task, the source's links) is already stored.
 */
import { randomUUID } from 'node:crypto';
import { log } from '../../logging/index.js';
import type { TransferRequest } from './planner.js';
import type { TransferResult } from './transfer.js';

export type TransferJobState = 'running' | 'done' | 'error';

export interface TransferJob {
  id: string;
  taskId: string;
  state: TransferJobState;
  startedAt: string;
  finishedAt?: string;
  result?: TransferResult;
  error?: { message: string; status: number; code?: string };
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
  const job: TransferJob = { id: `xf-${randomUUID().slice(0, 12)}`, taskId: req.taskId, state: 'running', startedAt: new Date().toISOString() };
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
