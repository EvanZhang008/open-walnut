/**
 * The undo half of git-sync-apply.ts: the index lock it holds, the journal it
 * writes before the working tree moves, and the rollback that journal allows.
 *
 * An apply changes many paths one rename at a time. When it stops part way (a
 * store written under it, the branch CAS refused, a throw, the process killed),
 * the paths it already changed hold the pulled version while the branch still
 * points at the old commit. The next auto-save would then commit that pulled
 * content as a local change stamped "now", and LWW would let it beat a newer hub
 * write of the same file (review of 2026-11-24). So before the first mutation
 * the apply writes `.git/walnut-apply/journal.json`: every step with the state
 * before it (a hard-link backup of a file it replaces or removes) and after it.
 * A stop puts every changed path back from that record, and so does the next
 * tick when the process died: a commit never sees a half-applied tree.
 *
 * Rollback is decided per path from what is on disk, never from a step counter:
 * a path in its "after" state is restored, one in its "before" state was never
 * reached, and anything else was written by the app after the apply touched it
 * and is left alone (it is the newest write). What a later tick does with a
 * journal it finds is git-sync-apply-recovery.ts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GitStatusRunner } from './git-sync-rewrite-carry.js';

export const NOT_THERE = new Set(['ENOENT', 'ENOTDIR']);
export const errCode = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? '';
export const tempName = (): string => `.open-walnut-${crypto.randomBytes(8).toString('hex')}.tmp`;

/** The journal and the backups live in .git, never in the tree (no `add -A` or temp sweep sees them). */
export const applyDir = (gitDir: string): string => path.join(gitDir, 'walnut-apply');
export const journalPath = (dir: string): string => path.join(dir, 'journal.json');
/** Set when the branch moved but the index could not be brought to it: the next tick runs `git reset -q`. */
export const staleIndexPath = (gitDir: string): string => path.join(gitDir, 'walnut-index-stale');

/** A lock whose holder stopped touching it this long ago belongs to an apply that died. */
export const DEAD_APPLY_LOCK_MS = 30_000;

/** How long a pull waits for the app's renames under way before it changes the tree (write-gate.ts). */
let writeDrainMs = 5_000;
export const writeDrainMsNow = (): number => writeDrainMs;
/** Test hook: a shorter wait for the app's renames to finish; null restores the default. */
export function setWriteDrainForTest(ms: number | null): void {
  writeDrainMs = ms ?? 5_000;
}

// ── The in-process latch: git-sync's own stale-lock sweeps and commits stand aside ──
let held = 0;
/** True while this process holds the data repo's index lock for an apply or its recovery. */
export function applyInFlight(): boolean {
  return held > 0;
}

/**
 * `.git/index.lock`, created the way git creates it, so every other git writer
 * waits. It carries a random token (an inode alone can be reused once a sweep
 * removed ours), a 1 s timer keeps its mtime fresh during long single steps (the
 * stale-lock sweeps judge a lock by its age), and it is released once.
 */
export class IndexLock {
  private released = false;
  private readonly timer: NodeJS.Timeout;

  private constructor(readonly file: string, private readonly ino: bigint, private readonly token: string) {
    held++;
    this.timer = setInterval(() => this.touch(), 1_000);
    this.timer.unref();
  }

  /** Null when another git holds it; `takeDeadAfterMs` breaks a lock nobody touched for that long. */
  static async acquire(gitDir: string, opts: { takeDeadAfterMs?: number } = {}): Promise<IndexLock | null> {
    const file = path.join(gitDir, 'index.lock');
    const token = `walnut-apply ${crypto.randomBytes(16).toString('hex')}\n`;
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle: fsp.FileHandle;
      try {
        handle = await fsp.open(file, 'wx', 0o600);
      } catch (error) {
        if (errCode(error) !== 'EEXIST') throw error;
        if (attempt > 0 || opts.takeDeadAfterMs === undefined) return null;
        const st = await fsp.stat(file).catch(() => null);
        if (st && Date.now() - st.mtimeMs <= opts.takeDeadAfterMs) return null;
        await fsp.rm(file, { force: true });
        continue;
      }
      try {
        await handle.writeFile(token);
        const ino = (await handle.stat({ bigint: true })).ino;
        await handle.close();
        return new IndexLock(file, ino, token);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fsp.rm(file, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    return null;
  }

  /** Still ours: the same inode holding our token (a sweep may have removed it and another git taken it). */
  owned(): boolean {
    if (this.released) return false;
    try {
      const st = fs.lstatSync(this.file, { bigint: true });
      return st.ino === this.ino && st.size === BigInt(this.token.length) && fs.readFileSync(this.file, 'utf-8') === this.token;
    } catch {
      return false;
    }
  }

  private touch(): void {
    if (!this.owned()) return;
    try { fs.utimesSync(this.file, new Date(), new Date()); } catch { /* gone: owned() says so later */ }
  }

  async release(): Promise<void> {
    if (this.released) return;
    const mine = this.owned();
    this.stop();
    if (mine) await fsp.rm(this.file, { force: true });
  }

  /** Stop holding it and leave the file behind: a test's stand-in for the process dying. */
  abandonForTest(): void {
    if (!this.released) this.stop();
  }

  private stop(): void {
    this.released = true;
    clearInterval(this.timer);
    held--;
  }
}

// ── The journal ──

/** A path's state: lstat identity for a file or link (size and mtime catch a rewrite in place). */
interface Stamp { ino: string; size: string; mtimeNs: string; mode: string }
export type PathState =
  | { kind: 'absent' }
  | { kind: 'dir' }
  | ({ kind: 'file'; backup?: string } & Stamp)
  | ({ kind: 'link'; text?: string } & Stamp);

/** One step of an apply, in the order it runs. Paths are relative to the repo. */
export interface Op {
  do: 'unlink' | 'rmdir' | 'mkdir' | 'write';
  path: string;
  before: PathState;
  after: PathState;
  /** `write`: the temp file renamed over the path. */
  temp?: string;
  /** `write`: the blob it puts there (what a later tick compares HEAD with). */
  oid?: string;
}

export interface Journal {
  version: 1;
  branch: string;
  oldHead: string;
  target: string;
  startedAt: number;
  ops: Op[];
}

export function stampOf(st: fs.BigIntStats): Stamp {
  return { ino: String(st.ino), size: String(st.size), mtimeNs: String(st.mtimeNs), mode: String(st.mode) };
}

/** Whether `abs` is in `state` now (a file or link by inode, size, mtime and mode). */
export function stateIs(abs: string, state: PathState): boolean {
  let st: fs.BigIntStats;
  try {
    st = fs.lstatSync(abs, { bigint: true });
  } catch (error) {
    if (NOT_THERE.has(errCode(error))) return state.kind === 'absent';
    throw error;
  }
  switch (state.kind) {
    case 'absent': return false;
    case 'dir': return st.isDirectory();
    case 'file':
    case 'link':
      return (state.kind === 'file' ? st.isFile() : st.isSymbolicLink())
        && String(st.ino) === state.ino && String(st.size) === state.size
        && String(st.mtimeNs) === state.mtimeNs && String(st.mode) === state.mode;
  }
}

/** A hard link to the file in the journal's directory (a copy where links are refused). */
export async function backUp(gitDir: string, abs: string, name: string): Promise<void> {
  const dest = path.join(applyDir(gitDir), name);
  try {
    await fsp.link(abs, dest);
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(errCode(error))) throw error;
    await fsp.copyFile(abs, dest, fs.constants.COPYFILE_EXCL);
  }
}

export async function writeJournal(gitDir: string, journal: Journal): Promise<void> {
  const tmp = `${journalPath(applyDir(gitDir))}.tmp`;
  const handle = await fsp.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(journal));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, journalPath(applyDir(gitDir)));
  // The rename itself reaches the disk too: a power loss must not leave changed files and no journal.
  const dir = await fsp.open(applyDir(gitDir), 'r');
  try { await dir.sync(); } catch { /* a filesystem that refuses a directory fsync */ } finally { await dir.close(); }
}

/** The journal in `dir`: null when there is none, 'unreadable' when it does not parse as one. */
export async function readJournal(dir: string): Promise<Journal | 'unreadable' | null> {
  let text: string;
  try {
    text = await fsp.readFile(journalPath(dir), 'utf-8');
  } catch (error) {
    if (NOT_THERE.has(errCode(error))) return null;
    throw error;
  }
  try {
    const journal = JSON.parse(text) as Journal;
    return journal?.version === 1 && Array.isArray(journal.ops) ? journal : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** The journal and every backup gone; an empty directory ready for the next apply. */
export async function resetApplyDir(gitDir: string): Promise<void> {
  await fsp.rm(applyDir(gitDir), { recursive: true, force: true });
  await fsp.mkdir(applyDir(gitDir), { recursive: true, mode: 0o700 });
}

export async function clearApplyDir(gitDir: string): Promise<void> {
  await fsp.rm(applyDir(gitDir), { recursive: true, force: true });
}

// ── Rollback ──

export interface RollbackResult {
  restored: number;
  /** Written by the app after the apply changed them: the newest write, kept. */
  leftAlone: string[];
  failed: string[];
}

function restoreBefore(gitDir: string, abs: string, before: PathState): void {
  if (before.kind === 'absent') { fs.rmSync(abs, { force: true }); return; }
  if (before.kind === 'dir') { fs.mkdirSync(abs, { recursive: true }); return; }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (before.kind === 'link') {
    const tmp = path.join(path.dirname(abs), tempName());
    fs.symlinkSync(Buffer.from(before.text ?? '', 'base64'), tmp);
    fs.renameSync(tmp, abs);
    return;
  }
  const backup = path.join(applyDir(gitDir), before.backup!);
  try {
    fs.renameSync(backup, abs);
  } catch (error) {
    if (errCode(error) !== 'EXDEV') throw error;
    const tmp = path.join(path.dirname(abs), tempName());
    fs.copyFileSync(backup, tmp, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(tmp, Number(BigInt(before.mode) & 0o7777n));
    fs.renameSync(tmp, abs);
  }
}

/** Remove every temp file the journal names (a write never reached still has its temp). */
export function removeTemps(repoDir: string, ops: Op[]): void {
  for (const op of ops) if (op.temp) fs.rmSync(path.join(repoDir, op.temp), { force: true });
}

/**
 * Put every path the ops changed back to its state before them, newest step
 * first, and remove the temps of the steps never reached. Run it with the
 * rename gate closed (write-gate.ts): each check and its restore are back to back.
 */
export async function rollBack(repoDir: string, gitDir: string, ops: Op[]): Promise<RollbackResult> {
  const result: RollbackResult = { restored: 0, leftAlone: [], failed: [] };
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    const abs = path.join(repoDir, op.path);
    try {
      if (stateIs(abs, op.before)) continue; // never reached
      if (!stateIs(abs, op.after)) { result.leftAlone.push(op.path); continue; }
      if (op.do === 'mkdir') {
        try { fs.rmdirSync(abs); } catch (error) {
          if (errCode(error) === 'ENOTEMPTY' || errCode(error) === 'EEXIST') { result.leftAlone.push(op.path); continue; }
          throw error;
        }
      } else {
        restoreBefore(gitDir, abs, op.before);
      }
      result.restored++;
    } catch (error) {
      result.failed.push(`${op.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if ((ops.length - i) % 100 === 0) await new Promise((r) => setImmediate(r));
  }
  try { removeTemps(repoDir, ops); } catch (error) { result.failed.push(`temps: ${error instanceof Error ? error.message : String(error)}`); }
  return result;
}

// ── Index refresh ──

/**
 * The index to `target`, the working tree untouched: a copy of the index (stat
 * data kept for every unchanged path) read against the target, refreshed, then
 * renamed over `.git/index` while the lock is still ours. False when that failed;
 * the index is then as it was, and `git reset -q` once the lock is free repairs it.
 */
export async function refreshIndex(run: GitStatusRunner, gitDir: string, target: string, lock: IndexLock): Promise<boolean> {
  const next = path.join(gitDir, 'walnut-sync-apply.index');
  const env = { GIT_INDEX_FILE: next };
  try {
    await fsp.rm(next, { force: true });
    const hadIndex = await fsp.copyFile(path.join(gitDir, 'index'), next).then(() => true, (e) => {
      if (NOT_THERE.has(errCode(e))) return false;
      throw e;
    });
    let read = await run(hadIndex ? ['read-tree', '-m', target] : ['read-tree', target], { env });
    // A whole new index: no stat data, so the next status hashes every file once.
    if (read.code !== 0 && hadIndex) read = await run(['read-tree', target], { env });
    if (read.code !== 0) return false;
    await run(['update-index', '-q', '--refresh'], { env }); // exit 1 only lists paths that differ
    if (!lock.owned()) return false;
    await fsp.rename(next, path.join(gitDir, 'index'));
    return true;
  } catch {
    return false;
  } finally {
    await fsp.rm(next, { force: true }).catch(() => undefined);
  }
}

export async function markIndexStale(gitDir: string, target: string): Promise<void> {
  await fsp.writeFile(staleIndexPath(gitDir), `${target}\n`, { mode: 0o600 }).catch(() => undefined);
}
