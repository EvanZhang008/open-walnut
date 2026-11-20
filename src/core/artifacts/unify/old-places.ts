/**
 * The places before the one tree answer while it is live, as links into it:
 *
 *   notes/      one link per vault folder that moved whole (notes/walnut -> artifacts/projects/
 *               Walnut/notes), one per file where a folder split (a drawing went to drawings/, its
 *               notes stayed). A path written before the move by anything Walnut cannot rewrite (a
 *               trigger's script, a routine's prompt, a skill, a memory, a message, the person's own
 *               habit) reads and writes the same file. 2026-11-20: the first live move broke a
 *               trigger that read ~/.open-walnut/notes/walnut/reviews.
 *   knowledge/  the artifacts folder's first name (2026-11-19 to 11-20): a task's folder, the org's
 *               skills and the shared notes, so a path a message from those days named still opens.
 *
 * Only links into the tree are ever taken out, and only folders they leave empty go with them: a
 * real file someone writes there stays (in notes/ the boot takes it in, adoptStrayVault).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

interface Dirs { notes: string; artifacts: string }

/** Marks a folder that holds these links (and is no vault or artifacts folder of its own). */
export const LINKS_MARK = '.walnut-links';
/** Under the tree's backups (which no move or way back carries off): Walnut put notes/ in Obsidian's "Excluded files". */
const OBSIDIAN_MARK = path.join('.backup', '.obsidian-notes-excluded');

const insideOrAt = (child: string, root: string): boolean => {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** `file` is a link whose target is the tree or inside it (never a note to take in, never the person's). */
export async function linksIntoTree(dirs: Pick<Dirs, 'artifacts'>, file: string): Promise<boolean> {
  const st = await fsp.lstat(file).catch(() => null);
  if (!st?.isSymbolicLink()) return false;
  return insideOrAt(path.resolve(path.dirname(file), await fsp.readlink(file)), dirs.artifacts);
}

/**
 * Where each old vault place links to, [vault path before, tree path now], from the move's file
 * pairs: a folder whose every file moved by one prefix is one link; a folder that split links its
 * children one by one (a file each, a folder by the same rule). The vault root is never a link.
 */
export function vaultLinkPlan(pairs: ReadonlyArray<readonly [string, string]>): Array<[string, string]> {
  interface Node { files: Map<string, string>; dirs: Map<string, Node> }
  const node = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = node();
  for (const [from, to] of pairs) {
    const segs = from.split('/');
    let n = root;
    for (const s of segs.slice(0, -1)) n = n.dirs.get(s) ?? (n.dirs.set(s, node()), n.dirs.get(s)!);
    n.files.set(segs.at(-1)!, to);
  }
  // The one prefix every file under `n` moved by, or null.
  const prefixOf = (n: Node): string | null => {
    let prefix: string | null | undefined;
    const walk = (m: Node, rel: string): void => {
      for (const [name, to] of m.files) {
        const suffix = rel ? `${rel}/${name}` : name;
        const p = to.endsWith(`/${suffix}`) ? to.slice(0, -(suffix.length + 1)) : null;
        prefix = prefix === undefined || prefix === p ? p : null;
      }
      for (const [name, child] of m.dirs) walk(child, rel ? `${rel}/${name}` : name);
    };
    walk(n, '');
    return prefix ?? null;
  };
  const out: Array<[string, string]> = [];
  const visit = (n: Node, rel: string): void => {
    const p = rel ? prefixOf(n) : null;
    if (p) { out.push([rel, p]); return; }
    for (const [name, to] of n.files) out.push([rel ? `${rel}/${name}` : name, to]);
    for (const [name, child] of n.dirs) visit(child, rel ? `${rel}/${name}` : name);
  };
  visit(root, '');
  return out;
}

/** The links into the tree under `dir` (never following one). */
async function treeLinks(dir: string, artifacts: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const at = path.join(d, e.name);
      if (e.isSymbolicLink()) { if (await linksIntoTree({ artifacts }, at)) out.push(at); }
      else if (e.isDirectory()) await walk(at);
    }
  };
  await walk(dir);
  return out;
}

/** Folders under `dir` (and `dir` itself) with nothing left in them go. */
async function pruneEmpty(dir: string): Promise<boolean> {
  let empty = true;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && (await pruneEmpty(path.join(dir, e.name)))) continue;
    empty = false;
  }
  if (empty) await fsp.rmdir(dir).catch(() => {});
  return empty;
}

/** Only what Finder, an editor or a lock leaves behind: never anything a person would miss. */
async function onlyLeftovers(dir: string): Promise<boolean> {
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && !e.isSymbolicLink()) { if (!(await onlyLeftovers(path.join(dir, e.name)))) return false; }
    else if (!(e.name.startsWith('.') || e.name.endsWith('.lock'))) return false;
  }
  return true;
}

export interface LinkReport { made: number; kept: number; removed: number; blocked: string[]; missing: string[] }

/**
 * Make `dir` hold exactly `want` (link place -> target, both absolute): a stale link into the tree
 * is replaced, a link place held by a folder of leftovers only (.DS_Store, hidden, locks) is cleared
 * into the backups, any other real file or folder there is left and reported `blocked`, a target
 * that is gone is reported `missing`.
 */
async function linkSet(dir: string, artifacts: string, want: Map<string, string>): Promise<LinkReport> {
  const report: LinkReport = { made: 0, kept: 0, removed: 0, blocked: [], missing: [] };
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, LINKS_MARK), 'Links to where these files are now (src/core/artifacts/unify/old-places.ts).\n');
  for (const at of await treeLinks(dir, artifacts)) {
    if (want.get(at) === path.resolve(path.dirname(at), await fsp.readlink(at))) continue;
    await fsp.unlink(at);
    report.removed++;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const [at, target] of want) {
    const rel = path.relative(dir, at);
    const here = await fsp.lstat(at).catch(() => null);
    if (here?.isSymbolicLink() && (await linksIntoTree({ artifacts }, at))) { report.kept++; continue; }
    if (here) {
      if (!here.isDirectory() || here.isSymbolicLink() || !(await onlyLeftovers(at))) { report.blocked.push(rel); continue; }
      const aside = path.join(artifacts, '.backup', `old-place-leftovers-${stamp}`, path.basename(dir), rel);
      await fsp.mkdir(path.dirname(aside), { recursive: true });
      await fsp.rename(at, aside);
    }
    if (!(await fsp.stat(target).catch(() => null))) { report.missing.push(rel); continue; }
    try {
      await fsp.mkdir(path.dirname(at), { recursive: true });
      await fsp.symlink(path.relative(path.dirname(at), target), at);
      report.made++;
    } catch {
      report.blocked.push(rel);
    }
  }
  return report;
}

/** Take the links into the tree out of `dir`, the mark, then the folders they leave empty. Answers how many. */
async function unlinkSet(dir: string, artifacts: string): Promise<number> {
  const st = await fsp.lstat(dir).catch(() => null);
  if (!st?.isDirectory()) return 0;
  const links = await treeLinks(dir, artifacts);
  for (const at of links) await fsp.unlink(at);
  await fsp.rm(path.join(dir, LINKS_MARK), { force: true });
  await pruneEmpty(dir);
  return links.length;
}

/** notes/ as the old vault places' links for these move pairs (every boot on the tree, and after a project rename). */
export async function linkVaultPlaces(dirs: Dirs, pairs: ReadonlyArray<readonly [string, string]>): Promise<LinkReport> {
  const st = await fsp.lstat(dirs.notes).catch(() => null);
  if (st && (st.isSymbolicLink() || !st.isDirectory())) return { made: 0, kept: 0, removed: 0, blocked: ['.'], missing: [] }; // the person's own
  const want = new Map(vaultLinkPlan(pairs).map(([from, to]) => [path.join(dirs.notes, from), path.join(dirs.artifacts, to)]));
  const report = await linkSet(dirs.notes, dirs.artifacts, want);
  await obsidianExcludesNotes(dirs, true);
  return report;
}

/**
 * The vault links out, and Obsidian's entry with them: the way back, just before the notes come
 * home (every link into the tree goes, mark or not); a fresh switch (`onlyMarked`: only a notes/ the
 * links' mark names, so a person's own link into artifacts/ moves with the vault as before).
 */
export async function unlinkVaultPlaces(dirs: Dirs, opts: { onlyMarked?: boolean } = {}): Promise<number> {
  if (opts.onlyMarked && !(await fsp.lstat(path.join(dirs.notes, LINKS_MARK)).catch(() => null))) return 0;
  const n = await unlinkSet(dirs.notes, dirs.artifacts);
  await obsidianExcludesNotes(dirs, false);
  return n;
}

/** knowledge/ as links to a task's folder, the org's skills and the shared notes, from the record's artifact moves. */
export async function linkKnowledgePlaces(knowledge: string, artifacts: string, moves: ReadonlyArray<readonly [string, string]>): Promise<LinkReport | null> {
  const st = await fsp.lstat(knowledge).catch(() => null);
  if (st?.isSymbolicLink()) await fsp.unlink(knowledge);
  else if (st && !(await fsp.lstat(path.join(knowledge, LINKS_MARK)).catch(() => null))) return null; // a real folder someone else made: left alone
  const want = new Map<string, string>();
  for (const [from, to] of moves) {
    const m = /^a:nodes\/([^/]+)\/MEMORY\.md$/.exec(from) ?? /^a:nodes\/([^/]+)\/(?:notes|reflections)\//.exec(from);
    const at = m && path.join(knowledge, 'nodes', m[1]!);
    if (at && !want.has(at)) want.set(at, path.join(artifacts, to.replace(/\/(MEMORY\.md|notes\/.*|reflections\/.*)$/, '')));
  }
  want.set(path.join(knowledge, 'org', 'skills'), path.join(artifacts, 'skills'));
  want.set(path.join(knowledge, 'shared', 'notes'), path.join(artifacts, 'memory', '_shared', 'notes'));
  return linkSet(knowledge, artifacts, want);
}

/** knowledge/'s links out; a real file an older writer left there stays. */
export async function unlinkKnowledgePlaces(knowledge: string, artifacts: string): Promise<number> {
  if (!(await fsp.lstat(path.join(knowledge, LINKS_MARK)).catch(() => null))) return 0;
  return unlinkSet(knowledge, artifacts);
}

/**
 * An Obsidian vault opened on the whole Walnut home would list every note twice while the links
 * stand (the tree, and notes/ through them): its own "Excluded files" setting leaves notes/ out.
 * Walnut adds the entry only when it is not there, marks in the tree that it did, and takes out
 * only an entry it added, at the way back and again at the next start on the folders (Obsidian,
 * running, may write its old list back). Only when the vault's settings file is there.
 */
export async function obsidianExcludesNotes(dirs: Dirs, on: boolean): Promise<void> {
  const file = path.join(path.dirname(dirs.notes), '.obsidian', 'app.json');
  const mark = path.join(dirs.artifacts, OBSIDIAN_MARK);
  const ours = !!(await fsp.lstat(mark).catch(() => null));
  if (!on && !ours) return;
  const text = await fsp.readFile(file, 'utf-8').catch(() => null);
  let app: Record<string, unknown> | null = null;
  try { app = text === null ? null : (JSON.parse(text) as Record<string, unknown>); } catch { app = null; }
  if (!app) { if (!on) await fsp.rm(mark, { force: true }); return; }
  const list = Array.isArray(app.userIgnoreFilters) ? (app.userIgnoreFilters as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const has = list.includes('notes/');
  // On: an entry already there is ours (marked) or the person's own; either way nothing to write.
  if (on && has) return;
  if (on || has) {
    const tmp = `${file}.walnut-${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify({ ...app, userIgnoreFilters: on ? [...list, 'notes/'] : list.filter((x) => x !== 'notes/') }, null, 2)}\n`);
    await fsp.rename(tmp, file);
  }
  // Off keeps the mark one start longer: a running Obsidian may write its old list back once.
  if (on) { await fsp.mkdir(path.dirname(mark), { recursive: true }); await fsp.writeFile(mark, 'Walnut added notes/ to Obsidian\'s Excluded files (src/core/artifacts/unify/old-places.ts).\n'); }
  else if (!has) await fsp.rm(mark, { force: true });
}
