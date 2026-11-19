/**
 * Repository backups (encrypted or not, repo-mode.ts) as the scheduler, the routes
 * and the CLI use them: one place that turns config (+ the local recovery key when
 * encryption is on) into a run, a list of backups, a restore, a connection test, or
 * a writer move. The name stays from when every repository was encrypted.
 */
import { log } from '../../logging/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeStore, describeDestination } from './destination.js';
import { ensureRecoveryKey, readRecoveryKey } from './recovery-key.js';
import { localWriter, withBackupLock } from './local-state.js';
import { friendlyStoreError } from './errors.js';
import { parseRecoveryKey } from './repo/crypto.js';
import { runRepoBackup, type RepoBackupResult } from './repo/backup-run.js';
import { DEFAULT_RETENTION, pruneRepo, type PruneResult } from './repo/prune.js';
import { RepoError, Repository, holdsBackupData } from './repo/repository.js';
import { restoreRepoSnapshot, type RepoRestoreResult } from './repo/restore.js';
import { isNotFound, type BackupStore } from './stores/types.js';
import { REPO_CONFIG_KEY, snapshotKey, type SnapshotSummary } from './repo/format.js';
import { repoStore, resolveEncrypted } from './repo-mode.js';
import type { BackupConfig, BackupDestinationConfig } from './types.js';

export interface EncryptedRunResult extends RepoBackupResult {
  /** The kind this run made (repo-mode.ts resolveEncrypted). */
  encrypted: boolean;
  prune?: PruneResult;
  pruneError?: string;
  snapshotCount?: number;
}

function retentionOf(cfg: BackupConfig) {
  return {
    daily: Math.max(1, cfg.retention?.daily ?? DEFAULT_RETENTION.daily),
    weekly: Math.max(0, cfg.retention?.weekly ?? DEFAULT_RETENTION.weekly),
    recent: Math.max(1, DEFAULT_RETENTION.recent ?? 1),
    withinHours: DEFAULT_RETENTION.withinHours,
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
  const base = opts.store ?? await makeStore(dest, opts.dataDir);
  return withBackupLock(opts.dataDir, async () => {
    const encrypted = await resolveEncrypted(cfg, base);
    const store = repoStore(base, encrypted);
    let raw: Buffer | null = null;
    if (encrypted) {
      // A new key is made only for a destination with no backups yet. One that
      // holds backups needs the key that made them, typed in by the user.
      let key = await readRecoveryKey(opts.dataDir);
      if (!key) {
        if (await hasRepository(store)) {
          throw new RepoError('key_mismatch', `${store.describe()} already holds Walnut backups. Enter the recovery key you saved to use them.`);
        }
        key = (await ensureRecoveryKey(opts.dataDir)).key;
      }
      raw = parseRecoveryKey(key);
    }
    const writer = await localWriter(opts.dataDir);
    const result: EncryptedRunResult = {
      ...await runRepoBackup(store, raw, { dataDir: opts.dataDir, writer, onProgress: opts.onProgress }),
      encrypted,
    };
    try {
      const repo = await Repository.open(store, raw);
      result.prune = await pruneRepo(repo, retentionOf(cfg), { writer, mustKeep: result.snapshotId });
      if (result.prune.skipped) result.pruneError = result.prune.skipped;
      result.snapshotCount = (await repo.listSnapshotKeys()).length;
    } catch (err) {
      // The backup itself landed; a failed prune only means more history kept until next time.
      result.pruneError = err instanceof Error ? err.message : String(err);
    }
    return result;
  });
}

/** Backups (not only an empty repository's config) are kept here: what "encrypted backups are here too" says. */
async function hasSnapshots(store: BackupStore): Promise<boolean> {
  return (await store.list('snapshots/')).length > 0;
}

async function hasRepository(store: BackupStore): Promise<boolean> {
  try {
    await store.get(REPO_CONFIG_KEY);
    return true;
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // No config read back, but backup data there: treat it as backups (never a new key for them).
    return holdsBackupData(store);
  }
}

export interface BackupListing {
  destination: string;
  /** Newest first: this kind's backups, then the other kind's still kept at the destination. */
  snapshots: Array<SnapshotSummary & { encrypted: boolean }>;
  /** The kind new backups are made in (Settings, "Encrypt backups"). */
  encrypted: boolean;
  /** Encrypted backups are there that this machine cannot open (no key, or another one). */
  lockedEncrypted?: boolean;
  unreadable: number;
  writer: string;
  /** This machine is the one that writes them. */
  thisWriter: boolean;
}

export async function listEncryptedBackups(
  cfg: BackupConfig,
  opts: { dataDir: string; recoveryKey?: string; store?: BackupStore },
): Promise<BackupListing> {
  const dest = cfg.destination!;
  const base = opts.store ?? await makeStore(dest, opts.dataDir);
  const encrypted = await resolveEncrypted(cfg, base);
  const me = await localWriter(opts.dataDir);
  // This kind first: it is the one written to, and its errors are the ones to say.
  const mine = await openKind(base, encrypted, opts, { required: true });
  const other = await openKind(base, !encrypted, opts, { required: false });
  const snapshots: BackupListing['snapshots'] = [];
  let unreadable = 0;
  for (const repo of [mine.repo, other.repo]) {
    if (!repo) continue;
    const listed = await repo.listSnapshots();
    unreadable += listed.unreadable.length;
    for (const { tree: _tree, ...rest } of listed.snapshots) snapshots.push({ ...rest, encrypted: !repo.plain });
  }
  snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Who writes this kind: no repository of it yet means this machine starts it.
  const shown = mine.repo;
  return {
    destination: describeDestination(dest),
    snapshots,
    encrypted,
    ...(mine.locked || other.locked ? { lockedEncrypted: true } : {}),
    unreadable,
    writer: shown?.writerName() ?? '',
    thisWriter: shown ? shown.isWriter(me) : true,
  };
}

/**
 * The repository of one kind at `base`. `required`: its errors are thrown (no
 * repository there yet included); otherwise a missing or locked one is null.
 */
async function openKind(
  base: BackupStore,
  encrypted: boolean,
  opts: { dataDir: string; recoveryKey?: string },
  { required }: { required: boolean },
): Promise<{ repo: Repository | null; locked?: boolean }> {
  const store = repoStore(base, encrypted);
  try {
    return { repo: await Repository.open(store, encrypted ? await keyFor(opts.dataDir, opts.recoveryKey) : null) };
  } catch (err) {
    if (required) {
      // No backups of this kind yet: the other kind's are still listed.
      if (err instanceof RepoError && err.code === 'no_repo') return { repo: null };
      throw err;
    }
    if (err instanceof RepoError && err.code === 'no_repo') return { repo: null };
    if (err instanceof RepoError && err.code === 'key_mismatch') return { repo: null, locked: await hasSnapshots(store) };
    if (err instanceof RepoError) return { repo: null };
    throw err;
  }
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
  const base = opts.store ?? await makeStore(cfg.destination!, opts.dataDir);
  // The kind that holds the backup: 'latest' is this kind's newest when it has one.
  const encrypted = await kindHolding(base, opts.snapshotId);
  const store = repoStore(base, encrypted);
  const raw = encrypted ? await keyFor(opts.dataDir, opts.recoveryKey) : null;
  const run = () => restoreRepoSnapshot(store, raw, opts.targetDir, {
    snapshotId: opts.snapshotId,
    onProgress: opts.onProgress,
  });
  // Held so a prune from another process cannot delete packs mid-restore. Not
  // on a machine with no data home yet (a terminal restore into ~/.open-walnut
  // itself): the lock file would make the target non-empty.
  const home = path.resolve(opts.dataDir);
  const target = path.resolve(opts.targetDir);
  const homeExists = await fs.stat(home).then(() => true, () => false);
  if (!homeExists || target === home || target.startsWith(home + path.sep)) return run();
  return withBackupLock(opts.dataDir, run);
}

/**
 * Which kind of repository at `base` holds `snapshotId`; 'latest' is the newest of both
 * (snapshot ids sort by time). An id in neither: the encrypted one, which then says so.
 */
async function kindHolding(base: BackupStore, snapshotId: string): Promise<boolean> {
  const ids = async (encrypted: boolean) => (await repoStore(base, encrypted).list('snapshots/')).map((o) => o.key).sort();
  const [enc, plain] = await Promise.all([ids(true), ids(false)]);
  if (snapshotId !== 'latest') return !plain.includes(snapshotKey(snapshotId));
  const newest = (keys: string[]) => keys[keys.length - 1] ?? '';
  return newest(enc) >= newest(plain) && enc.length > 0;
}

/** Make this machine the one that writes backups to this destination. */
export async function adoptEncryptedBackups(cfg: BackupConfig, opts: { dataDir: string; store?: BackupStore }): Promise<void> {
  const base = opts.store ?? await makeStore(cfg.destination!, opts.dataDir);
  const encrypted = await resolveEncrypted(cfg, base);
  const store = repoStore(base, encrypted);
  const raw = encrypted ? await keyFor(opts.dataDir) : null;
  await withBackupLock(opts.dataDir, async () => {
    const repo = await Repository.open(store, raw);
    await repo.setWriter(await localWriter(opts.dataDir));
  });
}

export interface DestinationTestResult {
  ok: boolean;
  destination: string;
  /** Write, read back and delete of a small probe object all worked. */
  canWrite?: boolean;
  /** The kind backups are made in here: as asked, or (not given) as the destination already holds. */
  encrypted?: boolean;
  /** The destination already holds Walnut backups of the kind backups are made in. */
  hasBackups?: boolean;
  /** Unencrypted backups: whether encrypted ones are there too (kept, restorable with their key). */
  hasEncryptedBackups?: boolean;
  /** This machine's recovery key opens them (false: another key made them). */
  keyMatches?: boolean;
  /** This machine has a recovery key at all. */
  hasKey?: boolean;
  writer?: string;
  /** This machine is the one that writes them. */
  thisWriter?: boolean;
  error?: string;
}

/**
 * Real round trip against the destination, no backup written. `encrypted`: the kind backups
 * are made in; undefined, encrypted when encrypted backups are already there (resolveEncrypted).
 */
export async function testDestination(
  dest: BackupDestinationConfig,
  opts: { dataDir: string; encrypted?: boolean; store?: BackupStore },
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
    const encrypted = opts.encrypted ?? await resolveEncrypted(undefined, store);
    const out: DestinationTestResult = { ok: true, destination, canWrite: true, hasBackups: false, encrypted };
    if (!encrypted) {
      // No key to match: only whether backups of this kind are there, and who writes them.
      try {
        const repo = await Repository.open(repoStore(store, false), null);
        out.hasBackups = true;
        out.keyMatches = true;
        out.writer = repo.writerName();
        out.thisWriter = repo.isWriter(await localWriter(opts.dataDir));
      } catch (err) {
        if (!(err instanceof RepoError && err.code === 'no_repo')) throw err;
      }
      if (await hasSnapshots(store)) out.hasEncryptedBackups = true;
      return out;
    }
    const key = await readRecoveryKey(opts.dataDir);
    out.hasKey = Boolean(key);
    try {
      const raw = key ? parseRecoveryKey(key) : Buffer.alloc(32);
      const repo = await Repository.open(store, raw);
      out.hasBackups = true;
      out.keyMatches = Boolean(key);
      out.writer = repo.writerName();
      out.thisWriter = repo.isWriter(await localWriter(opts.dataDir));
    } catch (err) {
      if (err instanceof RepoError && err.code === 'no_repo') out.hasBackups = false;
      else if (err instanceof RepoError && err.code === 'key_mismatch') { out.hasBackups = true; out.keyMatches = false; }
      else if (!isNotFound(err)) throw err;
    }
    return out;
  } catch (err) {
    // The person reads plain words; the service's own code and message stay in the log.
    log.session.warn('backup: destination test failed', {
      error: err instanceof Error ? err.message : String(err),
      code: (err as { name?: string; Code?: string } | undefined)?.Code ?? (err as { name?: string } | undefined)?.name,
    });
    return { ok: false, destination, error: friendlyStoreError(err, dest) };
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
    const repo = await Repository.open(store, raw);
    return { ok: true, snapshotCount: (await repo.listSnapshotKeys()).length };
  } catch (err) {
    if (err instanceof RepoError && err.code === 'no_repo') return { ok: true, snapshotCount: 0 };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
