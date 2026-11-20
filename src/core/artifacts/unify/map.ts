/**
 * The one tree's map as data and its lookup (layout.ts makes it, note-path-moves.ts reads it).
 * No imports: every way a note path becomes a file asks here, drawings included, so this
 * module must load before any of them.
 */
/** The tree's own top folders: a path starting with one is in the tree's terms already. */
export const TREE_TOP_NAMES = ['projects', 'notes', 'skills', 'memory', 'drawings'];

/** A folder prefix and where it goes: both end in "/", or both are "" (everything else). */
export interface MoveRule { from: string; to: string }

/** The whole map: exact entries first, then the longest matching prefix rule. */
export interface MoveMap { exact: Record<string, string>; rules: readonly MoveRule[] }

/** The rule of a path: its own case first, then any case, as the Mac's vault (APFS) and the index (NOCASE) find a file. */
export function matchRule(rel: string, rules: readonly MoveRule[]): MoveRule {
  for (const r of rules) if (r.from && rel.startsWith(r.from)) return r;
  const lower = rel.toLowerCase();
  for (const r of rules) if (lower.startsWith(r.from.toLowerCase())) return r;
  return { from: '', to: '' };
}

/** A drawing's files: the scene, its companion note, its walkthrough (drawings/scene.ts, companion.ts, narration-store.ts). */
const DRAWING_SUFFIXES = ['.excalidraw', '.drawing.md', '.narration.json'];
export const isDrawingFile = (rel: string): boolean => {
  const lower = rel.toLowerCase();
  return DRAWING_SUFFIXES.some((s) => lower.endsWith(s));
};

/** Where a drawing file of the vault goes: its project's drawings (task folder kept), else the root's. */
export function drawingTarget(rel: string, rules: readonly MoveRule[]): string {
  const rule = matchRule(rel, rules);
  const m = /^(projects\/[^/]+)\/notes\/$/.exec(rule.to);
  if (m) return `${m[1]}/drawings/${rel.slice(rule.from.length)}`;
  // Not in a project: the inbox folder's own name drops ("inbox/<task> (<id>)/x" -> "drawings/<task> (<id>)/x").
  return `drawings/${rel.replace(/^inbox\//, '')}`;
}

/**
 * The rules of an old vault path, a project made after the move included: its tracking folder
 * `Projects/<folder>/` (the place the release before gives a project's notes and drawings) is that
 * project's folder in the tree even when no rule names it.
 */
function vaultRulesFor(rel: string, rules: readonly MoveRule[]): readonly MoveRule[] {
  if (matchRule(rel, rules).from) return rules;
  const m = /^Projects\/([^/]+)\//.exec(rel);
  return m ? [{ from: `Projects/${m[1]}/`, to: `projects/${m[1]}/notes/` }, ...rules] : rules;
}

/** An old vault path's place in the tree: an exact entry, else a drawing's place, else its folder rule. */
export function mapVaultPath(rel: string, map: MoveMap): string {
  const clean = rel.replace(/^\/+/, '');
  const exact = map.exact[clean];
  if (exact) return exact;
  const rules = vaultRulesFor(clean, map.rules);
  return isDrawingFile(clean) ? drawingTarget(clean, rules) : mapPath(clean, { exact: {}, rules });
}

/** Where an old path is now: an exact entry, else its longest prefix rule, else the path itself. */
export function mapPath(rel: string, map: MoveMap): string {
  const clean = rel.replace(/^\/+/, '');
  const exact = map.exact[clean];
  if (exact) return exact;
  const r = matchRule(clean, map.rules);
  return r.to + clean.slice(r.from.length);
}


const TREE_TOPS = new Set(TREE_TOP_NAMES);
const lowerExact = new WeakMap<MoveMap, Map<string, string>>();
const exactOf = (map: MoveMap, key: string): string | undefined => {
  const hit = map.exact[key];
  if (hit) return hit;
  let lower = lowerExact.get(map);
  if (!lower) { lower = new Map(Object.entries(map.exact).map(([k, v]) => [k.toLowerCase(), v])); lowerExact.set(map, lower); }
  return lower.get(key.toLowerCase());
};

/**
 * Where a path a caller named is now (note-path-moves.ts, the link resolvers, the web client):
 * the FINAL place, so asking twice changes nothing. A path in the tree's terms (its first folder
 * is one of the tree's own) is its own place; an old one maps through the exact entries (with or
 * without its ".md": some callers ask before they add it), then the folder rules. The one shape
 * this cannot tell apart: an old link into an old top folder named like one of the tree's own
 * (a vault's own `notes/`) reads as a tree path.
 */
export function movedPath(rel: string, map: MoveMap | null): string {
  if (!map) return rel;
  const clean = rel.replace(/^\/+/, '');
  // The tree's own terms first: the index, the watcher and the tree hand these, and one must
  // never land on another note because an old folder had the same name (planVault's exact entries).
  if (TREE_TOPS.has(clean.split('/')[0] ?? '')) return rel;
  const exact = exactOf(map, clean);
  if (exact) return exact;
  const withMd = /\.md$/i.test(clean) ? undefined : exactOf(map, `${clean}.md`);
  if (withMd) return withMd.replace(/\.md$/i, '');
  // A drawing the drawing code still places the old way lands in its project's drawings.
  return mapVaultPath(clean, map);
}
