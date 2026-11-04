/**
 * What only this machine knows about its encrypted backups, kept beside the
 * recovery key in `<data home>/local/backup/`:
 *
 *   machine-id   a random id naming this machine as the repository's writer.
 *                Not the hostname: a Mac's hostname changes with the network
 *                (".local", "-2"), and two machines may share one. It never
 *                rides a backup (scan.ts), so a home restored on another
 *                machine is a new writer until the user moves the role.
 *   run.lock     one backup, prune or restore at a time across processes on
 *                this data home (the server and an `open-walnut backup` in a
 *                terminal), so one never deletes packs the other just used.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pidAlive, processStart } from '../self-update/install-lock.js';

export interface WriterIdentity {
  /** Random, stable for this data home on this machine. */
  id: string;
  /** What the user reads ("Evans-MacBook-Pro"); stored sealed in the repository. */
  name: string;
}

const backupDir = (dataDir: string): string => path.join(dataDir, 'local', 'backup');
export const machineIdPath = (dataDir: string): string => path.join(backupDir(dataDir), 'machine-id');
export const runLockPath = (dataDir: string): string => path.join(backupDir(dataDir), 'run.lock');

/** Files under local/backup/ that belong to this machine and never ride a backup. */
export const MACHINE_ONLY_FILES = ['local/backup/machine-id', 'local/backup/run.lock'];

const ID_RE = /^[0-9a-f]{32}$/;

export async function localWriter(dataDir: string): Promise<WriterIdentity> {
  const file = machineIdPath(dataDir);
  const name = os.hostname().replace(/\.(local|lan|home)$/i, '');
  try {
    const id = (await fs.readFile(file, 'utf8')).trim();
    if (ID_RE.test(id)) return { id, name };
  } catch {
    /* none yet */
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const id = randomBytes(16).toString('hex');
  try {
    // wx: two processes making it at once agree on the first one written.
    await fs.writeFile(file, `${id}\n`, { mode: 0o600, flag: 'wx' });
    return { id, name };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const theirs = (await fs.readFile(file, 'utf8')).trim();
    if (ID_RE.test(theirs)) return { id: theirs, name };
    // Garbage in the file: replace it (no repository can name an id that never parsed).
    await fs.writeFile(file, `${id}\n`, { mode: 0o600 });
    return { id, name };
  }
}

export class BackupLockedError extends Error {
  constructor() {
    super('Another Walnut process on this machine is backing up or restoring. Try again when it finishes.');
    this.name = 'BackupLockedError';
  }
}

export interface LockDeps {
  alive?: (pid: number) => boolean;
  started?: (pid: number) => Promise<string>;
}

/** The owner line names a process that is gone (or a reused pid). */
async function holderGone(text: string, deps: Required<LockDeps>): Promise<boolean> {
  const [pidText, , ...startWords] = text.trim().split(/\s+/);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 1) return true;
  if (!deps.alive(pid)) return true;
  const recorded = startWords.join(' ');
  if (!recorded) return false;
  const now = await deps.started(pid);
  return Boolean(now) && now !== recorded;
}

/**
 * Run `fn` holding this data home's backup lock. A lock whose holder is alive
 * is never taken, however long it runs (a first upload takes hours); one whose
 * holder is gone is moved aside and taken, and two takers never both win: each
 * renames the lock to its own name and goes on only if what it moved is the
 * line it judged.
 */
export async function withBackupLock<T>(dataDir: string, fn: () => Promise<T>, deps: LockDeps = {}): Promise<T> {
  const d: Required<LockDeps> = { alive: deps.alive ?? pidAlive, started: deps.started ?? processStart };
  const file = runLockPath(dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(8).toString('hex');
  const line = `${process.pid} ${token} ${await d.started(process.pid)}`.trim();

  for (let attempt = 0; attempt < 3; attempt++) {
    let taken = false;
    try {
      await fs.writeFile(file, `${line}\n`, { mode: 0o600, flag: 'wx' });
      taken = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    // Outside the take's try: an EEXIST thrown by `fn` itself is its own error, not a held lock.
    if (taken) {
      try {
        return await fn();
      } finally {
        const still = await fs.readFile(file, 'utf8').catch(() => '');
        if (still.trim() === line) await fs.rm(file, { force: true });
      }
    }
    const held = await fs.readFile(file, 'utf8').catch(() => null);
    if (held === null) continue; // released in between
    if (!(await holderGone(held, d))) throw new BackupLockedError();
    const aside = `${file}.stale-${token}`;
    try {
      await fs.rename(file, aside);
    } catch {
      continue; // someone else moved it first
    }
    const moved = await fs.readFile(aside, 'utf8').catch(() => '');
    if (moved.trim() !== held.trim()) {
      // A live lock made after we judged: put it back unless another exists now.
      await fs.link(aside, file).catch(() => {});
      await fs.rm(aside, { force: true });
      throw new BackupLockedError();
    }
    await fs.rm(aside, { force: true });
  }
  throw new BackupLockedError();
}
