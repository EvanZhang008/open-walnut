/**
 * Job lifecycle logic — adapted from moltbot/src/cron/service/jobs.ts
 */

import { generateId } from '../../utils/format.js';
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronPayload,
  CronPayloadPatch,
  CronDelivery,
  CronServiceState,
  InitProcessor,
} from './types.js';
import { computeNextRunAtMs } from './schedule.js';

const STUCK_RUN_MS = 2 * 60 * 60 * 1000; // 2 hours

function resolveEveryAnchorMs(schedule: { everyMs: number; anchorMs?: number }, fallbackMs: number): number {
  const raw = schedule.anchorMs;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, Math.floor(raw));
  }
  return Math.max(0, Math.floor(fallbackMs));
}

export function assertSupportedJobSpec(job: Pick<CronJob, 'sessionTarget' | 'payload'>): void {
  if (job.sessionTarget === 'main' && job.payload.kind !== 'systemEvent') {
    throw new Error('main cron jobs require payload.kind="systemEvent"');
  }
  if (job.sessionTarget === 'isolated' && job.payload.kind !== 'agentTurn') {
    throw new Error('isolated cron jobs require payload.kind="agentTurn"');
  }
}

export function findJobOrThrow(state: CronServiceState, id: string): CronJob {
  const job = state.store?.jobs.find((j) => j.id === id);
  if (!job) throw new Error(`unknown cron job id: ${id}`);
  return job;
}

export function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined {
  if (!job.enabled) return undefined;

  if (job.schedule.kind === 'every') {
    const anchorMs = resolveEveryAnchorMs(job.schedule, job.createdAtMs);
    return computeNextRunAtMs({ ...job.schedule, anchorMs }, nowMs);
  }

  if (job.schedule.kind === 'at') {
    // One-shot jobs stay due until they successfully finish
    if (job.state.lastStatus === 'ok' && job.state.lastRunAtMs) {
      return undefined;
    }
    const atMs = new Date(job.schedule.at).getTime();
    return Number.isFinite(atMs) ? atMs : undefined;
  }

  return computeNextRunAtMs(job.schedule, nowMs);
}

export function recomputeNextRuns(state: CronServiceState): boolean {
  if (!state.store) return false;
  let changed = false;
  const now = state.deps.nowMs();

  for (const job of state.store.jobs) {
    if (!job.state) {
      job.state = {};
      changed = true;
    }
    if (!job.enabled) {
      if (job.state.nextRunAtMs !== undefined) {
        job.state.nextRunAtMs = undefined;
        changed = true;
      }
      if (job.state.runningAtMs !== undefined) {
        job.state.runningAtMs = undefined;
        changed = true;
      }
      continue;
    }
    // Clear stuck running markers
    const runningAt = job.state.runningAtMs;
    if (typeof runningAt === 'number' && now - runningAt > STUCK_RUN_MS) {
      state.deps.log.warn('clearing stuck running marker', { jobId: job.id, runningAtMs: runningAt });
      job.state.runningAtMs = undefined;
      changed = true;
    }
    // Only recompute if missing or past-due
    const nextRun = job.state.nextRunAtMs;
    if (nextRun === undefined || now >= nextRun) {
      const newNext = computeJobNextRunAtMs(job, now);
      if (job.state.nextRunAtMs !== newNext) {
        job.state.nextRunAtMs = newNext;
        changed = true;
      }
    }
  }
  return changed;
}

export function nextWakeAtMs(state: CronServiceState): number | undefined {
  const jobs = state.store?.jobs ?? [];
  const enabled = jobs.filter((j) => j.enabled && typeof j.state.nextRunAtMs === 'number');
  if (enabled.length === 0) return undefined;
  return enabled.reduce(
    (min, j) => Math.min(min, j.state.nextRunAtMs as number),
    enabled[0].state.nextRunAtMs as number,
  );
}

export function createJob(state: CronServiceState, input: CronJobCreate): CronJob {
  const now = state.deps.nowMs();
  const id = generateId();
  const schedule =
    input.schedule.kind === 'every'
      ? { ...input.schedule, anchorMs: resolveEveryAnchorMs(input.schedule, now) }
      : input.schedule;

  const deleteAfterRun =
    typeof input.deleteAfterRun === 'boolean'
      ? input.deleteAfterRun
      : schedule.kind === 'at' ? true : undefined;

  const enabled = typeof input.enabled === 'boolean' ? input.enabled : true;

  const job: CronJob = {
    id,
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    enabled,
    deleteAfterRun,
    createdAtMs: now,
    updatedAtMs: now,
    schedule,
    sessionTarget: input.sessionTarget,
    wakeMode: input.wakeMode,
    initProcessor: input.initProcessor,
    payload: input.payload,
    delivery: input.delivery,
    state: { ...input.state },
  };

  assertSupportedJobSpec(job);
  job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
  return job;
}

export function applyJobPatch(job: CronJob, patch: CronJobPatch): void {
  if ('name' in patch && patch.name) {
    job.name = patch.name.trim();
  }
  if ('description' in patch) {
    job.description = patch.description?.trim() || undefined;
  }
  if (typeof patch.enabled === 'boolean') {
    job.enabled = patch.enabled;
  }
  if (typeof patch.deleteAfterRun === 'boolean') {
    job.deleteAfterRun = patch.deleteAfterRun;
  }
  if (patch.schedule) {
    job.schedule = patch.schedule;
  }
  if (patch.sessionTarget) {
    job.sessionTarget = patch.sessionTarget;
  }
  if (patch.wakeMode) {
    job.wakeMode = patch.wakeMode;
  }
  if (patch.payload) {
    job.payload = mergeCronPayload(job.payload, patch.payload);
  }
  if ('initProcessor' in patch) {
    if (patch.initProcessor === null) {
      job.initProcessor = undefined;
    } else if (patch.initProcessor) {
      const merged = { ...job.initProcessor, ...patch.initProcessor };
      if (typeof merged.actionId === 'string' && merged.actionId.length > 0) {
        job.initProcessor = merged as InitProcessor;
      }
    }
  }
  if (patch.delivery) {
    job.delivery = mergeCronDelivery(job.delivery, patch.delivery);
  }
  if (job.sessionTarget === 'main' && job.delivery) {
    job.delivery = undefined;
  }
  if (patch.state) {
    job.state = { ...job.state, ...patch.state };
  }
  assertSupportedJobSpec(job);
}

function mergeCronPayload(existing: CronPayload, patch: CronPayloadPatch): CronPayload {
  if (patch.kind !== existing.kind) {
    return buildPayloadFromPatch(patch);
  }

  if (patch.kind === 'systemEvent') {
    if (existing.kind !== 'systemEvent') return buildPayloadFromPatch(patch);
    const text = typeof patch.text === 'string' ? patch.text : existing.text;
    return { kind: 'systemEvent', text };
  }

  if (existing.kind !== 'agentTurn') return buildPayloadFromPatch(patch);
  const next = { ...existing };
  if (typeof patch.message === 'string') next.message = patch.message;
  if (typeof patch.timeoutSeconds === 'number') next.timeoutSeconds = patch.timeoutSeconds;
  return next;
}

function buildPayloadFromPatch(patch: CronPayloadPatch): CronPayload {
  if (patch.kind === 'systemEvent') {
    if (typeof patch.text !== 'string' || patch.text.length === 0) {
      throw new Error('cron.update payload.kind="systemEvent" requires text');
    }
    return { kind: 'systemEvent', text: patch.text };
  }
  if (typeof patch.message !== 'string' || patch.message.length === 0) {
    throw new Error('cron.update payload.kind="agentTurn" requires message');
  }
  return {
    kind: 'agentTurn',
    message: patch.message,
    timeoutSeconds: patch.timeoutSeconds,
  };
}

function mergeCronDelivery(
  existing: CronDelivery | undefined,
  patch: Partial<CronDelivery>,
): CronDelivery {
  const next: CronDelivery = {
    mode: existing?.mode ?? 'none',
    bestEffort: existing?.bestEffort,
  };
  if (typeof patch.mode === 'string') next.mode = patch.mode;
  if (typeof patch.bestEffort === 'boolean') next.bestEffort = patch.bestEffort;
  return next;
}

export function isJobDue(job: CronJob, nowMs: number, opts: { forced: boolean }): boolean {
  if (!job.state) job.state = {};
  if (typeof job.state.runningAtMs === 'number') return false;
  if (opts.forced) return true;
  return job.enabled && typeof job.state.nextRunAtMs === 'number' && nowMs >= job.state.nextRunAtMs;
}
