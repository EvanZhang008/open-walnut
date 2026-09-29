/**
 * The board's folder TREE: `parent_id` drawn as nesting instead of one flat level.
 *
 * The data always carried the hierarchy (the server nests folders up to
 * FOLDER_MAX_DEPTH), and since subtasks nest their folders (a subtask of a task
 * in a shared folder gets a subfolder of it), a flat board would show a
 * subfolder as a sibling of its own parent. These helpers are pure so the tier
 * and list renderers share one definition, pinned by
 * tests/web/folder-tree.test.ts. The phone draws the same tree
 * (ios-native/Walnut/Views/Tasks/TaskBoardModel.swift, BoardFolderIndex): same
 * normalisation, same pre-order.
 *
 * The one failure worse than a flat board is an INVISIBLE row, so every broken
 * link (a parent that is not listed, one in another project, a folder that is its
 * own parent, a cycle) makes that folder a ROOT rather than dropping it.
 */

/** The server's nesting ceiling: depth 0 (a top-level folder) to 4. */
export const FOLDER_MAX_DEPTH = 5;

/** What the tree reads off one folder record (`folderMeta`). */
export interface FolderNode {
  project: string;
  parent_id?: string;
}

const projectKey = (p: string | undefined): string => (p ?? '').trim().toLowerCase();

/**
 * folder id → parent folder id, NORMALISED: only links whose parent is listed and
 * lives in the same project, with every link that would close a cycle dropped.
 * Empty when no folder nests, which is what lets every caller take a fast path.
 */
export function buildFolderParents(meta: Record<string, FolderNode> | undefined): Map<string, string> {
  const parentOf = new Map<string, string>();
  if (!meta) return parentOf;
  for (const [id, node] of Object.entries(meta)) {
    const parent = node.parent_id;
    if (!parent || parent === id) continue;
    const up = meta[parent];
    if (!up || !Object.prototype.hasOwnProperty.call(meta, parent)) continue;
    if (projectKey(up.project) !== projectKey(node.project)) continue;
    parentOf.set(id, parent);
  }
  // Sorted so the link a cycle loses is the same on every render.
  for (const id of [...parentOf.keys()].sort()) {
    const seen = new Set<string>([id]);
    for (let cur = parentOf.get(id); cur !== undefined; cur = parentOf.get(cur)) {
      if (seen.has(cur)) { parentOf.delete(id); break; }
      seen.add(cur);
    }
  }
  return parentOf;
}

/** A folder's ancestors, ROOT FIRST, excluding itself. Empty for a root. */
export function folderAncestors(id: string, parentOf: Map<string, string>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([id]);
  for (let cur = parentOf.get(id); cur !== undefined && !seen.has(cur); cur = parentOf.get(cur)) {
    chain.push(cur);
    seen.add(cur);
  }
  return chain.reverse();
}

/** How far in a folder is drawn: 0 at the top of its project, clamped so a chain
 *  deeper than the server stores still fits on screen. */
export function folderDepth(id: string, parentOf: Map<string, string>): number {
  return Math.min(FOLDER_MAX_DEPTH - 1, folderAncestors(id, parentOf).length);
}

/**
 * Reorder `units` so every folder's whole SUBTREE is contiguous, in pre-order: a
 * folder's own units (their relative order kept), then each subfolder's subtree.
 *
 * A top-level folder's subtree takes the place of its FIRST unit anywhere in that
 * subtree, and siblings are ordered the same way, so a parent whose own units come
 * later still leads the subfolder that appears first. Units with no folder never
 * move. With no nesting this returns `units` itself (same array), which keeps the
 * flat board byte-for-byte what it was. Idempotent.
 */
export function nestFolderUnits<T>(
  units: T[],
  folderOf: (unit: T) => string | undefined,
  parentOf: Map<string, string>,
): T[] {
  if (parentOf.size === 0) return units;
  const own = new Map<string, T[]>();
  const place = new Map<string, number>();
  const rootOf = new Map<string, string>();
  units.forEach((unit, index) => {
    const folder = folderOf(unit);
    if (!folder) return;
    let list = own.get(folder);
    if (!list) { list = []; own.set(folder, list); }
    list.push(unit);
    const chain = [...folderAncestors(folder, parentOf), folder];
    rootOf.set(folder, chain[0]);
    for (const id of chain) if (!place.has(id)) place.set(id, index);
  });
  // parent → children, among the folders that take part (the ones with units and
  // their ancestors), each list in order of first appearance.
  const children = new Map<string, string[]>();
  for (const id of place.keys()) {
    const parent = parentOf.get(id);
    if (parent === undefined || !place.has(parent)) continue;
    let list = children.get(parent);
    if (!list) { list = []; children.set(parent, list); }
    list.push(id);
  }
  for (const list of children.values()) list.sort((a, b) => (place.get(a) ?? 0) - (place.get(b) ?? 0));
  const out: T[] = [];
  const emitted = new Set<string>();
  const walk = (id: string): void => {
    if (emitted.has(id)) return;
    emitted.add(id);
    out.push(...(own.get(id) ?? []));
    for (const child of children.get(id) ?? []) walk(child);
  };
  for (const unit of units) {
    const folder = folderOf(unit);
    if (!folder) { out.push(unit); continue; }
    walk(rootOf.get(folder) ?? folder);
  }
  return out;
}

/**
 * Per lead row: the ANCESTOR folders whose heading it must draw above its own,
 * because no earlier row in `folders` (the displayed rows' folder ids, in order)
 * sits anywhere under them. Without this a subfolder whose parent has no rows of
 * its own here would be drawn indented under a name that is nowhere on screen.
 * Returns index → ancestor ids (root first), only for rows that need any.
 */
export function ancestorHeadings(
  folders: Array<string | undefined>,
  parentOf: Map<string, string>,
): Map<number, string[]> {
  const heads = new Map<number, string[]>();
  if (parentOf.size === 0) return heads;
  const drawn = new Set<string>();
  folders.forEach((folder, index) => {
    if (!folder || drawn.has(folder)) return;
    const ancestors = folderAncestors(folder, parentOf);
    const missing = ancestors.filter((id) => !drawn.has(id));
    if (missing.length > 0) heads.set(index, missing);
    for (const id of ancestors) drawn.add(id);
    drawn.add(folder);
  });
  return heads;
}
