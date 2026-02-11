/**
 * Store persistence — adapted from moltbot/src/cron/service/store.ts
 * Simplified: no legacy migrations since this is a fresh implementation.
 *
 * Safety: persist() creates a .backup file before writing an empty store
 * to prevent accidental data loss (e.g., a rogue DELETE sweep from tests).
 */

import fs from 'node:fs/promises';
import type { CronStoreFile, CronServiceState } from './types.js';
import { readJsonFile, writeJsonFile } from '../../utils/fs.js';
import { recomputeNextRuns } from './jobs.js';

function emptyStore(): CronStoreFile {
  return { version: 1, jobs: [] };
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
  let dirty = false;
  // Ensure every job has a state object + migrate action payloads to initProcessor
  for (const job of loaded.jobs) {
    if (!job.state || typeof job.state !== 'object') {
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
  }
  state.store = { version: 1, jobs: loaded.jobs ?? [] };
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

  await writeJsonFile(state.deps.storePath, state.store);
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
