/**
 * Pure (React-free) builder that turns the flat repo-grouped change list into a
 * navigable file tree: repo → nested folders → files. Split out of
 * SessionDiffView so it's unit-testable without a DOM (matches diffPatch.ts).
 *
 * The old UI dumped all N files into one scroll with no navigation. This tree is
 * the left rail: the first level is the repo (cwd / submodule / other), then real
 * folder nesting, then the files you can click to view a single diff.
 */
import type { SessionFileChange, SessionRepoGroup } from '@/api/session-changes';

export interface DiffTreeFileNode {
  kind: 'file';
  /** leaf name, e.g. `session-changes.ts` */
  name: string;
  /** unique id for selection/expansion = the change's absolute filePath */
  id: string;
  change: SessionFileChange;
}

export interface DiffTreeDirNode {
  kind: 'dir';
  /** folder name, e.g. `core` */
  name: string;
  /** unique id = repoRoot + '/' + path-so-far (stable across renders) */
  id: string;
  children: DiffTreeNode[];
  /** total files under this dir (for the count badge) */
  fileCount: number;
}

export interface DiffTreeRepoNode {
  kind: 'repo';
  /** Full label from the API (a submodule's whole path under the superproject). */
  label: string;
  /** What the header ROW shows — see shortRepoLabels. Full label goes in the tooltip. */
  shortLabel: string;
  id: string;
  repoKind: SessionRepoGroup['kind'];
  children: DiffTreeNode[];
  fileCount: number;
}

export type DiffTreeNode = DiffTreeFileNode | DiffTreeDirNode | DiffTreeRepoNode;

interface MutableDir {
  dirs: Map<string, MutableDir>;
  files: SessionFileChange[];
}

function emptyDir(): MutableDir {
  return { dirs: new Map(), files: [] };
}

/** Collapse single-child directory chains (`a/b/c` → one `a/b/c` row) GitHub-style. */
function compress(name: string, dir: MutableDir, idPrefix: string): DiffTreeDirNode {
  let displayName = name;
  let current = dir;
  let idPath = `${idPrefix}/${name}`;
  // While this dir has exactly one subdir and no files, fold it into the name.
  while (current.files.length === 0 && current.dirs.size === 1) {
    const [childName, childDir] = [...current.dirs.entries()][0]!;
    displayName = `${displayName}/${childName}`;
    idPath = `${idPath}/${childName}`;
    current = childDir;
  }
  const children = buildChildren(current, idPath);
  return {
    kind: 'dir',
    name: displayName,
    id: idPath,
    children,
    fileCount: countFiles(children),
  };
}

function countFiles(nodes: DiffTreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.kind === 'file') n += 1;
    else n += node.fileCount;
  }
  return n;
}

/** Dirs first (alpha), then files (alpha) — the conventional tree order. */
function buildChildren(dir: MutableDir, idPrefix: string): DiffTreeNode[] {
  const dirNodes: DiffTreeDirNode[] = [...dir.dirs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([childName, childDir]) => compress(childName, childDir, idPrefix));
  const fileNodes: DiffTreeFileNode[] = [...dir.files]
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
    .map((change) => ({
      kind: 'file' as const,
      name: change.relPath.split('/').pop() || change.relPath,
      id: change.filePath,
      change,
    }));
  return [...dirNodes, ...fileNodes];
}

/**
 * Row labels for the repo headers: the package/submodule NAME only.
 *
 * A submodule's label is its whole path from the superproject root, which in a
 * deep monorepo is long enough to fill the row and get clipped from the RIGHT —
 * clipping away the one segment that says WHICH submodule it is. So show the
 * last segment; the full path stays on the row's tooltip.
 *
 * Two groups can end in the same segment (the same package name under two
 * parents) and two identical headers are worse than one long header, so a
 * collision prepends parent segments until the labels differ.
 */
export function shortRepoLabels(labels: string[]): string[] {
  const segs = labels.map((l) => l.split('/').filter(Boolean));
  const depth = segs.map(() => 1);
  const render = () => segs.map((s, i) => s.slice(Math.max(0, s.length - depth[i]!)).join('/') || labels[i]!);
  // Bounded: each round deepens at least one colliding label, and a label can't
  // grow past its own segment count.
  for (;;) {
    const cur = render();
    const dupes = new Set(cur.filter((v, i) => cur.indexOf(v) !== i));
    if (!dupes.size) break;
    let grew = false;
    cur.forEach((v, i) => {
      if (dupes.has(v) && depth[i]! < segs[i]!.length) { depth[i]! += 1; grew = true; }
    });
    if (!grew) break; // genuinely identical paths — nothing left to disambiguate
  }
  return render();
}

/** Build the full tree (repos at the top level) from the API's repo groups. */
export function buildDiffTree(groups: SessionRepoGroup[]): DiffTreeRepoNode[] {
  const shortLabels = shortRepoLabels(groups.map((g) => g.label));
  return groups.map((group, groupIdx) => {
    const root = emptyDir();
    for (const change of group.files) {
      const parts = change.relPath.split('/').filter(Boolean);
      const fileName = parts.pop(); // last segment is the file
      let cursor = root;
      for (const part of parts) {
        let next = cursor.dirs.get(part);
        if (!next) { next = emptyDir(); cursor.dirs.set(part, next); }
        cursor = next;
      }
      // Push under its folder; if relPath had no folder, lands at repo root.
      void fileName;
      cursor.files.push(change);
    }
    const children = buildChildren(root, group.repoRoot);
    return {
      kind: 'repo' as const,
      label: group.label,
      shortLabel: shortLabels[groupIdx] ?? group.label,
      id: group.repoRoot,
      repoKind: group.kind,
      children,
      fileCount: countFiles(children),
    };
  });
}

/** Flat list of every file node (for "select first file" / keyboard nav). */
export function flattenFiles(nodes: DiffTreeNode[]): DiffTreeFileNode[] {
  const out: DiffTreeFileNode[] = [];
  const walk = (list: DiffTreeNode[]) => {
    for (const node of list) {
      if (node.kind === 'file') out.push(node);
      else walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** All directory/repo ids — used to expand-all by default. */
export function allContainerIds(nodes: DiffTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: DiffTreeNode[]) => {
    for (const node of list) {
      if (node.kind !== 'file') { out.push(node.id); walk(node.children); }
    }
  };
  walk(nodes);
  return out;
}

/** Is this file a markdown doc (so the diff view should offer a Rendered toggle)? */
export function isMarkdownPath(relPath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(relPath);
}
