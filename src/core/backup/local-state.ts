/**
 * What only this machine knows about its encrypted backups, kept beside the
 * recovery key in `<data home>/local/backup/`:
 *
 *   machine-id   the id an earlier build made to name this machine as the
 *                repository's writer. Where it exists it stays the writer id
 *                (a repository already names it); where it does not, the
 *                writer is this machine's stable id (src/core/machine-id.ts,
 *                outside the data home), and nothing is written here. Not the
 *                hostname: a Mac's hostname changes with the network (".local",
 *                "-2"), and two machines may share one. Neither rides a backup
 *                (scan.ts), so a home restored on another machine is a new
 *                writer until the user moves the role.
 *   run.lock     one backup, prune or restore at a time across processes on
 *                this data home (the server and an `open-walnut backup` in a
 *                terminal), so one never deletes packs the other just used.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { pidAlive, processStart } from '../self-update/install-lock.js';
import { readMachineId } from '../machine-id.js';
import { isMachineId } from '../../providers/machine-id-core.js';

export interface WriterIdentity {
  /** Random, stable for this machine (an earlier build's, for this data home on this machine). */
  id: string;
  /** What the user reads ("Evans-MacBook-Pro"); stored sealed in the repository. */
  name: string;
}

const backupDir = (dataDir: string): string => path.join(dataDir, 'local', 'backup');
export const machineIdPath = (dataDir: string): string => path.join(backupDir(dataDir), 'machine-id');
export const runLockPath = (dataDir: string): string => path.join(backupDir(dataDir), 'run.lock');

/** Files under local/backup/ that belong to this machine and never ride a backup. */
export const MACHINE_ONLY_FILES = ['local/backup/machine-id', 'local/backup/run.lock'];

let computerNameOnce: Promise<string> | null = null;

/**
 * The name a person knows this computer by: on a Mac its Computer Name
 * ("Evan's MacBook Pro", System Settings, General, About), elsewhere the
 * hostname without a ".local" (a container's id hostname is named as one).
 */
export function computerName(): Promise<string> {
  computerNameOnce ??= new Promise<string>((resolve) => {
    const raw = os.hostname().replace(/\.(local|lan|home)$/i, '');
    // A container's hostname is its id ("3f9c2a7b1d04"): say what it is instead.
    const host = /^[0-9a-f]{12}$/.test(raw) ? `Linux container ${raw.slice(0, 6)}` : raw;
    if (process.platform !== 'darwin') return resolve(host);
    execFile('scutil', ['--get', 'ComputerName'], { timeout: 2000 }, (err, out) => resolve(!err && out.trim() ? out.trim() : host));
  });
  return computerNameOnce;
}

/**
 * This machine's writer id for the data home: the one an earlier build made in
 * `local/backup/machine-id` while it holds one (a repository names it), else one
 * made from this machine's stable id and the data home's real path. Read only: it
 * never writes the file.
 *
 * Per data home, not per machine: two data homes on one machine (a copy, an
 * isolated one) are two writers, so a copy can never back up over its original's
 * repository as if it were it; the same home keeps its id across restarts and
 * upgrades because the machine id and its path do not change.
 */
export async function backupWriterId(dataDir: string): Promise<string> {
  const kept = (await fs.readFile(machineIdPath(dataDir), 'utf8').catch(() => '')).trim();
  if (isMachineId(kept)) return kept;
  const real = await fs.realpath(dataDir).catch(() => path.resolve(dataDir));
  return createHash('sha256').update(`${await readMachineId()}\0${real}`).digest('hex').slice(0, 32);
}

export async function localWriter(dataDir: string): Promise<WriterIdentity> {
  const [id, name] = await Promise.all([backupWriterId(dataDir), computerName()]);
  return { id, name };
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

/** Another live process holds this data home's backup lock now. */
export async function backupLockHeld(dataDir: string, deps: LockDeps = {}): Promise<boolean> {
  const d: Required<LockDeps> = { alive: deps.alive ?? pidAlive, started: deps.started ?? processStart };
  const held = await fs.readFile(runLockPath(dataDir), 'utf8').catch(() => null);
  return held !== null && !(await holderGone(held, d));
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
