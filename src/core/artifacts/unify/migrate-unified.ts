/**
 * The move into one tree by project (layout.ts), on disk. Run at boot, before anything reads or
 * writes notes, only while the `notes_unified` switch is on; the switch off rolls it back the
 * same way. The user's notes are his own data, so (his lead's terms):
 *
 *   1. a shadow: the new tree is built beside the live one, `artifacts/.unify-stage/`, each file a
 *      clone of its old one (APFS shares the blocks, so 4.8 GB costs next to nothing; a disk that
 *      cannot clone copies);
 *   2. the check: every file of the shadow holds exactly the bytes of the file it came from (a
 *      hash each), and every old file is in it once. One miss and nothing switches;
 *   3. the switch: the old `notes/` and the artifacts folder's old layout (nodes/, org/, shared/)
 *      move whole into `artifacts/.backup/<stamp>/` (untouched: that is the backup), the shadow
 *      moves into place, and `.unified.json` records every move;
 *   4. the way back (rollbackUnified): every file goes back where `.unified.json` says it came
 *      from; one made since goes back by the folder rules; the tree of the move moves to the backups.
 *
 * Contents are never rewritten: a note's relative links resolve from where it used to be
 * (`mapPath` on the old path), so the check is a byte check and Obsidian's [[links]] stay as typed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { log } from '../../../logging/index.js';
import { artifactRules, invertMap, mapPath, mapVaultPath, numbered, planArtifacts, planVault, TREE_TOP_NAMES, vaultRules, type MoveMap, type MoveRule } from './layout.js';

export const UNIFIED_FILE = '.unified.json';
export const STAGE = '.unify-stage';
/** What the artifacts folder held by task id before; the rest of it (.backup, the marker) stays. */
export const OLD_ARTIFACT_DIRS = ['nodes', 'org', 'shared'];
/** Where an undone switch leaves its record: the next boot does not try again until a person removes it. */
export const ABORTED_FILE = '.unify-aborted.json';

export interface UnifiedRecord {
  version: 1;
  /**
   * 'switching' from the record until the shadow is all in place, 'rolling-back' from the way
   * back's record until the folders before are all in place: a boot that finds either finishes it.
   */
  state: 'switching' | 'live' | 'rolling-back' | 'aborting-switch' | 'aborting-rollback';
  /** An undo's own place for what it sets aside (artifacts-relative), kept so a resumed undo finds it. */
  aside?: string;
  at: string;
  /** When the files were listed (ms): one written after it is taken again from the backup. */
  listedAt?: number;
  /** artifacts-relative: the untouched old trees */
  backup: string;
  vault: { rules: MoveRule[]; exact: Record<string, string> };
  artifacts: { rules: MoveRule[]; exact: Record<string, string> };
  /** every file the move made: [old, new], vault paths first, then artifacts paths ("a:" prefix) */
  moves: Array<[string, string]>;
  /** The way back's: where the tree goes (artifacts-relative), and its top folders. */
  kept?: string;
  tops?: string[];
  /** The settings lists that name notes, as they were before the move (refs.ts): the way back restores them. */
  configBefore?: Record<string, string[]>;
}

export interface UnifyDirs { notes: string; artifacts: string }
export interface UnifyInput { projects: readonly string[]; nodes: ReadonlyArray<{ id: string; project: string | null | undefined }> }
export interface UnifyReport { moved: number; vault: number; artifacts: number; backup: string; ms: number; late: number }
/** Run once the files are in place and before the record says so: re-point what names them (pairs: vault path before, after). */
export type Placed = (pairs: Array<[string, string]>) => Promise<void>;

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');
const exists = (p: string): Promise<boolean> => fsp.lstat(p).then(() => true, () => false);

async function filesUnder(root: string, skip: (rel: string) => boolean = () => false): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip(r) || e.name === '.DS_Store') continue;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      // A link moves as a link (never followed): the user's own links come along, pointing where they did.
      else if (e.isFile() || e.isSymbolicLink()) out.push(r);
    }
  };
  await walk(root, '');
  return out;
}

async function hashOf(file: string): Promise<string> {
  const st = await fsp.lstat(file);
  if (st.isSymbolicLink()) return `link:${await fsp.readlink(file)}`;
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function cloneFile(from: string, to: string): Promise<void> {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  // A link already at the destination is replaced, never written through (its target is the user's file).
  if ((await fsp.lstat(to).catch(() => null))?.isSymbolicLink()) await fsp.rm(to, { force: true });
  if ((await fsp.lstat(from)).isSymbolicLink()) { await fsp.rm(to, { force: true }); await fsp.symlink(await fsp.readlink(from), to); return; }
  // FICLONE: a copy-on-write clone where the disk can (APFS, btrfs), a plain copy where it cannot.
  await fsp.copyFile(from, to, fs.constants.COPYFILE_FICLONE);
  const st = await fsp.stat(from);
  await fsp.utimes(to, st.atime, st.mtime);
}

export async function readUnified(dirs: UnifyDirs): Promise<UnifiedRecord | null> {
  try { return JSON.parse(await fsp.readFile(path.join(dirs.artifacts, UNIFIED_FILE), 'utf-8')) as UnifiedRecord; } catch { return null; }
}

/** The forward map of a record: an old vault path (relative to notes/) to its path in the tree. */
export const vaultMapOf = (r: UnifiedRecord): MoveMap => ({ exact: r.vault.exact, rules: r.vault.rules });
const artifactsMapOf = (r: UnifiedRecord): MoveMap => ({ exact: r.artifacts.exact, rules: r.artifacts.rules });

/** Build, check and switch. Throws (with nothing switched) when the check fails. */
export async function unifyTree(dirs: UnifyDirs, input: UnifyInput, placed?: Placed): Promise<UnifyReport> {
  const t0 = Date.now();
  if (await readUnified(dirs)) throw new Error('already in one tree');
  // A vault that is a link (to a synced folder) stays where it is: the move would leave that folder.
  if ((await fsp.lstat(dirs.notes).catch(() => null))?.isSymbolicLink()) throw new Error(`the notes folder is a link (${dirs.notes}): left where it is`);
  const listedAt = Date.now();
  const vaultFiles = await filesUnder(dirs.notes);
  const isOldArtifact = (rel: string): boolean => OLD_ARTIFACT_DIRS.includes(rel.split('/')[0]!);
  const artifactFiles = (await filesUnder(dirs.artifacts, (r) => r === STAGE || r === '.backup' || r.endsWith('.lock'))).filter(isOldArtifact);

  const top = [...new Set(vaultFiles.filter((f) => f.includes('/')).map((f) => f.split('/')[0]!))];
  const projectsFolders = [...new Set(vaultFiles.filter((f) => /^Projects\/[^/]+\//.test(f)).map((f) => f.split('/')[1]!))];
  const vRules = vaultRules({ topFolders: top, projectsFolders, projects: input.projects });
  const vPlan = planVault(vaultFiles, vRules);
  const aRules = artifactRules(input.nodes);
  const aPlan = planArtifacts(artifactFiles, aRules);

  // One new path, one file: a vault file and an artifact never land on one name.
  const taken = new Map<string, string>();
  for (const [from, to] of [...vPlan.moves.map(([f, t]) => [`v:${f}`, t] as const), ...aPlan.moves.map(([f, t]) => [`a:${f}`, t] as const)]) {
    const k = to.toLowerCase();
    if (taken.has(k)) throw new Error(`two files would land on ${to}: ${taken.get(k)} and ${from}`);
    taken.set(k, from);
  }

  // 1. The shadow.
  const stage = path.join(dirs.artifacts, STAGE);
  await fsp.rm(stage, { recursive: true, force: true });
  const all: Array<{ from: string; to: string }> = [
    ...vPlan.moves.map(([f, t]) => ({ from: path.join(dirs.notes, f), to: path.join(stage, t) })),
    ...aPlan.moves.map(([f, t]) => ({ from: path.join(dirs.artifacts, f), to: path.join(stage, t) })),
  ];
  for (const m of all) await cloneFile(m.from, m.to);

  // 2. The check: the same bytes, every file once, nothing else in the shadow.
  const bad: string[] = [];
  for (const m of all) if ((await hashOf(m.from)) !== (await hashOf(m.to))) bad.push(m.from);
  const staged = await filesUnder(stage);
  if (staged.length !== all.length) bad.push(`the shadow holds ${staged.length} files, the move ${all.length}`);
  if (bad.length) {
    await fsp.rm(stage, { recursive: true, force: true });
    throw new Error(`the shadow does not match: ${bad.slice(0, 5).join('; ')}${bad.length > 5 ? ` (+${bad.length - 5})` : ''}`);
  }

  // 3. The switch, recorded first: a crash part way leaves 'switching', and the next boot finishes it.
  const backupRel = path.join('.backup', `unify-${stamp()}`);
  const record: UnifiedRecord = {
    version: 1, state: 'switching', at: new Date().toISOString(), listedAt, backup: backupRel,
    vault: { rules: vRules, exact: vPlan.exact }, artifacts: { rules: aRules, exact: aPlan.exact },
    moves: [...vPlan.moves, ...aPlan.moves.map(([f, t]) => [`a:${f}`, t] as [string, string])],
  };
  await writeRecord(dirs, record);
  const late = await finishSwitch(dirs, record, placed);
  return { moved: all.length, vault: vPlan.moves.length, artifacts: aPlan.moves.length, backup: backupRel, ms: Date.now() - t0, late };
}

/**
 * The renames of the switch, each done once whatever ran before: the old trees out, the shadow
 * in, then what was written to the old places after they were listed. Answers how many such
 * late files it took.
 */
export async function finishSwitch(dirs: UnifyDirs, record: UnifiedRecord, placed?: Placed): Promise<number> {
  const backup = path.join(dirs.artifacts, record.backup);
  const stage = path.join(dirs.artifacts, STAGE);
  await fsp.mkdir(path.join(backup, 'artifacts'), { recursive: true });
  if (await exists(dirs.notes)) {
    // A notes/ made again after the first rename (a boot that a stop cut short, a writer): it goes
    // beside the backup, and its files are taken in below like any late write.
    const to = (await exists(path.join(backup, 'notes'))) ? path.join(backup, `notes-after-${stamp()}`) : path.join(backup, 'notes');
    await fsp.rename(dirs.notes, to);
  }
  for (const d of OLD_ARTIFACT_DIRS) {
    const from = path.join(dirs.artifacts, d);
    if (!(await exists(from))) continue;
    const to = (await exists(path.join(backup, 'artifacts', d))) ? path.join(backup, `artifacts-after-${stamp()}`, d) : path.join(backup, 'artifacts', d);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
  }
  for (const name of await fsp.readdir(stage).catch(() => [] as string[])) {
    const to = path.join(dirs.artifacts, name);
    // A folder the root already has (a crash after part of it moved): its files go in one by one.
    if (await exists(to)) await mergeInto(path.join(stage, name), to);
    else await fsp.rename(path.join(stage, name), to);
  }
  await keepLeftovers(stage, path.join(backup, 'stage-leftovers'));
  const late = await takeLate(dirs, record);
  if (placed) await placed(record.moves.filter(([f]) => !f.startsWith('a:')));
  // The record as it is now: the re-pointing may have added to it (configBefore).
  await writeRecord(dirs, { ...((await readUnified(dirs)) ?? record), state: 'live' });
  return late;
}

/**
 * What reached the old places after they were listed (an agent's write, Obsidian, a sync) is in
 * the backup only: put it in the tree where the map says, the newer content over the clone. One
 * whose place holds another file stays in the backup, and the log says so.
 */
async function takeLate(dirs: UnifyDirs, record: UnifiedRecord): Promise<number> {
  const since = record.listedAt ?? Date.parse(record.at);
  const backup = path.join(dirs.artifacts, record.backup);
  const moved = new Map(record.moves);
  let n = 0;
  const take = async (root: string, place: (rel: string) => string, key: (rel: string) => string): Promise<void> => {
    for (const rel of await filesUnder(root, (r) => r.endsWith('.lock'))) {
      const from = path.join(root, rel);
      const st = await fsp.lstat(from);
      const known = moved.get(key(rel));
      if (known && st.mtimeMs <= since) continue;
      const to = path.join(dirs.artifacts, known ?? place(rel));
      const there = await fsp.lstat(to).catch(() => null);
      if (!known && there) { log.memory.warn('one tree: a late file stays in the backup, its place is taken', { file: from }); continue; }
      // The tree's copy keeps the source's time when cloned: one edited in the tree since is newer, and stays.
      if (there && there.mtimeMs >= st.mtimeMs) continue;
      await cloneFile(from, to);
      n++;
    }
  };
  for (const name of await fsp.readdir(backup).catch(() => [] as string[])) {
    if (name === 'notes' || name.startsWith('notes-after-')) await take(path.join(backup, name), (r) => mapVaultPath(r, vaultMapOf(record)), (r) => r);
    if (name === 'artifacts' || name.startsWith('artifacts-after-')) await take(path.join(backup, name), (r) => mapPath(r, artifactsMapOf(record)), (r) => `a:${r}`);
  }
  return n;
}

/** Move a tree's files into another, each only where that one has none. */
export async function mergeInto(from: string, to: string): Promise<void> {
  for (const e of await fsp.readdir(from, { withFileTypes: true })) {
    const a = path.join(from, e.name); const b = path.join(to, e.name);
    if (e.isDirectory() && (await exists(b))) await mergeInto(a, b);
    else if (!(await exists(b))) await fsp.rename(a, b);
  }
}

/** Whatever a merge could not place stays, in the backups: never deleted. */
async function keepLeftovers(stage: string, to: string): Promise<void> {
  if ((await filesUnder(stage)).length) { await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.rename(stage, `${to}-${stamp()}`); }
  else await fsp.rm(stage, { recursive: true, force: true });
}

export async function writeRecord(dirs: UnifyDirs, record: UnifiedRecord): Promise<void> {
  const file = path.join(dirs.artifacts, UNIFIED_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  const fh = await fsp.open(tmp, 'w');
  try { await fh.writeFile(`${JSON.stringify(record)}\n`); await fh.sync(); } finally { await fh.close(); }
  await fsp.rename(tmp, file);
}

export interface RollbackReport { restored: number; madeSince: number; kept: string; ms: number }

/** Where a file of the tree goes back: the record's exact entry, else by its folder, a project made since included. */
function backPlanner(record: UnifiedRecord): (rel: string) => { art: boolean; to: string } {
  const vaultMoves = record.moves.filter(([f]) => !f.startsWith('a:'));
  const artMoves = record.moves.filter(([f]) => f.startsWith('a:')).map(([f, t]) => [f.slice(2), t] as [string, string]);
  const vBack = invertMap(vaultMapOf(record), vaultMoves);
  // A drawing made since goes back where the release before puts drawings: inbox/, or its project's Projects/ folder.
  const drawingBack: MoveRule[] = [{ from: 'drawings/', to: 'inbox/' }];
  for (const r of record.vault.rules) {
    const m = /^(projects\/[^/]+)\/notes\/$/.exec(r.to);
    if (m && r.from.startsWith('Projects/')) drawingBack.push({ from: `${m[1]}/drawings/`, to: r.from });
  }
  vBack.rules = [...drawingBack, ...vBack.rules].sort((a, b) => b.from.length - a.from.length);
  const aBack = invertMap(artifactsMapOf(record), artMoves);
  const fromArt = new Set(artMoves.map(([, t]) => t));
  const fromVault = new Set(vaultMoves.map(([, t]) => t));
  return (rel) => {
    if (fromArt.has(rel)) return { art: true, to: aBack.exact[rel]! };
    if (fromVault.has(rel)) return { art: false, to: vBack.exact[rel]! };
    // Made since: a task's memory folder goes to its nodes/ folder whichever project holds it
    // (a task made or moved after the switch has no rule); the shared notes to shared/notes/.
    const mem = /^(?:projects\/[^/]+\/)?memory\/([^/]+)\/(.*)$/.exec(rel);
    if (mem) return { art: true, to: mem[1] === '_shared' ? `shared/${mem[2]}` : `nodes/${mem[1]}/${mem[2]}` };
    if (/^(?:projects\/[^/]+\/)?skills\//.test(rel)) return { art: true, to: mapPath(rel, aBack) };
    // The artifacts folder's own old layout, made in the tree by a writer that still used it.
    if (/^(nodes|org|shared)\//.test(rel)) return { art: true, to: rel };
    const proj = /^projects\/([^/]+)\/(notes|drawings)\/(.*)$/.exec(rel);
    if (proj && mapPath(rel, vBack) === rel) return { art: false, to: `Projects/${proj[1]}/${proj[3]}` };
    return { art: false, to: mapPath(rel, vBack) };
  };
}

/** An old-or-tree vault path to its place in the folders before (refs on the way back; an old one stays). */
export function vaultPathBack(record: UnifiedRecord): (rel: string) => string {
  const back = backPlanner(record);
  return (rel) => { const b = back(rel); return b.art ? rel : b.to; };
}

/**
 * Back to the folders before: every file of the tree goes where it came from (or, made since, by
 * its folder), checked by hash like the move. Recorded first ('rolling-back'), so a stop part way
 * is finished at the next boot; the tree as it was moves whole to the backups, so nothing is lost.
 */
export async function rollbackUnified(dirs: UnifyDirs, placed?: Placed): Promise<RollbackReport> {
  const t0 = Date.now();
  const record = await readUnified(dirs);
  if (!record) throw new Error('not in one tree');
  if (record.state === 'rolling-back') {
    const pairs = record.moves.filter(([f]) => !f.startsWith('a:')).map(([f, to]) => [to, f] as [string, string]);
    return { ...(await finishRollback(dirs, record, placed, pairs)), ms: Date.now() - t0 };
  }
  const back = backPlanner(record);
  const live = await filesUnder(dirs.artifacts, (r) => r === '.backup' || r === STAGE || r === UNIFIED_FILE || r.startsWith(`${UNIFIED_FILE}.tmp`) || r.endsWith('.lock') || r === '.moved.json');
  const stage = path.join(dirs.artifacts, STAGE);
  await fsp.rm(stage, { recursive: true, force: true });
  const movedSince = new Set(record.moves.map(([, t]) => t));
  let madeSince = 0;
  const plan: Array<{ rel: string; to: string }> = live.map((rel) => {
    const b = back(rel);
    if (!movedSince.has(rel)) madeSince++;
    return { rel, to: path.join(stage, b.art ? 'artifacts' : 'notes', b.to) };
  });
  // Two files going back to one place (a merge's leftovers): the file the move made keeps its
  // name, one made since is numbered, never refused.
  plan.sort((x, y) => Number(!movedSince.has(x.rel)) - Number(!movedSince.has(y.rel)));
  const seen = new Set<string>();
  for (const p of plan) {
    let to = p.to;
    for (let n = 2; seen.has(to.toLowerCase()); n++) to = numbered(p.to, n);
    if (to !== p.to) log.memory.warn('one tree: two files go back to one place, the later is numbered', { file: p.rel, to });
    p.to = to;
    seen.add(to.toLowerCase());
  }
  for (const p of plan) await cloneFile(path.join(dirs.artifacts, p.rel), p.to);
  for (const p of plan) {
    if ((await hashOf(path.join(dirs.artifacts, p.rel))) !== (await hashOf(p.to))) { await fsp.rm(stage, { recursive: true, force: true }); throw new Error(`roll back copy differs: ${p.rel}`); }
  }
  const tops = [...new Set(live.map((r) => r.split('/')[0]!))];
  const next: UnifiedRecord = { ...record, state: 'rolling-back', kept: path.join('.backup', `unified-tree-${stamp()}`), tops };
  await writeRecord(dirs, next);
  const pairs = plan.filter((p) => p.to.startsWith(path.join(stage, 'notes') + path.sep)).map((p) => [p.rel, path.relative(path.join(stage, 'notes'), p.to).split(path.sep).join('/')] as [string, string]);
  const report = await finishRollback(dirs, next, placed, pairs);
  return { ...report, restored: plan.length, madeSince, ms: Date.now() - t0 };
}

/** The renames of the way back, each done once whatever ran before. */
async function finishRollback(dirs: UnifyDirs, record: UnifiedRecord, placed: Placed | undefined, pairs: Array<[string, string]>): Promise<RollbackReport> {
  const stage = path.join(dirs.artifacts, STAGE);
  const keptRel = record.kept ?? path.join('.backup', `unified-tree-${stamp()}`);
  const kept = path.join(dirs.artifacts, keptRel);
  await fsp.mkdir(kept, { recursive: true });
  // The tree out (the stage's own artifacts folders are not its: nodes/, org/, shared/ go in below).
  for (const name of record.tops ?? []) {
    const from = path.join(dirs.artifacts, name);
    if (!(await exists(from))) continue;
    if (await exists(path.join(kept, name))) { await mergeInto(from, path.join(kept, name)); await keepLeftovers(from, path.join(kept, `${name}-leftovers`)); }
    else await fsp.rename(from, path.join(kept, name));
  }
  // The folders before in. A notes/ something made meanwhile (an older release, a writer) goes
  // beside the kept tree, and its files that the vault lacks come back in.
  let found: string | null = null;
  if (await exists(path.join(stage, 'notes'))) {
    if (await exists(dirs.notes)) { found = path.join(kept, `notes-found-${stamp()}`); await fsp.rename(dirs.notes, found); }
    await fsp.rename(path.join(stage, 'notes'), dirs.notes);
  } else if (!(await exists(dirs.notes))) await fsp.mkdir(dirs.notes, { recursive: true });
  if (found) {
    for (const rel of await filesUnder(found)) if (!(await exists(path.join(dirs.notes, rel)))) await cloneFile(path.join(found, rel), path.join(dirs.notes, rel));
  }
  for (const name of await fsp.readdir(path.join(stage, 'artifacts')).catch(() => [] as string[])) {
    const to = path.join(dirs.artifacts, name);
    if (await exists(to)) await mergeInto(path.join(stage, 'artifacts', name), to);
    else await fsp.rename(path.join(stage, 'artifacts', name), to);
  }
  await keepLeftovers(stage, path.join(kept, 'stage-leftovers'));
  if (placed) await placed(pairs);
  // Last: the record goes with the tree, so only now does the next boot read the folders before.
  await fsp.rename(path.join(dirs.artifacts, UNIFIED_FILE), path.join(kept, UNIFIED_FILE));
  return { restored: 0, madeSince: 0, kept: keptRel, ms: 0 };
}

/**
 * Files in the old vault's place while the tree is live (an agent's write to the old absolute
 * path, a script): each goes into the tree where the map says, over a copy there only when it is
 * newer (the one it replaces is kept), and the folder moves into the backups. Answers how many.
 */
export async function adoptStrayVault(dirs: UnifyDirs, record: UnifiedRecord): Promise<number> {
  if (!(await exists(dirs.notes)) || (await fsp.lstat(dirs.notes)).isSymbolicLink()) return 0;
  const at = stamp();
  const replaced = path.join(dirs.artifacts, '.backup', `stray-replaced-${at}`);
  let n = 0;
  // Hidden files (an editor's own settings it made again) are not notes: they stay where they are.
  // Nor is a link into the tree (a later release links the old places to it): taking one in would
  // put a link where the note is.
  const files: string[] = [];
  for (const rel of await filesUnder(dirs.notes, (r) => r.endsWith('.lock') || r.split('/').some((s) => s.startsWith('.')))) {
    if (!(await linksIntoTree(dirs, path.join(dirs.notes, rel)))) files.push(rel);
  }
  if (!files.length) return 0;
  for (const rel of files) {
    const from = path.join(dirs.notes, rel);
    const place = mapVaultPath(rel, vaultMapOf(record));
    const to = path.join(dirs.artifacts, place);
    const there = await fsp.lstat(to).catch(() => null);
    if (there && there.mtimeMs >= (await fsp.lstat(from)).mtimeMs) continue;
    if (there) await cloneFile(to, path.join(replaced, place));
    await cloneFile(from, to);
    n++;
  }
  await fsp.mkdir(path.join(dirs.artifacts, '.backup'), { recursive: true });
  await fsp.rename(dirs.notes, path.join(dirs.artifacts, '.backup', `notes-stray-${at}`));
  if (n) log.memory.info('one tree: took in files written to the old vault place', { files: n });
  return n;
}

/** `file` is a link whose target is the tree or inside it (a link into the tree is never a note to take in). */
export async function linksIntoTree(dirs: UnifyDirs, file: string): Promise<boolean> {
  const st = await fsp.lstat(file).catch(() => null);
  if (!st?.isSymbolicLink()) return false;
  const rel = path.relative(dirs.artifacts, path.resolve(path.dirname(file), await fsp.readlink(file)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Merge the files of `from` that `into` lacks (an undo's late writes); the rest stay where they are. */
async function addMissing(from: string, into: string): Promise<void> {
  for (const rel of await filesUnder(from)) if (!(await exists(path.join(into, rel)))) await cloneFile(path.join(from, rel), path.join(into, rel));
}

/**
 * A switch that cannot finish goes back to exactly where it began: the old trees out of the
 * backup (late writes into them too), what came in from the shadow into the backups beside them,
 * and the record to ABORTED_FILE, so the next boot does not copy the whole vault again until a
 * person looks. Recorded first ('aborting-switch'): a stop part way resumes the undo, never the switch.
 */
export async function abortSwitch(dirs: UnifyDirs, record: UnifiedRecord): Promise<void> {
  const rec: UnifiedRecord = record.state === 'aborting-switch' && record.aside ? record
    : { ...record, state: 'aborting-switch', aside: path.join(record.backup, `aborted-tree-${stamp()}`) };
  if (rec !== record) await writeRecord(dirs, rec);
  const backup = path.join(dirs.artifacts, rec.backup);
  const aside = path.join(dirs.artifacts, rec.aside!);
  await fsp.mkdir(aside, { recursive: true });
  for (const name of TREE_TOP_NAMES) {
    const from = path.join(dirs.artifacts, name);
    if (!(await exists(from))) continue;
    if (await exists(path.join(aside, name))) { await mergeInto(from, path.join(aside, name)); await keepLeftovers(from, path.join(aside, `${name}-leftovers`)); }
    else await fsp.rename(from, path.join(aside, name));
  }
  const stage = path.join(dirs.artifacts, STAGE);
  if (await exists(stage)) await keepLeftovers(stage, path.join(aside, 'stage'));
  if (await exists(path.join(backup, 'notes'))) {
    if (await exists(dirs.notes)) await fsp.rename(dirs.notes, path.join(backup, `notes-after-${stamp()}`));
    await fsp.rename(path.join(backup, 'notes'), dirs.notes);
  }
  for (const d of OLD_ARTIFACT_DIRS) {
    const from = path.join(backup, 'artifacts', d);
    if ((await exists(from)) && !(await exists(path.join(dirs.artifacts, d)))) await fsp.rename(from, path.join(dirs.artifacts, d));
  }
  // What reached the old places while the switch ran is in the backup's late folders: what the vault lacks comes back.
  for (const name of await fsp.readdir(backup).catch(() => [] as string[])) {
    if (name.startsWith('notes-after-')) await addMissing(path.join(backup, name), dirs.notes);
    if (name.startsWith('artifacts-after-')) await addMissing(path.join(backup, name), dirs.artifacts);
  }
  await fsp.rename(path.join(dirs.artifacts, UNIFIED_FILE), path.join(dirs.artifacts, ABORTED_FILE));
}

/**
 * A way back that cannot finish returns to the live tree: its folders back from the kept place,
 * the copies already placed aside, the record live again. Recorded first ('aborting-rollback').
 */
export async function abortRollback(dirs: UnifyDirs, record: UnifiedRecord): Promise<void> {
  const live = (): UnifiedRecord => ({ ...record, state: 'live', kept: undefined, tops: undefined, aside: undefined });
  if (!record.kept || !(await exists(path.join(dirs.artifacts, record.kept)))) { await writeRecord(dirs, live()); return; }
  const rec: UnifiedRecord = record.state === 'aborting-rollback' && record.aside ? record
    : { ...record, state: 'aborting-rollback', aside: path.join(record.kept, `aborted-${stamp()}`) };
  if (rec !== record) await writeRecord(dirs, rec);
  const kept = path.join(dirs.artifacts, rec.kept!);
  const aside = path.join(dirs.artifacts, rec.aside!);
  await fsp.mkdir(aside, { recursive: true });
  // The tree comes back first: until it is whole, nothing it holds is touched.
  for (const name of rec.tops ?? []) {
    const from = path.join(kept, name);
    if ((await exists(from)) && !(await exists(path.join(dirs.artifacts, name)))) await fsp.rename(from, path.join(dirs.artifacts, name));
  }
  // The copies the way back already put in place go aside (the tree holds the same files).
  for (const d of OLD_ARTIFACT_DIRS) {
    const at = path.join(dirs.artifacts, d);
    // A top of the tree by that name (made in it by an old writer) just came back: it is no copy.
    if ((rec.tops ?? []).includes(d)) continue;
    if ((await exists(at)) && !(await exists(path.join(aside, d)))) await fsp.rename(at, path.join(aside, d));
  }
  if ((await exists(dirs.notes)) && !(await exists(path.join(aside, 'notes')))) await fsp.rename(dirs.notes, path.join(aside, 'notes'));
  // A notes/ something had made meanwhile is the old place again: the next boot takes it in.
  for (const name of await fsp.readdir(kept).catch(() => [] as string[])) {
    if (name.startsWith('notes-found-') && !(await exists(dirs.notes))) await fsp.rename(path.join(kept, name), dirs.notes);
  }
  await writeRecord(dirs, { ...rec, state: 'live', kept: undefined, tops: undefined, aside: undefined });
}
