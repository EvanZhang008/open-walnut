/**
 * The planning half of git-sync-apply.ts: what differs between HEAD and the
 * target, what is on disk at each of those paths, and the steps that take the
 * tree from one to the other, or the paths that stop it.
 *
 * Nothing here writes the working tree. A path the app wrote since the last
 * commit, or anything untracked in the way that is not ignored (a file where
 * the target adds one, a file in a directory the target turns into a file, a
 * file where the target needs a directory), stops the whole apply before it
 * starts (2026-11-24 review: a directory holding only a `.DS_Store` made every
 * tick delete one file, write another, then give up on the directory, forever).
 * Ignored residue is cleared as git clears it, except a machine-local file.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { addTimeoutFor } from './git-sync-large-files.js';
import { must, type GitStatusRunner } from './git-sync-rewrite-carry.js';
import { NOT_THERE, errCode, stampOf, type Op, type PathState } from './git-sync-apply-journal.js';

export interface Entry { mode: string; oid: string }
export interface Change { path: string; from: Entry | null; to: Entry | null }
export type Seen =
  | { kind: 'absent' }
  | { kind: 'dir' }
  | { kind: 'file' | 'link' | 'other'; oid: string; stat: fs.BigIntStats; text?: Buffer };


/** An untracked directory the target puts a file over, listed this far at most; beyond, the pull defers. */
const CLEAR_DIR_MAX_ENTRIES = 2_000;

export const kindOf = (mode: string): 'file' | 'link' | 'gitlink' =>
  mode === '120000' ? 'link' : mode === '160000' ? 'gitlink' : 'file';
const depth = (p: string): number => p.split('/').length;

/** git's blob id for `content`, in the repo's hash (sha1 or sha256, told by the id length). */
function blobId(oidLength: number, content: Buffer): string {
  return crypto.createHash(oidLength === 64 ? 'sha256' : 'sha1')
    .update(`blob ${content.length}\0`).update(content).digest('hex');
}

export async function readChanges(run: GitStatusRunner, oldHead: string, target: string): Promise<Change[]> {
  const out = await must(run, ['diff-tree', '-r', '-z', '--no-renames', oldHead, target]);
  const fields = out.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]/.exec(fields[i]);
    if (!m) throw new Error(`unexpected diff-tree record: ${fields[i].slice(0, 120)}`);
    changes.push({
      path: fields[i + 1],
      from: m[1] === '000000' ? null : { mode: m[1], oid: m[3] },
      to: m[2] === '000000' ? null : { mode: m[2], oid: m[4] },
    });
  }
  return changes;
}

/** A path git itself would refuse to check out (or one this module cannot name safely). */
export function unsafePath(p: string): boolean {
  return p.includes('\n') || p.split('/').some((c) => c === '' || c === '.' || c === '..' || c.toLowerCase() === '.git');
}

/** Why only git can write these changes, or null. One config read, one check-attr when there is something to write. */
export async function conversionReason(run: GitStatusRunner, changes: Change[]): Promise<string | null> {
  if (process.platform === 'win32') return 'a Windows checkout converts line endings';
  if (changes.some((c) => path.posix.basename(c.path) === '.gitattributes')) return 'the pull changes a .gitattributes file';
  const folded = new Map<string, string>();
  for (const c of changes) {
    const key = c.path.toLowerCase();
    const other = folded.get(key);
    if (other !== undefined && other !== c.path) return `a case-only rename (${other} / ${c.path})`;
    folded.set(key, c.path);
  }
  const config = (await run(['config', '--get-regexp', '^core\\.(autocrlf|eol|symlinks)$'])).stdout.toLowerCase();
  if (/^core\.autocrlf (true|input)$/m.test(config)) return 'core.autocrlf converts line endings';
  if (/^core\.eol crlf$/m.test(config)) return 'core.eol=crlf converts line endings';
  if (/^core\.symlinks false$/m.test(config)) return 'core.symlinks=false';
  const written = changes.filter((c) => c.to).map((c) => c.path);
  if (written.length === 0) return null;
  const attrs = await must(run, ['check-attr', '-z', '--stdin', 'filter', 'eol', 'ident', 'working-tree-encoding'], {
    input: written.map((p) => `${p}\0`).join(''),
  });
  const f = attrs.split('\0');
  for (let i = 0; i + 2 < f.length; i += 3) {
    if (f[i + 2] !== 'unspecified' && f[i + 2] !== 'unset') return `${f[i]} has the ${f[i + 1]} attribute`;
  }
  return null;
}

export class RacedError extends Error {
  constructor(readonly file: string, detail: string) { super(`${file} changed during the pull: ${detail}`); }
}

/** What is at `rel` (lstat, a link's text), without hashing. */
async function look(repoDir: string, rel: string): Promise<Seen> {
  const abs = path.join(repoDir, rel);
  let stat: fs.BigIntStats;
  try {
    stat = await fsp.lstat(abs, { bigint: true });
  } catch (error) {
    if (NOT_THERE.has(errCode(error))) return { kind: 'absent' };
    throw error;
  }
  if (stat.isDirectory()) return { kind: 'dir' };
  if (stat.isSymbolicLink()) return { kind: 'link', oid: '', stat, text: await fsp.readlink(abs, { encoding: 'buffer' }) };
  return { kind: stat.isFile() ? 'file' : 'other', oid: '', stat };
}

/** What is on disk at each path, hashed as git would (one hash-object spawn for every regular file). */
export async function inspect(run: GitStatusRunner, repoDir: string, changes: Change[], oidLength: number): Promise<Map<string, Seen>> {
  const seen = new Map<string, Seen>();
  const realDirs = new Map<string, boolean>();
  // git treats a path behind a symlink or a file as absent: never look (or write) through one.
  const isRealDir = async (rel: string): Promise<boolean> => {
    if (rel === '.' || rel === '') return true;
    const known = realDirs.get(rel);
    if (known !== undefined) return known;
    let ok = await isRealDir(path.posix.dirname(rel));
    if (ok) ok = await fsp.lstat(path.join(repoDir, rel)).then((s) => s.isDirectory(), () => false);
    realDirs.set(rel, ok);
    return ok;
  };
  const files: string[] = [];
  for (const c of changes) {
    const s = (await isRealDir(path.posix.dirname(c.path))) ? await look(repoDir, c.path) : { kind: 'absent' as const };
    if (s.kind === 'link') s.oid = blobId(oidLength, s.text!);
    if (s.kind === 'file') files.push(c.path);
    seen.set(c.path, s);
  }
  if (files.length > 0) {
    // A file that vanished between the lstat and the hash fails the whole call: a writer is busy, try again later.
    const bytes = files.reduce((sum, p) => { const s = seen.get(p) as { stat?: fs.BigIntStats }; return sum + Number(s.stat?.size ?? 0n); }, 0);
    const r = await run(['hash-object', '--stdin-paths'], { input: `${files.join('\n')}\n`, timeout: addTimeoutFor(bytes) });
    if (r.code !== 0) throw new RacedError(files[0], r.stderr.trim());
    const oids = r.stdout.split('\n').filter(Boolean);
    files.forEach((p, i) => { (seen.get(p) as { oid: string }).oid = oids[i] ?? ''; });
  }
  return seen;
}

export function matches(s: Seen, e: Entry | null): boolean {
  if (e === null) return s.kind === 'absent';
  if (s.kind !== 'file' && s.kind !== 'link') return false;
  if (s.kind !== kindOf(e.mode) || s.oid !== e.oid) return false;
  // The exec bit is part of a file's state for git (core.fileMode, on by default here).
  return s.kind === 'link' || ((s.stat.mode & 0o111n) !== 0n) === (e.mode === '100755');
}

/** A file or link as the journal records it (a link's text kept, so a rollback can recreate it). */
function diskState(s: Seen): PathState {
  if (s.kind === 'file') return { kind: 'file', ...stampOf(s.stat) };
  if (s.kind === 'link') return { kind: 'link', ...stampOf(s.stat), text: s.text!.toString('base64') };
  return { kind: s.kind === 'dir' ? 'dir' : 'absent' };
}

/** Every file and directory under `rel` (itself included), or null past `limit` entries. */
async function listTree(repoDir: string, rel: string, limit: number): Promise<{ files: string[]; dirs: string[] } | null> {
  const files: string[] = [];
  const dirs = [rel];
  for (let i = 0; i < dirs.length; i++) {
    for (const e of await fsp.readdir(path.join(repoDir, dirs[i]), { withFileTypes: true })) {
      (e.isDirectory() ? dirs : files).push(`${dirs[i]}/${e.name}`);
      if (files.length + dirs.length > limit) return null;
    }
  }
  return { files, dirs };
}

export interface Plan { ops: Op[]; writes: Change[]; blocked: string[]; overwroteIgnored: string[]; keptLocal: string[] }

/** The steps that take the tree from HEAD to the target, or the paths that stop it (`blocked`). */
export async function planApply(
  run: GitStatusRunner, repoDir: string, changes: Change[], seen: Map<string, Seen>, isMachineLocal: (f: string) => boolean,
  /** Whether a path still holds what a held (interrupted) pull wrote there: pulled content, replaceable like HEAD's. */
  heldPulled: (f: string) => boolean = () => false,
): Promise<Plan> {
  const byPath = new Map(changes.map((c) => [c.path, c]));
  const blocked: string[] = [];
  const keptLocal: string[] = [];
  const overwroteIgnored: string[] = [];
  const deletes: string[] = [];
  const writes: Change[] = [];
  const clearDirs = new Set<string>();
  const candidates: Array<{ path: string; overwrite?: Change }> = [];
  for (const c of changes) {
    const s = seen.get(c.path)!;
    if (matches(s, c.to)) continue; // already the target's
    const onDisk = s.kind === 'file' || s.kind === 'link';
    if (onDisk && isMachineLocal(c.path)) { keptLocal.push(c.path); continue; }
    // An interrupted pull's bytes are the hub's content, not a write of the user's:
    // this pull replaces them like HEAD's (a removal it made counts as HEAD's file gone).
    const pulled = heldPulled(c.path);
    if (c.to === null || c.from !== null) {
      if (!matches(s, c.from) && !pulled) blocked.push(c.path);
      else if (c.to === null) deletes.push(c.path);
      else writes.push(c);
    } else if (s.kind === 'absent') {
      writes.push(c);
    } else if (s.kind === 'dir') {
      writes.push(c);
      clearDirs.add(c.path);
    } else if (onDisk) {
      if (pulled) writes.push(c);
      else candidates.push({ path: c.path, overwrite: c }); // untracked where the target adds one
    } else {
      blocked.push(c.path);
    }
  }
  const deleted = new Set(deletes);

  // A directory where the target puts a file: empty once its tracked files go, or holding only ignored ones.
  const rmdirs: string[] = [];
  for (const dir of clearDirs) {
    const listed = await listTree(repoDir, dir, CLEAR_DIR_MAX_ENTRIES);
    if (!listed) { blocked.push(dir); continue; }
    rmdirs.push(...listed.dirs);
    for (const f of listed.files) {
      if (deleted.has(f)) continue;
      if (byPath.has(f)) blocked.push(f); // a tracked change in it that cannot land
      else candidates.push({ path: f });
    }
  }

  // Each directory a write needs: made where absent; a file or link standing there must go first.
  const mkdirs = new Set<string>();
  const stateOf = new Map<string, Seen['kind']>();
  for (const c of writes) {
    const parts = c.path.split('/');
    let under = false; // below a non-directory everything is absent, whatever lstat says through a link
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!under) {
        const kind = stateOf.get(dir) ?? (await look(repoDir, dir)).kind;
        stateOf.set(dir, kind);
        if (kind === 'dir') continue;
        under = true;
        if (kind !== 'absent' && !deleted.has(dir) && !candidates.some((x) => x.path === dir)) {
          if (byPath.has(dir)) blocked.push(dir); else candidates.push({ path: dir });
        }
      }
      mkdirs.add(dir);
    }
  }

  // Untracked things in the way: ignored ones are machine residue git itself replaces; any other is a write.
  const removals: string[] = [];
  if (candidates.length > 0) {
    const r = await run(['check-ignore', '--no-index', '-z', '--stdin'], { input: candidates.map((x) => `${x.path}\0`).join('') });
    if (r.code !== 0 && r.code !== 1) throw new Error(`git check-ignore exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
    const ignored = new Set(r.code === 0 ? r.stdout.split('\0').filter(Boolean) : []);
    for (const x of candidates) {
      if (!ignored.has(x.path) || isMachineLocal(x.path)) { blocked.push(x.path); continue; }
      if (x.overwrite) { overwroteIgnored.push(x.path); writes.push(x.overwrite); continue; }
      const s = await look(repoDir, x.path);
      if (s.kind === 'absent') continue; // gone since the listing
      if (s.kind !== 'file' && s.kind !== 'link') { blocked.push(x.path); continue; }
      overwroteIgnored.push(x.path);
      removals.push(x.path);
      seen.set(x.path, s);
    }
  }
  if (blocked.length > 0) return { ops: [], writes: [], blocked: [...new Set(blocked)], overwroteIgnored, keptLocal };

  const ops: Op[] = [];
  for (const p of [...deletes, ...removals]) ops.push({ do: 'unlink', path: p, before: diskState(seen.get(p)!), after: { kind: 'absent' } });
  for (const d of rmdirs.sort((a, b) => depth(b) - depth(a))) ops.push({ do: 'rmdir', path: d, before: { kind: 'dir' }, after: { kind: 'absent' } });
  for (const d of [...mkdirs].sort((a, b) => depth(a) - depth(b))) ops.push({ do: 'mkdir', path: d, before: { kind: 'absent' }, after: { kind: 'dir' } });
  for (const c of writes) {
    const before = clearDirs.has(c.path) ? { kind: 'absent' as const } : diskState(seen.get(c.path)!);
    ops.push({ do: 'write', path: c.path, before, after: { kind: 'absent' }, oid: c.to!.oid }); // `after` once its temp exists
  }
  return { ops, writes, blocked: [], overwroteIgnored, keptLocal };
}

