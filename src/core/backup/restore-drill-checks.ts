/**
 * The checks of a restore drill (restore-drill.ts), each on its own: the restored tree
 * against the backup's own list of files, every database, the must-have list of the
 * data-location manifest (src/core/home-manifest/) against the backup, and what backups
 * leave out by design. Nothing here writes: the data home is only walked and stat'ed,
 * and databases are opened read-only on a worker thread (an integrity check of a large
 * one takes seconds, which would hold the server's event loop).
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectSqliteOffThread } from '../../lib/sqlite.js';
import { classifyHomePath, homeEntries, homePathClass, outsideHomeEntries, type DataClass } from '../home-manifest/index.js';
import { EXCLUDED_DIRS, backupTakes } from './scan.js';
import { AVG_CHUNK, MAX_CHUNK, MIN_CHUNK, SMALL_FILE_BYTES, chunkStream } from './repo/chunker.js';
import { restorePathOf } from './repo/restore.js';
import type { TreeEntry } from './repo/format.js';
import type { Repository } from './repo/repository.js';

export interface DrillCheck {
  id: 'restore' | 'files' | 'databases' | 'must-have' | 'read-back' | 'boot';
  /** null: not run (`detail` says why). */
  ok: boolean | null;
  detail: string;
  /** What failed, one line each (at most PROBLEM_LIMIT, then a count). */
  problems?: string[];
  /** How long its steps took, in ms (the boot check: start, the server's own boot, read-back, stop, total). */
  timings?: Record<string, number>;
}

export interface NotInBackupEntry {
  id: string;
  /** Where it is: `~/.open-walnut/<path>`, or `<root>:<path>` outside the data home. */
  place: string;
  class: DataClass;
  what: string;
  why: string;
  /** It exists on this machine now (undefined: not looked at). */
  present?: boolean;
}

export interface DatabaseReport {
  path: string;
  ok: boolean;
  /** integrity_check's first lines, or the error opening it. */
  detail?: string;
  tables?: number;
  rows?: number;
}

const PROBLEM_LIMIT = 20;

export function capProblems(all: string[]): string[] {
  return all.length <= PROBLEM_LIMIT ? all : [...all.slice(0, PROBLEM_LIMIT), `... and ${all.length - PROBLEM_LIMIT} more`];
}

/** Every regular file under `root`, '/'-separated relative paths (symlinks skipped, as the backup does). */
async function walkFiles(root: string, skipTop: (name: string) => boolean = () => false): Promise<Map<string, { size: number; bornMs: number; ctimeMs: number }>> {
  const out = new Map<string, { size: number; bornMs: number; ctimeMs: number }>();
  let sinceYield = 0;
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && skipTop(e.name)) continue;
      if (e.isDirectory()) await walk(childRel);
      else if (e.isFile()) {
        try {
          const st = await fs.stat(path.join(root, childRel));
          // Birth time where the file system keeps one; else the last change, which never claims a file is older than it is.
          out.set(childRel, { size: st.size, bornMs: st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs, ctimeMs: st.ctimeMs });
        } catch { /* gone between readdir and stat */ }
      }
      if (++sinceYield >= 500) { sinceYield = 0; await new Promise((r) => setImmediate(r)); }
    }
  };
  await walk('');
  return out;
}

/**
 * The restored folder against the backup's own list (its tree): the same files, each of
 * its size, and each file's chunks hash back to the ids the backup recorded (the keyed
 * hash of every chunk: the format's per-file hash). Restore checked every chunk as it
 * read it; this checks what landed on disk.
 */
export async function checkRestoredFiles(target: string, tree: TreeEntry[], repo: Repository, snapshot: { fileCount: number; totalBytes: number }): Promise<DrillCheck> {
  const problems: string[] = [];
  const restored = await walkFiles(target);
  const expected = new Map(tree.map((e) => [restorePathOf(e.p), e]));
  const treeBytes = tree.reduce((n, e) => n + e.s, 0);
  if (snapshot.fileCount !== tree.length) problems.push(`the backup says ${snapshot.fileCount} files, its list has ${tree.length}`);
  if (snapshot.totalBytes !== treeBytes) problems.push(`the backup says ${snapshot.totalBytes} bytes, its list adds up to ${treeBytes}`);
  // The chunk cuts are the format's: a repository made with other sizes is checked by size only.
  const c = repo.config.chunker;
  const canHash = c.min === MIN_CHUNK && c.avg === AVG_CHUNK && c.max === MAX_CHUNK;
  let hashed = 0;
  for (const [rel, e] of expected) {
    const got = restored.get(rel);
    if (!got) { problems.push(`${rel}: in the backup's list, not restored`); continue; }
    if (got.size !== e.s) { problems.push(`${rel}: ${got.size} bytes restored, the backup says ${e.s}`); continue; }
    if (!canHash) continue;
    const ids = await chunkIdsOf(path.join(target, rel), got.size, repo);
    if (ids.length !== e.b.length || ids.some((id, i) => id !== e.b[i])) problems.push(`${rel}: its content does not hash to what the backup recorded`);
    else hashed++;
  }
  for (const rel of restored.keys()) if (!expected.has(rel)) problems.push(`${rel}: restored but not in the backup's list`);
  const detail = `${restored.size} files restored, the backup lists ${tree.length}; ` +
    (canHash ? `${hashed} hashed back to the backup's chunk ids` : 'chunk sizes differ from this version\'s, so files were checked by size only');
  return { id: 'files', ok: problems.length === 0, detail, ...(problems.length ? { problems: capProblems(problems) } : {}) };
}

/** A file's chunk ids, cut exactly as the backup run cut them (repo/backup-run.ts). */
async function chunkIdsOf(file: string, size: number, repo: Repository): Promise<string[]> {
  if (size === 0) return [];
  if (size <= SMALL_FILE_BYTES) return [repo.blobId(await fs.readFile(file))];
  const ids: string[] = [];
  for await (const chunk of chunkStream(createReadStream(file, { highWaterMark: 1024 * 1024 }))) ids.push(repo.blobId(chunk));
  return ids;
}

/** The backup's own words for why it leaves a place out. */
function whyLeftOut(rel: string): string {
  const top = rel.split('/')[0];
  if (EXCLUDED_DIRS.has(top)) return `the backup skips the whole ${top}/ folder`;
  return 'the backup skips files named like this';
}

/**
 * What backups leave out by design, read from the code: every place of the manifest
 * whose data moves with the leader (leader-data) that the backup's rules skip, every
 * folder the backup skips on purpose that is not rebuildable (health, places: they stay
 * on the machine that collected them), and every leader-data place outside the data
 * home (backups read only the data home: the password vault is one).
 */
export async function notInBackups(dataDir: string, outsideRoots: Partial<Record<string, string>>): Promise<NotInBackupEntry[]> {
  const out: NotInBackupEntry[] = [];
  const exists = (p: string) => fs.lstat(p).then(() => true, () => false);
  for (const e of homeEntries()) {
    if (e.path === '' || e.class === 'rebuildable') continue;
    // A file, or anything inside a dir: what the backup does with it.
    const probe = e.kind === 'dir' ? `${e.path}/x` : e.path;
    if (backupTakes(probe) !== null) continue;
    if (e.class === 'machine' && !EXCLUDED_DIRS.has(e.path)) continue;
    const present = await exists(path.join(dataDir, e.path));
    if (e.legacy && !present) continue;
    out.push({ id: e.id, place: `~/.open-walnut/${e.path}${e.kind === 'dir' ? '/' : ''}`, class: e.class, what: e.what, why: whyLeftOut(e.path), present });
  }
  for (const e of outsideHomeEntries()) {
    if (e.class !== 'leader-data') continue;
    const rootDir = outsideRoots[e.root];
    const present = rootDir ? await exists(path.join(rootDir, e.path)) : undefined;
    out.push({ id: e.id, place: `${e.root}:${e.path}`, class: e.class, what: e.what, why: 'it is outside the data home, and backups read only the data home', ...(present === undefined ? {} : { present }) });
  }
  return out;
}

/** Where the outside roots are on this machine (only xdg-state holds leader-data today). */
export function defaultOutsideRoots(env: NodeJS.ProcessEnv = process.env, userHome = os.homedir()): Partial<Record<string, string>> {
  const xdg = env.XDG_STATE_HOME;
  return { 'xdg-state': xdg && xdg.startsWith('/') ? xdg : path.join(userHome, '.local', 'state') };
}

/** Files born this long before the backup finished are surely in it: a run scans first and finishes later. */
export const MUST_HAVE_SLACK_MS = 6 * 3_600_000;

/**
 * The must-have list against the backup: every file of the data home that the manifest
 * classes leader-data and the backup's rules take, and that existed well before the
 * backup (`slackMs`), must be in its list. It catches a backup whose own list missed
 * something, which the files check (restored tree against that list) cannot.
 * A file missing from the backup whose inode changed after `before` (ctime: a rename
 * keeps the birth time, and moves an old note to a path the backup never saw) is counted
 * as changed since the backup, not as missing. Folders the backup skips whole are not
 * walked: they are in the not-in-backups list.
 */
export async function checkMustHave(dataDir: string, tree: TreeEntry[], snapshotCreatedAt: string, slackMs = MUST_HAVE_SLACK_MS): Promise<DrillCheck> {
  const before = Date.parse(snapshotCreatedAt) - slackMs;
  const inBackup = new Set(tree.map((e) => restorePathOf(e.p)));
  const live = await walkFiles(dataDir, (name) => EXCLUDED_DIRS.has(name));
  const missing = new Map<string, string[]>();
  let expected = 0;
  let found = 0;
  let changedSince = 0;
  for (const [rel, st] of live) {
    if (st.bornMs >= before || backupTakes(rel) === null || homePathClass(rel) !== 'leader-data') continue;
    expected++;
    if (inBackup.has(rel)) { found++; continue; }
    if (st.ctimeMs >= before) { changedSince++; continue; }
    const id = classifyHomePath(rel)?.id ?? `unlisted:${rel.split('/')[0]}`;
    missing.set(id, [...(missing.get(id) ?? []), rel]);
  }
  const problems = [...missing].map(([id, files]) =>
    `${id}: ${files.length} file(s) in the data home since before the backup are not in it (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', ...' : ''})`);
  return {
    id: 'must-have',
    ok: problems.length === 0,
    detail: `${expected} leader-data files of the data home predate the backup by ${Math.round(slackMs / 60_000)} min or more; ${found} are in it` +
      (changedSince ? `, ${changedSince} were moved or changed since it (not required)` : ''),
    ...(problems.length ? { problems: capProblems(problems) } : {}),
  };
}

export const TASKS_DB = 'tasks/tasks.sqlite';
const TASK_QUERY = 'SELECT id, title FROM tasks ORDER BY updated_at DESC LIMIT 1';

/** Every restored database (the backup's sqlite snapshots) through integrity_check. */
export async function checkDatabases(target: string, tree: TreeEntry[]): Promise<{ check: DrillCheck; databases: DatabaseReport[]; task: { id: string; title: string } | null; taskError?: string }> {
  const dbs = tree.map((e) => restorePathOf(e.p)).filter((p) => p.endsWith('.sqlite')).sort();
  const databases: DatabaseReport[] = [];
  let task: { id: string; title: string } | null = null;
  let taskError: string | undefined;
  for (const rel of dbs) {
    const r = await inspectSqliteOffThread(path.join(target, rel), rel === TASKS_DB ? { query: TASK_QUERY } : {});
    if (rel === TASKS_DB && r.row && typeof r.row.id === 'string') task = { id: r.row.id, title: String(r.row.title ?? '') };
    if (rel === TASKS_DB && r.rowError) taskError = r.rowError;
    databases.push({ path: rel, ok: r.ok, ...(r.detail ? { detail: r.detail } : {}), ...(r.tables !== undefined ? { tables: r.tables, rows: r.rows } : {}) });
  }
  const bad = databases.filter((d) => !d.ok).map((d) => `${d.path}: ${d.detail ?? 'integrity check failed'}`);
  return {
    check: {
      id: 'databases',
      ok: bad.length === 0,
      detail: `${databases.length - bad.length} of ${databases.length} databases pass integrity_check. ` +
        'The backup records no row counts, so rows were counted here and not compared with the time of the backup',
      ...(bad.length ? { problems: capProblems(bad) } : {}),
    },
    databases,
    task,
    ...(taskError ? { taskError } : {}),
  };
}

/** A note of the restored folder, read back whole as text. */
export async function readBackNote(target: string, tree: TreeEntry[]): Promise<{ path: string } | { error: string } | null> {
  const notes = tree.map((e) => restorePathOf(e.p)).filter((p) => p.endsWith('.md') && /^(artifacts\/notes|notes|artifacts)\//.test(p)).sort();
  const rel = notes.find((p) => p.startsWith('artifacts/notes/')) ?? notes[0];
  if (!rel) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(path.join(target, rel)));
    return { path: rel };
  } catch (err) {
    return { error: `${rel}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
