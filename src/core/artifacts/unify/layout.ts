/**
 * One tree for the user's notes and Walnut's artifacts, by project (2026-11-20, the user: "can we
 * unified the note and the artifacts? ... I want all the artifact need for a project inlcude
 * drawaing wthat ever, is stored here"; the names his lead picked when he asked for advice, and he
 * agreed: "ok, sounds good."):
 *
 *   artifacts/projects/<project>/notes/      his notes of that project
 *   artifacts/projects/<project>/skills/     the skills of its tasks
 *   artifacts/projects/<project>/memory/<taskId>/   a task's MEMORY.md, notes, guidance, reflections
 *   artifacts/projects/<project>/drawings/   its tasks' drawings
 *   artifacts/{notes,skills,memory,drawings}/      what belongs to no project (the org's skills too)
 *
 * This module is the move as pure rules: which old place goes where. A vault path ("work/x.md",
 * relative to the old notes folder) and an artifacts path ("nodes/<id>/MEMORY.md", relative to the
 * artifacts folder before the move) each map to a path relative to the artifacts folder after it.
 * The rules are folder prefixes, so a path the move never listed (a note an offline host writes
 * later, a link in a message) maps the same way; a file the move had to rename (two old places,
 * one new name) is an exact entry ahead of them. The disk side is in migrate-notes.ts.
 */
import { isInboxProject } from '../../inbox-project.js';
import { projectFolderName, TRACKING_NOTE_DIR } from '../../tracking-note.js';
import { drawingTarget, isDrawingFile, mapPath, mapVaultPath, matchRule, movedPath, TREE_TOP_NAMES, type MoveMap, type MoveRule } from './map.js';

export { drawingTarget, isDrawingFile, mapPath, mapVaultPath, matchRule, movedPath, TREE_TOP_NAMES, type MoveMap, type MoveRule };

export const TREE_PROJECTS_DIR = 'projects';
export const SHARED_MEMORY_KEY = '_shared';

/**
 * A project's folder in the tree, `projects/<folded name>`; null for the Inbox (`Inbox`, or the
 * '' older data still says: its tasks live at the tree's root) and a name that cannot be a folder.
 */
export function projectDirOf(project: string | null | undefined): string | null {
  const folded = isInboxProject(project) ? null : projectFolderName(project!);
  return folded ? `${TREE_PROJECTS_DIR}/${folded}` : null;
}



/** Byte order, never the locale's: the same plan on every machine. */
const byBytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortRules = (rules: MoveRule[]): MoveRule[] => [...rules].sort((a, b) => b.from.length - a.from.length || byBytes(a.from, b.from));

/**
 * The vault's rules (the user's pick "A"): each `Projects/<folder>/` goes to that project's notes;
 * a top-level folder whose name is a project's (letter case aside) goes there whole; everything
 * else keeps its path under the root `notes/`. Drawings go to their project's `drawings/` (or the
 * root one), keeping the task folder they were in.
 */
export function vaultRules(input: { topFolders: readonly string[]; projectsFolders: readonly string[]; projects: readonly string[] }): MoveRule[] {
  const rules: MoveRule[] = [{ from: '', to: 'notes/' }];
  // The Inbox has no folder of its own: a vault folder named "Inbox" stays the user's.
  const folders = new Set(input.projects.filter((p) => !isInboxProject(p)).map((p) => projectFolderName(p)).filter((f): f is string => !!f));
  const byLower = new Map<string, string>();
  for (const f of [...folders].sort()) if (!byLower.has(f.toLowerCase())) byLower.set(f.toLowerCase(), f);
  for (const f of input.projectsFolders) {
    const folder = projectFolderName(f);
    if (folder) rules.push({ from: `${TRACKING_NOTE_DIR}/${f}/`, to: `${TREE_PROJECTS_DIR}/${folder}/notes/` });
  }
  for (const top of input.topFolders) {
    if (top === TRACKING_NOTE_DIR || top.startsWith('.')) continue;
    // A project named exactly like the folder wins over one that only matches in lower case.
    const folder = folders.has(top) ? top : byLower.get(top.toLowerCase());
    if (folder) rules.push({ from: `${top}/`, to: `${TREE_PROJECTS_DIR}/${folder}/notes/` });
  }
  return sortRules(rules);
}


/** The artifacts folder's own rules, from the layout by task id (nodes/, org/, shared/) to the one by project. */
export function artifactRules(nodes: ReadonlyArray<{ id: string; project: string | null | undefined }>): MoveRule[] {
  const rules: MoveRule[] = [
    { from: 'org/skills/', to: 'skills/' },
    { from: 'shared/notes/', to: `memory/${SHARED_MEMORY_KEY}/notes/` },
    { from: 'shared/drawings/', to: 'drawings/' },
    // A folder of a task no longer on the board (deleted): its memory home at the root, by its id.
    { from: 'nodes/', to: 'memory/' },
  ];
  for (const n of nodes) {
    const dir = projectDirOf(n.project);
    const home = dir ? `${dir}/memory/${n.id}/` : `memory/${n.id}/`;
    rules.push({ from: `nodes/${n.id}/`, to: home });
    rules.push({ from: `nodes/${n.id}/skills/`, to: dir ? `${dir}/skills/` : `${home}skills/` });
    rules.push({ from: `nodes/${n.id}/drawings/`, to: dir ? `${dir}/drawings/` : 'drawings/' });
  }
  return sortRules(rules);
}

/**
 * The same map backwards, for the roll back. Two old folders can meet in one new folder (a
 * project's Projects/ folder and its top-level one), so a prefix cannot say where each file came
 * from: every file the move made is an exact entry (`moves`), and only a file made after the move
 * goes back by prefix, to the Projects/ folder when two rules meet.
 */
export function invertMap(map: MoveMap, moves: ReadonlyArray<readonly [string, string]>): MoveMap {
  const exact: Record<string, string> = {};
  for (const [from, to] of moves) exact[to] = from;
  const seen = new Map<string, MoveRule>();
  for (const r of map.rules) {
    const back = { from: r.to, to: r.from };
    const had = seen.get(back.from);
    if (!had || r.from.startsWith(`${TRACKING_NOTE_DIR}/`)) seen.set(back.from, back);
  }
  return { exact, rules: sortRules([...seen.values()]) };
}

/** " 2", " 3" before the extension: the name a move gives a file whose new place is taken. */
export function numbered(rel: string, n: number): string {
  const m = /^(.*?)((?:\.drawing\.md|\.narration\.json|\.[^./]+)?)$/.exec(rel)!;
  return `${m[1]} ${n}${m[2]}`;
}

/** A planned move: every file's old path, its new one, and the exact entries the map needs. */
export interface MovePlan { moves: Array<[string, string]>; exact: Record<string, string> }

const drawingStem = (rel: string): string => {
  const lower = rel.toLowerCase();
  const s = ['.excalidraw', '.drawing.md', '.narration.json'].find((x) => lower.endsWith(x));
  return s ? rel.slice(0, rel.length - s.length) : rel;
};

/**
 * Every vault file's new place. Two files whose new paths are one (letter case aside: the Mac's
 * disk does not tell them apart) keep both: the later gets " 2", " 3". A drawing's files (scene,
 * companion note, walkthrough) move and number together. Drawings, and every renamed file, are
 * exact entries; the rest follow the prefix rules.
 */
export function planVault(files: readonly string[], rules: readonly MoveRule[]): MovePlan {
  const plan: MovePlan = { moves: [], exact: {} };
  const taken = new Set<string>();
  // Projects/ first: a project's own folder keeps the plain names when its top-level folder has the same.
  const order = [...files].sort((a, b) => Number(!a.startsWith(`${TRACKING_NOTE_DIR}/`)) - Number(!b.startsWith(`${TRACKING_NOTE_DIR}/`)) || byBytes(a, b));
  const families = new Map<string, string[]>();
  for (const rel of order) {
    if (!isDrawingFile(rel)) continue;
    const stem = drawingStem(rel);
    families.set(stem, [...(families.get(stem) ?? []), rel]);
  }
  const done = new Set<string>();
  for (const rel of order) {
    if (done.has(rel)) continue;
    const group = isDrawingFile(rel) ? families.get(drawingStem(rel))! : [rel];
    const natural = group.map((f) => (isDrawingFile(f) ? drawingTarget(f, rules) : mapPath(f, { exact: {}, rules })));
    let targets = natural;
    for (let n = 2; targets.some((t) => taken.has(t.toLowerCase())); n++) {
      targets = natural.map((t, i) => (isDrawingFile(group[i]!) ? `${drawingStem(t)} ${n}${t.slice(drawingStem(t).length)}` : numbered(t, n)));
    }
    group.forEach((f, i) => {
      const to = targets[i]!;
      taken.add(to.toLowerCase());
      done.add(f);
      plan.moves.push([f, to]);
      // An old folder named like one of the tree's own ("memory/", "notes/"): a path in it reads as
      // the tree's, so each of its files is an exact entry.
      if (to !== natural[i] || isDrawingFile(f) || TREE_TOP_NAMES.includes(f.split('/')[0]!)) plan.exact[f] = to;
    });
  }
  return plan;
}

/** The artifacts folder's files: a skill whose folder is taken in its project gets "-2", "-3" (skill names have no spaces). */
export function planArtifacts(files: readonly string[], rules: readonly MoveRule[]): MovePlan {
  const plan: MovePlan = { moves: [], exact: {} };
  const skillDir = /^(nodes\/[^/]+\/skills\/[^/]+)\//;
  const renamedSkill = new Map<string, string>();
  const takenSkill = new Set<string>();
  for (const rel of [...files].sort(byBytes)) {
    let to = mapPath(rel, { exact: {}, rules });
    const m = skillDir.exec(rel);
    if (m) {
      const fromDir = m[1]!;
      let toDir = renamedSkill.get(fromDir);
      if (!toDir) {
        const natural = mapPath(`${fromDir}/`, { exact: {}, rules }).replace(/\/$/, '');
        toDir = natural;
        for (let n = 2; takenSkill.has(toDir.toLowerCase()); n++) toDir = `${natural}-${n}`;
        takenSkill.add(toDir.toLowerCase());
        renamedSkill.set(fromDir, toDir);
      }
      to = `${toDir}/${rel.slice(fromDir.length + 1)}`;
      if (toDir !== mapPath(`${fromDir}/`, { exact: {}, rules }).replace(/\/$/, '')) plan.exact[rel] = to;
    }
    plan.moves.push([rel, to]);
  }
  return plan;
}
