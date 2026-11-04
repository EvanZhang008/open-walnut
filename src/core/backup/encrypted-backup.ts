/**
 * Encrypted backups as the scheduler, the routes and the CLI use them: one
 * place that turns config + the local recovery key into a run, a list of
 * backups, a restore, a connection test, or a writer move.
 */
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { makeStore, describeDestination } from './destination.js';
import { ensureRecoveryKey, readRecoveryKey } from './recovery-key.js';
import { parseRecoveryKey } from './repo/crypto.js';
import { runRepoBackup, type RepoBackupResult } from './repo/backup-run.js';
import { DEFAULT_RETENTION, pruneRepo, type PruneResult } from './repo/prune.js';
import { RepoError, Repository } from './repo/repository.js';
import { restoreRepoSnapshot, type RepoRestoreResult } from './repo/restore.js';
import { isNotFound, type BackupStore } from './stores/types.js';
import { REPO_CONFIG_KEY, type SnapshotSummary } from './repo/format.js';
import type { BackupConfig, BackupDestinationConfig } from './types.js';

export interface EncryptedRunResult extends RepoBackupResult {
  prune?: PruneResult;
  pruneError?: string;
  snapshotCount?: number;
}

function retentionOf(cfg: BackupConfig) {
  return {
    daily: Math.max(1, cfg.retention?.daily ?? DEFAULT_RETENTION.daily),
    weekly: Math.max(0, cfg.retention?.weekly ?? DEFAULT_RETENTION.weekly),
  };
}

async function keyFor(dataDir: string, override?: string): Promise<Buffer> {
  if (override) return parseRecoveryKey(override);
  const key = await readRecoveryKey(dataDir);
  if (!key) throw new RepoError('key_mismatch', 'This machine has no recovery key for these backups yet. Enter the recovery key you saved.');
  return parseRecoveryKey(key);
}

export async function runEncryptedBackup(
  cfg: BackupConfig,
  opts: { dataDir: string; onProgress?: (done: number, total: number) => void; store?: BackupStore },
): Promise<EncryptedRunResult> {
  const dest = cfg.destination!;
  const store = opts.store ?? await makeStore(dest, opts.dataDir);
  // A new key is made only for a destination with no backups yet. One that
  // holds backups needs the key that made them, typed in by the user.
  let key = await readRecoveryKey(opts.dataDir);
  if (!key) {
    if (await hasRepository(store)) {
      throw new RepoError('key_mismatch', `${store.describe()} already holds Walnut backups. Enter the recovery key you saved to use them.`);
    }
    key = (await ensureRecoveryKey(opts.dataDir)).key;
  }
  const raw = parseRecoveryKey(key);
  const result: EncryptedRunResult = await runRepoBackup(store, raw, {
    dataDir: opts.dataDir,
    hostname: os.hostname(),
    onProgress: opts.onProgress,
  });
  try {
    const repo = await Repository.open(store, raw, { hostname: os.hostname() });
    result.prune = await pruneRepo(repo, retentionOf(cfg));
    result.snapshotCount = (await repo.listSnapshotKeys()).length;
  } catch (err) {
    // The backup itself landed; a failed prune only means more history kept until next time.
    result.pruneError = err instanceof Error ? err.message : String(err);
  }
  return result;
}

async function hasRepository(store: BackupStore): Promise<boolean> {
  try {
    await store.get(REPO_CONFIG_KEY);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

export interface BackupListing {
  destination: string;
  snapshots: SnapshotSummary[];
  unreadable: number;
  writer: string;
}

export async function listEncryptedBackups(
  cfg: BackupConfig,
  opts: { dataDir: string; recoveryKey?: string; store?: BackupStore },
): Promise<BackupListing> {
  const dest = cfg.destination!;
  const store = opts.store ?? await makeStore(dest, opts.dataDir);
  const repo = await Repository.open(store, await keyFor(opts.dataDir, opts.recoveryKey), { hostname: os.hostname() });
  const { snapshots, unreadable } = await repo.listSnapshots();
  return {
    destination: describeDestination(dest),
    snapshots: snapshots.map(({ tree: _tree, ...rest }) => rest),
    unreadable: unreadable.length,
    writer: repo.config.writer.hostname,
  };
}

export async function restoreEncryptedBackup(
  cfg: BackupConfig,
  opts: {
    dataDir: string;
    snapshotId: string;
    targetDir: string;
    recoveryKey?: string;
    store?: BackupStore;
    onProgress?: (doneBytes: number, totalBytes: number, doneFiles: number, totalFiles: number) => void;
  },
): Promise<RepoRestoreResult> {
  const store = opts.store ?? await makeStore(cfg.destination!, opts.dataDir);
  return restoreRepoSnapshot(store, await keyFor(opts.dataDir, opts.recoveryKey), opts.targetDir, {
    snapshotId: opts.snapshotId,
    onProgress: opts.onProgress,
  });
}

/** Make this machine the one that writes backups to this destination. */
export async function adoptEncryptedBackups(cfg: BackupConfig, opts: { dataDir: string; store?: BackupStore }): Promise<void> {
  const store = opts.store ?? await makeStore(cfg.destination!, opts.dataDir);
  const repo = await Repository.open(store, await keyFor(opts.dataDir), { hostname: os.hostname() });
  await repo.setWriter(os.hostname());
}

export interface DestinationTestResult {
  ok: boolean;
  destination: string;
  /** Write, read back and delete of a small probe object all worked. */
  canWrite?: boolean;
  /** The destination already holds Walnut backups. */
  hasBackups?: boolean;
  /** This machine's recovery key opens them (false: another key made them). */
  keyMatches?: boolean;
  /** This machine has a recovery key at all. */
  hasKey?: boolean;
  writer?: string;
  error?: string;
}

/** Real round trip against the destination, no backup written. */
export async function testDestination(
  dest: BackupDestinationConfig,
  opts: { dataDir: string; store?: BackupStore },
): Promise<DestinationTestResult> {
  const destination = describeDestination(dest);
  try {
    const store = opts.store ?? await makeStore(dest, opts.dataDir);
    const probe = `probe/${randomBytes(6).toString('hex')}`;
    const body = randomBytes(32);
    await store.put(probe, body);
    const back = await store.get(probe);
    await store.delete(probe);
    if (!back.equals(body)) return { ok: false, destination, error: 'Wrote a test file but read back something else.' };
    const out: DestinationTestResult = { ok: true, destination, canWrite: true, hasBackups: false };
    const key = await readRecoveryKey(opts.dataDir);
    out.hasKey = Boolean(key);
    try {
      const raw = key ? parseRecoveryKey(key) : Buffer.alloc(32);
      const repo = await Repository.open(store, raw, { hostname: os.hostname() });
      out.hasBackups = true;
      out.keyMatches = Boolean(key);
      out.writer = repo.config.writer.hostname;
    } catch (err) {
      if (err instanceof RepoError && err.code === 'no_repo') out.hasBackups = false;
      else if (err instanceof RepoError && err.code === 'key_mismatch') { out.hasBackups = true; out.keyMatches = false; }
      else if (!isNotFound(err)) throw err;
    }
    return out;
  } catch (err) {
    return { ok: false, destination, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Check a typed key against the destination before this machine keeps it. */
export async function checkRecoveryKey(
  dest: BackupDestinationConfig,
  key: string,
  opts: { dataDir: string; store?: BackupStore },
): Promise<{ ok: boolean; snapshotCount?: number; error?: string }> {
  let raw: Buffer;
  try {
    raw = parseRecoveryKey(key);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  try {
    const store = opts.store ?? await makeStore(dest, opts.dataDir);
    const repo = await Repository.open(store, raw, { hostname: os.hostname() });
    return { ok: true, snapshotCount: (await repo.listSnapshotKeys()).length };
  } catch (err) {
    if (err instanceof RepoError && err.code === 'no_repo') return { ok: true, snapshotCount: 0 };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
