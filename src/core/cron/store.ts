/**
 * Store persistence — adapted from moltbot/src/cron/service/store.ts
 * Simplified: no legacy migrations since this is a fresh implementation.
 *
 * Two files, split on purpose (2026-08-04 re-fire storm): cron-jobs.json holds
 * DEFINITIONS only and rides git-sync between machines; cron-state.json (same
 * dir) holds per-job RUNTIME state and is machine-local + gitignored, so a
 * git-sync echo of another box's stale nextRunAtMs can never re-fire a job
 * here. Both files are only read/written inside locked() (timer.ts), which
 * holds the cross-process file lock on storePath — no separate sidecar lock.
 *
 * Safety: persist() creates a .backup file before writing an empty store
 * to prevent accidental data loss (e.g., a rogue DELETE sweep from tests).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { CronStoreFile, CronStateFile, CronJobState, CronServiceState } from './types.js';
import { readJsonFile, writeJsonFile } from '../../utils/fs.js';
import { recomputeNextRuns } from './jobs.js';
import { syncExecutorFields } from './executor-compat.js';

function emptyStore(): CronStoreFile {
  return { version: 2, jobs: [] };
}

function emptyStateFile(): CronStateFile {
  return { version: 1, states: {} };
}

/** Machine-local runtime-state sidecar, next to the (synced) jobs file. */
export function cronStatePath(storePath: string): string {
  return path.join(path.dirname(storePath), 'cron-state.json');
}

/**
 * Load the sidecar's state map. Runtime state is recomputable, so a corrupt
 * sidecar degrades to empty rather than failing the whole load.
 */
async function loadStateMap(state: CronServiceState): Promise<Record<string, CronJobState>> {
  try {
    const file = await readJsonFile<CronStateFile>(cronStatePath(state.deps.storePath), emptyStateFile());
    if (file && typeof file.states === 'object' && file.states !== null) return file.states;
  } catch (err) {
    state.deps.log.warn('cron state sidecar corrupted — starting with empty runtime state', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return {};
}

export async function ensureLoaded(
  state: CronServiceState,
  opts?: { forceReload?: boolean; skipRecompute?: boolean },
): Promise<void> {
  if (state.store && !opts?.forceReload) return;

  let loaded: CronStoreFile;
  try {
    loaded = await readJsonFile<CronStoreFile>(state.deps.storePath, emptyStore());
  } catch (err) {
    // File exists but is corrupt — try to recover from backup
    const backupPath = state.deps.storePath.replace(/\.json$/, '.backup.json');
    state.deps.log.error('cron store corrupted, attempting backup recovery', {
      error: err instanceof Error ? err.message : String(err),
      backupPath,
    });
    try {
      loaded = await readJsonFile<CronStoreFile>(backupPath, emptyStore());
      if (loaded.jobs.length > 0) {
        state.deps.log.info('recovered cron jobs from backup', { jobCount: loaded.jobs.length });
      }
    } catch {
      state.deps.log.error('backup recovery also failed, starting with empty store');
      loaded = emptyStore();
    }
  }
  const stateMap = await loadStateMap(state);

  let dirty = false;
  // Attach runtime state from the sidecar + migrate action payloads to initProcessor
  for (const job of loaded.jobs) {
    const hadEmbeddedState = !!job.state && typeof job.state === 'object';
    const sidecarState = stateMap[job.id];
    if (sidecarState && typeof sidecarState === 'object') {
      // Sidecar is authoritative — an embedded state here is an old binary's
      // (possibly stale, possibly echoed-back) write; strip it on persist.
      job.state = sidecarState;
      if (hadEmbeddedState) dirty = true;
    } else if (hadEmbeddedState) {
      // Legacy embedded state in cron-jobs.json (pre-sidecar file, or written
      // by an old binary on another box) — seed the sidecar from it and strip
      // it from the jobs file on the persist below.
      dirty = true;
    } else {
      // No sidecar entry and no legacy embedded state (fresh job / stripped file)
      job.state = {};
    }
    // Migrate legacy action payload → initProcessor
    const p = job.payload as Record<string, unknown>;
    if (p && p.kind === 'action' && typeof p.actionId === 'string') {
      (job as Record<string, unknown>).initProcessor = {
        actionId: p.actionId,
        ...(p.params ? { params: p.params } : {}),
        ...(p.targetAgent ? { targetAgent: p.targetAgent } : {}),
        ...(p.targetAgentModel ? { targetAgentModel: p.targetAgentModel } : {}),
        ...(typeof p.timeoutSeconds === 'number' ? { timeoutSeconds: p.timeoutSeconds } : {}),
      };
      job.payload = { kind: 'agentTurn', message: '(init processor output)' };
      job.sessionTarget = 'isolated';
      dirty = true;
    }
    // Migrate job-level targetAgent/targetAgentModel → initProcessor (older schema)
    const jobRaw = job as Record<string, unknown>;
    if (job.initProcessor && typeof jobRaw.targetAgent === 'string' && !job.initProcessor.targetAgent) {
      job.initProcessor.targetAgent = jobRaw.targetAgent as string;
      if (typeof jobRaw.targetAgentModel === 'string') {
        job.initProcessor.targetAgentModel = jobRaw.targetAgentModel;
      }
      delete jobRaw.targetAgent;
      delete jobRaw.targetAgentModel;
      dirty = true;
    }
    // v1 → v2: ensure every job carries an executor (lossless — legacy
    // sessionTarget/payload are kept and stay in sync). Idempotent: a v2 job
    // whose fields already agree is left untouched.
    if (syncExecutorFields(job)) {
      dirty = true;
    }
  }
  if (loaded.version !== 2) dirty = true;
  state.store = { version: 2, jobs: loaded.jobs ?? [] };
  if (dirty) {
    await persist(state);
  }

  if (!opts?.skipRecompute) {
    recomputeNextRuns(state);
  }
}

/**
 * Persist the cron store to disk.
 *
 * Writes two files: cron-jobs.json with `state` STRIPPED from every job
 * (definitions only — this file git-syncs), and the cron-state.json sidecar
 * with the runtime state map (machine-local). States for job ids no longer in
 * the store are dropped, so the sidecar cannot grow without bound.
 *
 * Safety net: if we're about to write an empty store but the file on disk
 * has jobs, create a .backup copy first. This protects against accidental
 * mass-deletion (e.g., a test suite sweeping all jobs via REST API).
 */
export async function persist(state: CronServiceState): Promise<void> {
  if (!state.store) return;

  // Before overwriting with 0 jobs, check if the on-disk file has jobs
  if (state.store.jobs.length === 0) {
    try {
      const onDisk = await readJsonFile<CronStoreFile>(state.deps.storePath, emptyStore());
      if (onDisk.jobs && onDisk.jobs.length > 0) {
        const backupPath = state.deps.storePath.replace(/\.json$/, '.backup.json');
        await fs.copyFile(state.deps.storePath, backupPath);
        state.deps.log.warn('cron store going from non-empty to empty — backup saved', {
          previousJobCount: onDisk.jobs.length,
          backupPath,
        });
      }
    } catch {
      // Best-effort backup — don't let it block the persist
    }
  }

  const states: Record<string, CronJobState> = {};
  const jobsWithoutState = state.store.jobs.map((job) => {
    states[job.id] = job.state ?? {};
    const { state: _state, ...definition } = job;
    return definition;
  });

  await writeJsonFile(state.deps.storePath, { ...state.store, jobs: jobsWithoutState });
  const stateFile: CronStateFile = { version: 1, states };
  await writeJsonFile(cronStatePath(state.deps.storePath), stateFile);
}

export function warnIfDisabled(state: CronServiceState, action: string): void {
  if (state.deps.cronEnabled) return;
  if (state.warnedDisabled) return;
  state.warnedDisabled = true;
  state.deps.log.warn('cron scheduler disabled; jobs will not run automatically', {
    enabled: false,
    action,
    storePath: state.deps.storePath,
  });
}
