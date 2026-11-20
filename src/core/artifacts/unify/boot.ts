/**
 * The one tree at boot (layout.ts, migrate-unified.ts): before anything reads or writes a note.
 * The `notes_unified` switch on moves the notes and the artifacts folder into it; off moves them
 * back; a switch a crash cut short is finished first. Then the vault root, the old-path map,
 * the artifacts layout and the task-to-project table are set for the rest of the process.
 *
 * Only the primary moves files; a replica keeps its own copy as the primary sends it.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { NOTES_DIR, WALNUT_HOME } from '../../../constants.js';
import { log } from '../../../logging/index.js';
import type { Task } from '../../types.js';
import { setNoteMoves } from '../../notes/note-path-moves.js';
import { setNotesRoot } from '../../notes/note-paths.js';
import { artifactsDir, legacyArtifactsDir, setArtifactsByProject } from '../paths.js';
import { mapVaultPath, movedPath, projectDirOf, type MoveMap } from './layout.js';
import { ABORTED_FILE, abortRollback, abortSwitch, adoptStrayVault, finishSwitch, mergeInto, readUnified, rollbackUnified, unifyTree, vaultMapOf, vaultPathBack, writeRecord, type UnifiedRecord, type UnifyDirs } from './migrate-unified.js';
import { readConfigLists, rewriteNoteRefs, type ConfigLists } from './refs.js';
import { clearTaskHomes, loadTaskHomes, renameHomes, watchTaskHomes } from './task-homes.js';

/** Marks `knowledge/` as this module's folder of links to the old places (not a folder to take in). */
export const OLD_PLACES_MARK = '.walnut-links';

const dirsNow = (): UnifyDirs => ({ notes: NOTES_DIR, artifacts: artifactsDir() });

/** The vault files the move made, [path before, path now]. */
const pairsOf = (record: UnifiedRecord): Array<[string, string]> => record.moves.filter(([f]) => !f.startsWith('a:'));

/** Put the process on a layout: the tree's (record) or the folders before it (null). */
export function applyLayout(record: UnifiedRecord | null, tasks: readonly Pick<Task, 'id' | 'project'>[]): void {
  setNotesRoot(record ? artifactsDir() : null);
  setNoteMoves(record ? vaultMapOf(record) : null, record ? pairsOf(record) : undefined);
  setArtifactsByProject(!!record);
  if (record) { loadTaskHomes(artifactsDir(), tasks); watchTaskHomes(followProjectRename); } else clearTaskHomes();
}

/**
 * `knowledge/` (the artifacts folder's first name, 2026-11-19 to 11-20) as links into the tree:
 * a path a message from those days named (knowledge/nodes/<id>/reflections/<day>.md) still
 * opens, and the folder holds no copy of the notes (Obsidian reads the whole home).
 */
async function linkOldPlaces(record: UnifiedRecord): Promise<void> {
  const k = legacyArtifactsDir();
  const st = await fsp.lstat(k).catch(() => null);
  if (st?.isSymbolicLink()) await fsp.unlink(k);
  else if (st) return; // a real folder someone else made: left alone
  await fsp.mkdir(path.join(k, 'nodes'), { recursive: true });
  await fsp.writeFile(path.join(k, OLD_PLACES_MARK), 'Links to where these files are now (src/core/artifacts/unify/boot.ts).\n');
  const homes = new Map<string, string>();
  for (const [from, to] of record.moves) {
    const m = /^a:nodes\/([^/]+)\/MEMORY\.md$/.exec(from) ?? /^a:nodes\/([^/]+)\/(?:notes|reflections)\//.exec(from);
    if (m && !homes.has(m[1]!)) homes.set(m[1]!, to.replace(/\/(MEMORY\.md|notes\/.*|reflections\/.*)$/, ''));
  }
  const link = async (at: string, target: string): Promise<void> => {
    await fsp.mkdir(path.dirname(at), { recursive: true });
    await fsp.symlink(path.relative(path.dirname(at), target), at).catch(() => {});
  };
  for (const [id, home] of homes) await link(path.join(k, 'nodes', id), path.join(artifactsDir(), home));
  await link(path.join(k, 'org', 'skills'), path.join(artifactsDir(), 'skills'));
  await link(path.join(k, 'shared', 'notes'), path.join(artifactsDir(), 'memory', '_shared', 'notes'));
}

async function unlinkOldPlaces(): Promise<void> {
  const k = legacyArtifactsDir();
  if (await fsp.stat(path.join(k, OLD_PLACES_MARK)).catch(() => null)) await fsp.rm(k, { recursive: true, force: true });
}

/** A folder of the vault, through a child (a folder has no rule of its own); a whole project's notes stand for the project. */
const folderVia = (map: (rel: string) => string) => (folder: string): string => {
  if (!folder) return folder;
  const to = path.posix.dirname(map(`${folder}/x.md`));
  return to.replace(/^(projects\/[^/]+)\/notes$/, '$1');
};

/** Each settings list through a file map and a folder map: bookmarks are files, search leaves out folders, a replica either (an extension says a file). */
function mapLists(lists: ConfigLists, file: (rel: string) => string, folder: (rel: string) => string): ConfigLists {
  const entry = (e: string): string => (/\.[A-Za-z0-9]{1,12}$/.test(e) ? file(e) : folder(e.replace(/\/+$/, '')));
  return Object.fromEntries(Object.entries(lists).map(([k, list]) => [k, list.map(k === 'favorites' ? file : k === 'search' ? folder : entry)]));
}

const forwardLists = (record: UnifiedRecord, lists: ConfigLists): ConfigLists => {
  // These are the paths before the move: the record's exact entries first (an old folder named like the tree's own included).
  const old = (rel: string): string => mapVaultPath(rel, vaultMapOf(record));
  return mapLists(lists, old, folderVia(old));
};

/** Forward: what names a note by its old path now names its place in the tree; the old places link in. */
const forwardPlaced = (dirs: UnifyDirs, undo = false) => async (pairs: Array<[string, string]>): Promise<void> => {
  let record = (await readUnified(dirs))!;
  // The lists as they were, kept once (a resumed boot finds them): the way back restores them.
  if (!record.configBefore && !undo) { record = { ...record, configBefore: await readConfigLists() }; await writeRecord(dirs, record); }
  const before = record.configBefore ?? {};
  const fwd = forwardLists(record, before);
  const remap = (rel: string): string => movedPath(rel, vaultMapOf(record));
  // A switch: nobody changed the lists while it ran. An undone way back: only a list it had put back whole goes forward again.
  const config = (now: ConfigLists): ConfigLists => (undo
    ? Object.fromEntries(Object.entries(now).map(([k, l]) => [k, before[k] && JSON.stringify(l) === JSON.stringify(before[k]) ? fwd[k]! : l]))
    : fwd);
  const refs = await rewriteNoteRefs({ pairs, fromRoot: dirs.notes, toRoot: dirs.artifacts, remap, config });
  await linkOldPlaces(record).catch((err) => log.memory.warn('one tree: the old places were not linked', { error: String(err) }));
  log.memory.info('one tree: re-pointed what names the notes', { refs });
};

/** Back: the same, the other way. A list nobody changed since the move gets its old value whole. */
const backPlaced = (dirs: UnifyDirs, record: UnifiedRecord) => async (pairs: Array<[string, string]>): Promise<void> => {
  const back = vaultPathBack(record);
  const folder = (f: string): string => folderVia(back)(/^projects\/[^/]+$/.test(f) ? `${f}/notes` : f);
  const before = record.configBefore;
  const config = (now: ConfigLists): ConfigLists => {
    // No lists kept (an undo before the re-pointing ran): they still hold the paths before, as they are.
    if (!before) return now;
    const fwd = forwardLists(record, before);
    const mapped = mapLists(now, back, folder);
    return Object.fromEntries(Object.entries(now).map(([k, list]) => [k, before[k] && JSON.stringify(list) === JSON.stringify(fwd[k]) ? before[k]! : mapped[k]!]));
  };
  const refs = await rewriteNoteRefs({ pairs, fromRoot: dirs.artifacts, toRoot: dirs.notes, remap: back, config });
  await unlinkOldPlaces();
  log.memory.info('one tree: re-pointed what names the notes, back', { refs });
};

const reversed = (record: UnifiedRecord): Array<[string, string]> => pairsOf(record).map(([f, to]) => [to, f]);

/** First thing at boot, before the folders are made: any record means the tree's layout until the boot step settles it. */
export async function applyRecordedLayout(): Promise<void> {
  const record = await readUnified(dirsNow());
  // Not the folders' for an unfinished switch or way back: their boot would make an empty notes/ (init's ensureDir).
  applyLayout(record, []);
}

/** Which layout the disk holds: the tree when live; an unfinished step by where the notes are now. */
async function settledLayout(dirs: UnifyDirs): Promise<UnifiedRecord | null> {
  const record = await readUnified(dirs);
  if (!record || record.state === 'live') return record;
  // An undo that could not finish either: whichever layout holds the notes now.
  return fs.existsSync(dirs.notes) ? null : record;
}

/** The boot step. Answers the layout it left the process on. */
export async function startUnifiedTree(opts: { on: boolean; leader: boolean; tasks: readonly Task[]; projects: readonly string[] }): Promise<'tree' | 'folders'> {
  const dirs = dirsNow();
  try {
    // Only the primary moves files; a replica keeps its copy as the primary sends it.
    if (opts.leader) await bootStep(dirs, opts);
  } catch (err) {
    log.memory.error('one tree: the boot step failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    // Whatever happened above, the process runs on the layout the disk holds, with every task's home.
    applyLayout(await settledLayout(dirs), opts.tasks);
  }
  return (await settledLayout(dirs)) ? 'tree' : 'folders';
}

async function bootStep(dirs: UnifyDirs, opts: { on: boolean; tasks: readonly Task[]; projects: readonly string[] }): Promise<void> {
  let record = await readUnified(dirs);
  // A step a stop cut short is finished first, whichever way it went; one that cannot finish is
  // undone; an undo a stop cut short is finished (never the step it undoes).
  if (record?.state === 'switching') await finishOrAbortSwitch(dirs, record);
  else if (record?.state === 'rolling-back') await finishOrAbortRollback(dirs, record, () => rollbackUnified(dirs, backPlaced(dirs, record!)));
  else if (record?.state === 'aborting-switch') await undoSwitch(dirs, record);
  else if (record?.state === 'aborting-rollback') await undoRollback(dirs, record);
  record = await readUnified(dirs);
  if (record?.state === 'live') await adoptStrayVault(dirs, record).catch((err) => log.memory.warn('one tree: the old vault place was not taken in', { error: String(err) }));
  // An undone step is not tried again at every boot (each try copies the whole vault): a person looks first.
  const stopped = async (file: string): Promise<boolean> => !!(await fsp.lstat(path.join(dirs.artifacts, file)).catch(() => null));
  if (opts.on && !record && (await stopped(ABORTED_FILE))) {
    log.memory.error(`one tree: the last move was undone and is not tried again; remove ${path.join(dirs.artifacts, ABORTED_FILE)} to try again`);
  } else if (!opts.on && record?.state === 'live' && (await stopped(BACK_ABORTED_FILE))) {
    log.memory.error(`one tree: the last way back was undone and is not tried again; remove ${path.join(dirs.artifacts, BACK_ABORTED_FILE)} to try again`);
  } else if (opts.on && !record) {
    try {
      const report = await unifyTree(dirs, { projects: opts.projects, nodes: opts.tasks.map((t) => ({ id: t.id, project: t.project })) }, forwardPlaced(dirs));
      log.memory.info('one tree: notes and artifacts moved in', { ...report });
    } catch (err) {
      log.memory.error('one tree: the move did not run, the notes stay where they were', { error: err instanceof Error ? err.message : String(err) });
      // A failure after the record was written: back to where it began.
      const left = await readUnified(dirs);
      if (left?.state === 'switching' || left?.state === 'aborting-switch') await undoSwitch(dirs, left);
    }
  } else if (!opts.on && record?.state === 'live') {
    // Files first: a way back that fails leaves every record pointing at the tree, still live.
    const live = record;
    await finishOrAbortRollback(dirs, live, async () => {
      const report = await rollbackUnified(dirs, backPlaced(dirs, live));
      log.memory.info('one tree: moved back to the folders before', { ...report });
    });
  }
}

async function undoSwitch(dirs: UnifyDirs, record: UnifiedRecord): Promise<void> {
  await abortSwitch(dirs, record);
  // The re-pointing may have run: point everything at the folders again.
  await backPlaced(dirs, record)(reversed(record)).catch(() => {});
  log.memory.error('one tree: the switch could not finish and was undone; the notes are where they were', { backup: record.backup });
}

async function finishOrAbortSwitch(dirs: UnifyDirs, record: UnifiedRecord): Promise<void> {
  try {
    await finishSwitch(dirs, record, forwardPlaced(dirs));
    log.memory.info('one tree: finished a switch a stop cut short', { backup: record.backup });
  } catch (err) {
    log.memory.error('one tree: a switch a stop cut short did not finish', { error: err instanceof Error ? err.message : String(err) });
    await undoSwitch(dirs, (await readUnified(dirs)) ?? record);
  }
}

/** Where an undone way back leaves its reason: the next boot does not try again until a person removes it. */
const BACK_ABORTED_FILE = '.unify-back-aborted.json';

async function undoRollback(dirs: UnifyDirs, record: UnifiedRecord, why = 'a stop cut the undo short'): Promise<void> {
  await abortRollback(dirs, record);
  await fsp.writeFile(path.join(dirs.artifacts, BACK_ABORTED_FILE), `${JSON.stringify({ at: new Date().toISOString(), why })}\n`);
  await forwardPlaced(dirs, true)(pairsOf(record)).catch(() => {});
  log.memory.error('one tree: the way back was undone; the notes stay in the tree', { kept: record.kept, why });
}

async function finishOrAbortRollback(dirs: UnifyDirs, record: UnifiedRecord, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log.memory.error('one tree: the way back did not finish', { error: why });
    const left = await readUnified(dirs);
    if (left?.state !== 'rolling-back' && left?.state !== 'aborting-rollback') return; // nothing moved yet: still live
    await undoRollback(dirs, left, why);
  }
}

let renames: Promise<void> = Promise.resolve();

/**
 * A project renamed (or merged into another) while the tree is live: its folder takes the new
 * name, the record's map follows (so an old path still lands), and what names its notes too.
 * One at a time. A file the other project already has a file of that name for stays in the old
 * folder, and the record keeps pointing at it there.
 */
export function followProjectRename(from: string, to: string): Promise<void> {
  const run = renames.then(() => renameProjectFolder(from, to));
  renames = run.catch(() => {});
  return run;
}

async function renameProjectFolder(from: string, to: string): Promise<void> {
  const a = projectDirOf(from); const b = projectDirOf(to);
  const dirs = dirsNow();
  const record = await readUnified(dirs);
  if (!a || !b || a === b || record?.state !== 'live') return;
  const src = path.join(dirs.artifacts, a); const dst = path.join(dirs.artifacts, b);
  const files: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
      if (e.isDirectory()) await walk(path.join(dir, e.name), `${rel}/${e.name}`); else files.push(`${rel}/${e.name}`);
    }
  };
  await walk(src, a);
  try {
    if (await fsp.lstat(dst).catch(() => null)) { await mergeInto(src, dst); await fsp.rmdir(src).catch(() => {}); }
    else if (await fsp.lstat(src).catch(() => null)) await fsp.rename(src, dst);
  } catch (err) {
    // Nothing else follows a folder that did not move: the record and the homes still name where its files are.
    log.memory.warn('one tree: a renamed project\'s folder did not follow', { from: a, to: b, error: String(err) });
    return;
  }
  const stayed = new Set<string>();
  for (const f of files) if (await fsp.lstat(path.join(src, f.slice(a.length + 1))).catch(() => null)) stayed.add(f);
  const swap = (p: string): string => (p === a || p.startsWith(`${a}/`) ? b + p.slice(a.length) : p);
  const swapFile = (p: string): string => (stayed.has(p) ? p : swap(p));
  const next: UnifiedRecord = {
    ...record,
    vault: { rules: record.vault.rules.map((r) => ({ ...r, to: swap(r.to) })), exact: Object.fromEntries(Object.entries(record.vault.exact).map(([k, v]) => [k, swapFile(v)])) },
    artifacts: { rules: record.artifacts.rules.map((r) => ({ ...r, to: swap(r.to) })), exact: Object.fromEntries(Object.entries(record.artifacts.exact).map(([k, v]) => [k, swapFile(v)])) },
    moves: record.moves.map(([f, t]) => [f, swapFile(t)] as [string, string]),
  };
  // A file that stayed has no rule left: an exact entry keeps its old path landing there.
  for (const [f, t] of record.moves) if (stayed.has(t) && !f.startsWith('a:')) next.vault.exact[f] = t;
  await writeRecord(dirs, next);
  setNoteMoves(vaultMapOf(next), pairsOf(next));
  renameHomes(a, b);
  const pairs = files.filter((f) => !stayed.has(f)).map((f) => [f, swap(f)] as [string, string]);
  const swapLists = (now: ConfigLists): ConfigLists => Object.fromEntries(Object.entries(now).map(([k, l]) => [k, l.map(swapFile)]));
  await rewriteNoteRefs({ pairs, fromRoot: dirs.artifacts, toRoot: dirs.artifacts, remap: swapFile, config: swapLists });
  if (stayed.size) log.memory.warn('one tree: some files of a renamed project stay in its old folder, the other project has their names', { from: a, to: b, files: stayed.size });
  log.memory.info('one tree: a renamed project\'s folder followed it', { from: a, to: b, files: pairs.length });
}

/** For a person's terminal: where the notes are now. */
export async function unifiedState(): Promise<{ state: 'tree' | 'folders'; record: UnifiedRecord | null; home: string }> {
  const record = await readUnified(dirsNow());
  return { state: record?.state === 'live' ? 'tree' : 'folders', record, home: WALNUT_HOME };
}
