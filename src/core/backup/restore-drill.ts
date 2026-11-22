/**
 * The restore drill: prove that a backup restores, without touching anything live.
 *
 * It restores one backup (the newest of the kind backups are made in, or a chosen one)
 * into a new folder under the OS temp dir, never the data home, then checks it
 * (restore-drill-checks.ts): the restored tree against the backup's own list, every
 * database through integrity_check, the data-location manifest's must-have list
 * against the backup, a task and a note read back; and it lists what backups leave out
 * by design. The folder is removed at the end, also on failure; one a killed drill left
 * is removed by the next drill.
 *
 * Read-only on both sides: the destination is wrapped so a write throws, the data home
 * is only walked. The caller keeps the result (writeDrillRecord) and holds the backup
 * lock (runRestoreDrillLocked); the drill itself writes nothing there.
 *
 * Starting a server on the restored folder is not part of it: no boot mode exists with
 * plugins, the session daemon, schedules and outward sends all off (the ephemeral
 * server pauses schedules but loads plugins and starts its own daemon), so the drill
 * reads a task and a note straight from the restored stores instead and says so.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../../logging/index.js';
import { pidAlive } from '../self-update/install-lock.js';
import { machineIdPath, withBackupLock } from './local-state.js';
import { atomicWriteSameDir } from '../bounded-memory-backup.js';
import { describeDestination, makeStore } from './destination.js';
import { readRecoveryKey } from './recovery-key.js';
import { parseRecoveryKey } from './repo/crypto.js';
import { snapshotKey, type Snapshot, type TreeEntry } from './repo/format.js';
import { PackCache, Repository } from './repo/repository.js';
import { loadLiveIndex } from './repo/backup-run.js';
import { restoreRepoSnapshot } from './repo/restore.js';
import { repoStore, resolveEncrypted } from './repo-mode.js';
import type { BackupStore } from './stores/types.js';
import type { BackupConfig } from './types.js';
import {
  checkDatabases, checkMustHave, checkRestoredFiles, defaultOutsideRoots, notInBackups, readBackNote,
  type DatabaseReport, type DrillCheck, type NotInBackupEntry,
} from './restore-drill-checks.js';

export type { DrillCheck, NotInBackupEntry, DatabaseReport } from './restore-drill-checks.js';

export interface DrillResult {
  version: 1;
  /** When the drill started. */
  at: string;
  durationMs: number;
  ok: boolean;
  destination: string;
  snapshot?: { id: string; createdAt: string; hostname: string; fileCount: number; totalBytes: number; encrypted: boolean };
  checks: DrillCheck[];
  notInBackups: NotInBackupEntry[];
  databases: DatabaseReport[];
  /** Why the drill could not run at all (no backup, no key, an unreachable destination). */
  error?: string;
  /** Folders of earlier drills that were killed, removed before this one. */
  removedLeftovers?: number;
}

export interface DrillOptions {
  cfg: BackupConfig;
  dataDir: string;
  /** The destination's root store (tests); default: the one config names. */
  store?: BackupStore;
  /** A backup id from `backup list`; default: the newest of the kind backups are made in. */
  snapshotId?: string;
  recoveryKey?: string;
  /** Where the drill's folder goes; default the OS temp dir. Never inside the data home. */
  tmpRoot?: string;
  /** Outside roots to look for leader-data in (defaultOutsideRoots). */
  outsideRoots?: Partial<Record<string, string>>;
  /** How long before the backup a file must exist to be required in it (default MUST_HAVE_SLACK_MS). */
  mustHaveSlackMs?: number;
  /** Tests: the drill's folder was made (the kill test stops the process here). */
  onFolder?: (dir: string) => void | Promise<void>;
  /** Tests: the free bytes where the drill's folder goes; default: what the file system says. */
  freeBytes?: (dir: string) => Promise<number | null>;
}

/** Kept free beside the restored copy: the drill must never be what fills the disk. */
export const DRILL_FREE_RESERVE_BYTES = 10 * 1024 ** 3;

/** Free bytes a non-root user can use where `dir` is; null when the file system does not say. */
async function freeBytesAt(dir: string): Promise<number | null> {
  try {
    const st = await fs.statfs(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    return Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export const DRILL_DIR_PREFIX = 'walnut-restore-drill-';
const DRILL_DIR_RE = /^walnut-restore-drill-[A-Za-z0-9]{6}$/;
const OWNER_FILE = 'drill-owner.json';
/** A drill folder with no owner file this old was left by a drill killed while making it. */
const UNOWNED_STALE_MS = 10 * 60_000;
/** No drill takes a day: a folder older than that goes whatever its owner file says (a reused pid). */
const MAX_AGE_MS = 24 * 3_600_000;

const BOOT_NOT_RUN =
  'Not run: Walnut has no boot mode with plugins, the session daemon, schedules and outward sends all off ' +
  '(the ephemeral server pauses schedules but loads plugins and starts its own session daemon; plugin safe mode ' +
  'turns off only plugins that are not built in; a replica needs a leader to follow). ' +
  'The drill reads a task and a note straight from the restored stores instead (read-back).';

/** A store that refuses every write: the drill only reads the destination. */
export function readOnlyStore(store: BackupStore): BackupStore {
  const refuse = (key: string) => Promise.reject(new Error(`The restore drill never writes to the backup destination (refused: ${key}).`));
  return { kind: store.kind, describe: () => store.describe(), get: (k) => store.get(k), list: (p) => store.list(p), put: (k) => refuse(k), delete: (k) => refuse(k) };
}

/** Remove the folders of drills that were killed (their owner is gone, or they are a day old). */
export async function removeLeftoverDrills(tmpRoot: string, now = Date.now()): Promise<number> {
  let names: string[];
  try { names = await fs.readdir(tmpRoot); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!DRILL_DIR_RE.test(name)) continue;
    const dir = path.join(tmpRoot, name);
    const st = await fs.lstat(dir).catch(() => null);
    if (!st?.isDirectory() || st.isSymbolicLink()) continue;
    let ownerPid: number | null = null;
    try { ownerPid = (JSON.parse(await fs.readFile(path.join(dir, OWNER_FILE), 'utf8')) as { pid?: number }).pid ?? null; } catch { /* none */ }
    const age = now - st.mtimeMs;
    const gone = ownerPid === null ? age > UNOWNED_STALE_MS : ownerPid !== process.pid && !pidAlive(ownerPid);
    if (!gone && age <= MAX_AGE_MS) continue;
    await fs.rm(dir, { recursive: true, force: true }).then(() => { removed++; }, () => {});
  }
  return removed;
}

async function real(p: string): Promise<string> {
  return fs.realpath(p).catch(() => path.resolve(p));
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

interface Picked { repo: Repository; store: BackupStore; snapshot: Snapshot; encrypted: boolean; raw: Buffer | null }

/** This machine's backup writer id, read only (localWriter would make one). */
async function machineWriterId(dataDir: string): Promise<string | null> {
  return (await fs.readFile(machineIdPath(dataDir), 'utf8').catch(() => '')).trim() || null;
}

/** The repository holding the backup to drill, and that backup. */
async function pick(base: BackupStore, opts: DrillOptions): Promise<Picked> {
  let encrypted: boolean;
  if (opts.snapshotId) {
    // An id is in one kind's repository (repo-mode.ts): the unencrypted one when it lists it.
    const plain = await repoStore(base, false).list('snapshots/');
    encrypted = !plain.some((o) => o.key === snapshotKey(opts.snapshotId!));
  } else {
    encrypted = await resolveEncrypted(opts.cfg, base);
  }
  const store = repoStore(base, encrypted);
  let raw: Buffer | null = null;
  if (encrypted) {
    const key = opts.recoveryKey ?? await readRecoveryKey(opts.dataDir);
    if (!key) throw new Error('These backups are encrypted and this machine has no recovery key for them.');
    raw = parseRecoveryKey(key);
  }
  const repo = await Repository.open(store, raw);
  let snapshot: Snapshot;
  if (opts.snapshotId) {
    snapshot = await repo.readSnapshot(snapshotKey(opts.snapshotId));
  } else {
    const { snapshots } = await repo.listSnapshots();
    if (snapshots.length === 0) throw new Error(`No backups at ${base.describe()} yet.`);
    snapshot = snapshots[0];
  }
  return { repo, store, snapshot, encrypted, raw };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runRestoreDrill(opts: DrillOptions): Promise<DrillResult> {
  const started = Date.now();
  const tmpRoot = path.resolve(opts.tmpRoot ?? os.tmpdir());
  const result: DrillResult = {
    version: 1, at: new Date(started).toISOString(), durationMs: 0, ok: false,
    destination: opts.cfg.destination ? describeDestination(opts.cfg.destination) : '', checks: [], notInBackups: [], databases: [],
  };
  const finish = (): DrillResult => {
    result.durationMs = Date.now() - started;
    result.ok = !result.error && result.checks.length > 0 && result.checks.every((c) => c.ok !== false);
    log.session.info('backup: restore drill finished', {
      ok: result.ok, snapshot: result.snapshot?.id, durationMs: result.durationMs, error: result.error,
      failed: result.checks.filter((c) => c.ok === false).map((c) => c.id),
    });
    return result;
  };

  result.notInBackups = await notInBackups(opts.dataDir, opts.outsideRoots ?? defaultOutsideRoots()).catch(() => []);
  const removed = await removeLeftoverDrills(tmpRoot);
  if (removed) result.removedLeftovers = removed;

  if (!opts.cfg.destination?.type) {
    result.error = 'The restore drill works on backups made to a service (Settings, Backup); the older S3 copy has no drill.';
    return finish();
  }
  const home = await real(opts.dataDir);
  if (inside(await real(tmpRoot), home)) {
    result.error = `The drill's folder would be inside the data home (${tmpRoot}); it must be somewhere else.`;
    return finish();
  }

  let picked: Picked;
  try {
    const base = readOnlyStore(opts.store ?? await makeStore(opts.cfg.destination, opts.dataDir));
    picked = await pick(base, opts);
  } catch (err) {
    result.error = message(err);
    return finish();
  }
  const { repo, store, snapshot, encrypted, raw } = picked;
  result.snapshot = { id: snapshot.id, createdAt: snapshot.createdAt, hostname: snapshot.hostname, fileCount: snapshot.fileCount, totalBytes: snapshot.totalBytes, encrypted };

  await fs.mkdir(tmpRoot, { recursive: true });
  // The restored copy is as large as the backup: refuse before a byte is fetched when it would
  // not fit with room to spare. A file system that does not say how much is free is refused too.
  const free = await (opts.freeBytes ?? freeBytesAt)(tmpRoot);
  const needed = snapshot.totalBytes + DRILL_FREE_RESERVE_BYTES;
  if (free === null || free < needed) {
    result.error = free === null
      ? `The free disk space at ${tmpRoot} could not be read, so the drill did not restore ${gb(snapshot.totalBytes)} there.`
      : `Not enough free disk space for the drill: the backup is ${gb(snapshot.totalBytes)} and ${gb(DRILL_FREE_RESERVE_BYTES)} must stay free, but ${tmpRoot} has ${gb(free)}.`;
    return finish();
  }
  const dir = await fs.mkdtemp(path.join(tmpRoot, DRILL_DIR_PREFIX));
  try {
    await fs.chmod(dir, 0o700);
    await fs.writeFile(path.join(dir, OWNER_FILE), JSON.stringify({ pid: process.pid, at: result.at }));
    await opts.onFolder?.(dir);
    const target = path.join(dir, 'home');

    let tree: TreeEntry[];
    try {
      const { index } = await loadLiveIndex(repo);
      tree = await repo.readTree(snapshot, index, new PackCache(store, 2));
      const r = await restoreRepoSnapshot(store, raw, target, { snapshotId: snapshot.id });
      result.checks.push({ id: 'restore', ok: true, detail: `${r.restoredFiles} files, ${r.restoredBytes} bytes restored into a temporary folder; every chunk checked as it was read` });
    } catch (err) {
      result.checks.push({ id: 'restore', ok: false, detail: 'The backup did not restore', problems: [message(err)] });
      return finish();
    }

    result.checks.push(await checkRestoredFiles(target, tree, repo, snapshot));
    const db = await checkDatabases(target, tree);
    result.checks.push(db.check);
    result.databases = db.databases;
    // Backups another computer writes hold that computer's data home, not this one: nothing here to compare.
    if (repo.config.writer?.id !== await machineWriterId(opts.dataDir)) {
      result.checks.push({ id: 'must-have', ok: null, detail: `Not compared: these backups are written by another computer (${repo.writerName()}), so this data home is not what they hold` });
    } else {
      result.checks.push(await checkMustHave(opts.dataDir, tree, snapshot.createdAt, opts.mustHaveSlackMs));
    }

    const note = await readBackNote(target, tree);
    const readBack: string[] = [];
    const problems: string[] = [];
    if (db.task) readBack.push(`task "${db.task.title}" (${db.task.id})`);
    else if (db.taskError) problems.push(`tasks/tasks.sqlite: reading a task failed: ${db.taskError}`);
    else if (db.databases.some((d) => d.path === 'tasks/tasks.sqlite')) problems.push('tasks/tasks.sqlite holds no task to read');
    if (note && 'path' in note) readBack.push(`note ${note.path}`);
    else if (note) problems.push(note.error);
    result.checks.push({
      id: 'read-back',
      ok: problems.length ? false : readBack.length ? true : null,
      detail: readBack.length ? `Read back ${readBack.join(' and ')}` : problems.length ? 'Could not read back' : 'The backup holds no task database and no note to read back',
      ...(problems.length ? { problems } : {}),
    });
    result.checks.push({ id: 'boot', ok: null, detail: BOOT_NOT_RUN });
    return finish();
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch((err) => {
      log.session.warn('backup: restore drill folder not removed (the next drill removes it)', { dir, error: message(err) });
    });
  }
}

/**
 * The drill as the CLI and the schedule run it: holding this data home's backup lock
 * (local/backup/run.lock, a machine file no backup takes), as a restore does, so a
 * backup's prune never deletes packs while the drill reads them. Throws
 * BackupLockedError while a backup or restore of another process runs.
 */
export function runRestoreDrillLocked(opts: DrillOptions): Promise<DrillResult> {
  return withBackupLock(opts.dataDir, () => runRestoreDrill(opts));
}

// ── The record Settings and the schedule read ───────────────────────────────

/** This machine's last drill result (the home manifest's local.restore-drill). */
export const drillRecordPath = (dataDir: string): string => path.join(dataDir, 'local', 'restore-drill.json');

export async function writeDrillRecord(dataDir: string, result: DrillResult): Promise<void> {
  const file = drillRecordPath(dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteSameDir(file, JSON.stringify(result, null, 2));
}

export async function readDrillRecord(dataDir: string): Promise<DrillResult | null> {
  try {
    const r = JSON.parse(await fs.readFile(drillRecordPath(dataDir), 'utf8')) as DrillResult;
    return r && r.version === 1 && typeof r.at === 'string' ? r : null;
  } catch {
    return null;
  }
}
