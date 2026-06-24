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
  label: string;
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

/** Build the full tree (repos at the top level) from the API's repo groups. */
export function buildDiffTree(groups: SessionRepoGroup[]): DiffTreeRepoNode[] {
  return groups.map((group) => {
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
