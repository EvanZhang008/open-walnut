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
import type { CronJob, CronStoreFile, CronStateFile, CronJobState, CronServiceState } from './types.js';
import { jsonFileText, readJsonFile, writeJsonText } from '../../utils/fs.js';
import { noteStoreWrite } from '../replication/store-writes.js';
import { isHostReplicaProgram } from '../server-role.js';
import { NeedsLeaderError } from '../replication/needs-leader.js';
import { recomputeNextRuns } from './jobs.js';
import { syncExecutorFields } from './executor-compat.js';
import { createTriggerLabel } from '../routines/trigger-label.js';
import { promptOf } from '../routines/trigger-push.js';

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

/**
 * A forced reload reads the files again at least this often even when their stamp held: one more
 * net under a change the stamp could miss (a writer outside the lock in the instant after our own
 * write, with the very size we wrote). Such a write could be lost as before this cache, when an
 * op wrote over it between its read and its write.
 */
export const CRON_REREAD_MAX_MS = 30_000;

/** One file's identity and version: inode, size, mtime, ctime; 'none' when it is missing. */
async function fileStamp(p: string): Promise<string> {
  try {
    const s = await fs.stat(p);
    return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    return `error:${Math.random()}`; // never matches: read the file
  }
}

/** Both files' stamps, the jobs file's first. */
export async function diskStampOf(state: CronServiceState): Promise<string> {
  const [jobs, sidecar] = await Promise.all([fileStamp(state.deps.storePath), fileStamp(cronStatePath(state.deps.storePath))]);
  return `${jobs}|${sidecar}`;
}

/** The next forced reload reads the files (an op threw: memory may hold a change never written). */
export function forgetDiskStamp(state: CronServiceState): void {
  state.disk = undefined;
  // The op that threw may have half-changed `store`: the routine records waiting with it go too
  // (at most ROUTINE_WRITE_DELAY_MS of check lines), as the reload below drops the rest.
  state.routineWriteDue = false;
}

/**
 * Load the store, or with `forceReload` load it again under the lock.
 *
 * A forced reload keeps the store in memory when both files still carry the stamp they had when
 * this process last read or wrote them (2026-11-21, the live server: every op forced a reload, so
 * the two files were read and parsed about 5 times a second, 6.5 GB of JSON text in 10 minutes,
 * the largest source of the server's garbage). Any other writer (a second process, git-sync, the
 * routines copy) changes the stamp, so the reload reads what it wrote, as before.
 */
export async function ensureLoaded(
  state: CronServiceState,
  opts?: { forceReload?: boolean; skipRecompute?: boolean },
): Promise<void> {
  if (state.store && !opts?.forceReload) return;
  if (state.store && state.disk && Date.now() - state.disk.readAt < CRON_REREAD_MAX_MS
    && await diskStampOf(state) === state.disk.stamp) {
    state.keptAt = Date.now();
    if (!opts?.skipRecompute) recomputeNextRuns(state);
    return;
  }
  // About to read the files: what routine checks left in `store` is written first, unless another
  // writer changed a file since (its write wins, as it did over our store before; a few seconds of
  // check lines are lost, never a fire or a count).
  if (state.store && state.routineWriteDue) {
    if (state.disk && await diskStampOf(state) === state.disk.stamp) await persist(state);
    else state.routineWriteDue = false;
  }

  // Taken before the read: a write after it changes the stamp, so the next reload reads again.
  const stamp = await diskStampOf(state);
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
    // A trigger named with its prompt's opening before labels gets its label (trigger-label.ts).
    // A host replica keeps the Mac's rows: the copy round brings the Mac's relabel.
    if (!isHostReplicaProgram() && relabelTrigger(job)) {
      dirty = true;
    }
  }
  if (loaded.version !== 2) dirty = true;
  state.store = { version: 2, jobs: loaded.jobs ?? [] };
  state.keptAt = Date.now();
  if (dirty) {
    state.disk = { stamp, readAt: Date.now() };
    await persist(state);
  } else {
    // The texts this store writes as: a persist that changes nothing in a file leaves it as it is
    // (2026-11-22: without them, the first write after each 30 s reread rewrote cron-jobs.json).
    state.disk = { stamp, readAt: Date.now(), ...storeTexts(state.store) };
  }

  if (!opts?.skipRecompute) {
    recomputeNextRuns(state);
  }
}

const triggerLabels = createTriggerLabel();

/**
 * Give a trigger whose name is its prompt's opening a short label instead
 * (2026-11-06: "The session-cookie-watch check fired. Never print cookie..."
 * read as news on a task's waiting line). True when it changed the job.
 * Idempotent: a label is never the prompt's opening, so a second load keeps it.
 */
export function relabelTrigger(job: CronJob): boolean {
  if (!job.check || typeof job.name !== 'string') return false;
  const prompt = promptOf(job);
  if (!triggerLabels.isFromPrompt(job.name, prompt)) return false;
  const label = triggerLabels.label({ name: job.name, description: job.description, prompt, run: job.check.run });
  if (label === job.name) return false;
  job.name = label;
  return true;
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
  // On a host replica cron-jobs.json and cron-state.json are the Mac's routines
  // copy (replication/kinds/routines-follower.ts): only the copy round writes
  // them. The engine there is registered but never started, and a list that
  // recomputed a next run would rewrite the copy away from the Mac's rows.
  if (isHostReplicaProgram()) throw new NeedsLeaderError('routine_writes_need_mac');
  if (!state.store) return;
  // This write carries what routine checks left waiting (trigger-apply.ts persistRoutineCheck).
  state.routineWriteDue = false;

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

  // The one write point, so no path (a create, an edit, a replay, one added later) stores a prompt's opening as a name.
  for (const job of state.store.jobs) relabelTrigger(job);
  const { jobsText, stateText } = storeTexts(state.store);
  // A file whose text is what this process last read or wrote, and that nobody wrote since, is
  // left as it is: most writes change only the runtime state, and the jobs file rides git-sync.
  const prior = state.disk && await diskStampOf(state) === state.disk.stamp ? state.disk : undefined;
  const writeJobs = prior?.jobsText !== jobsText;
  const writeState = prior?.stateText !== stateText;
  try {
    if (writeJobs) await writeJsonText(state.deps.storePath, jobsText);
    if (writeState) await writeJsonText(cronStatePath(state.deps.storePath), stateText);
  } catch (err) {
    forgetDiskStamp(state);
    throw err;
  }
  // Stamped after the write, under the lock: the next reload keeps this store. A file written
  // here whose size is not what was just written changed again in between (a writer outside the
  // lock): no stamp, so the next reload reads it.
  const stamp = await diskStampOf(state);
  const sizes = stamp.split('|').map((one) => Number(one.split(':')[1]));
  const sizesHold = (!writeJobs || sizes[0] === Buffer.byteLength(jobsText)) && (!writeState || sizes[1] === Buffer.byteLength(stateText));
  state.disk = sizesHold ? { stamp, readAt: prior?.readAt ?? Date.now(), jobsText, stateText } : undefined;
  state.keptAt = Date.now();
  // The routines copy kind's watch (replication/store-writes.ts): this is the one write point.
  noteStoreWrite('routines');
}

/** The two files' texts for `store`: definitions only (indented, git-synced), and the runtime states. */
function storeTexts(store: CronStoreFile): { jobsText: string; stateText: string } {
  const states: Record<string, CronJobState> = {};
  const jobsWithoutState = store.jobs.map((job) => {
    states[job.id] = job.state ?? {};
    const { state: _state, ...definition } = job;
    return definition;
  });
  return {
    jobsText: jsonFileText({ ...store, jobs: jobsWithoutState }),
    // Compact: the sidecar is machine-local (never synced, never read by a person) and written on
    // every trigger check, about once a second on the Mac; indenting made it 40% larger.
    stateText: JSON.stringify({ version: 1, states } satisfies CronStateFile) + '\n',
  };
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
