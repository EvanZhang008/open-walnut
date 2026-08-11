/**
 * Which directories must be expanded so a selected file is VISIBLE in the tree.
 *
 * Lives in its own dep-free module (not inside SessionFileExplorer.tsx) so tests can
 * import it without dragging in the component's markdown/highlight deps — importing
 * the .tsx under the node-env config dies with `notePurify.addHook is not a function`.
 */

/** Parent directory of `p`, with '/' as its own fixed point. */
export function parentPath(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/**
 * Ancestors of `file` under `root`, NEAREST PARENT FIRST, stopping below the root
 * (the root is always expanded already). Empty when `file` is a direct child of the
 * root or lives outside the tree.
 *
 * TERMINATION IS THE POINT. `parentPath('/')` returns `'/'`, so with a root of `/`
 * (rootNorm `''`, prefix `'/'`) the old `dir.startsWith(prefix)` guard was satisfied
 * forever. As an inline React effect that spun a core with no rendered error and no
 * console output — it read as a frozen tab. Stop on the fixed point, never on the
 * prefix alone.
 */
export function revealAncestors(root: string, file: string): string[] {
  const rootNorm = root.replace(/\/+$/, '');
  if (!file.startsWith(`${rootNorm}/`)) return [];
  const ancestors: string[] = [];
  for (let dir = parentPath(file); dir.startsWith(`${rootNorm}/`); ) {
    // The ROOT is never its own ancestor. With root '/', rootNorm is '' so the
    // prefix is '/', which '/' itself matches — hence the explicit equality check
    // rather than relying on the prefix to exclude it.
    if (dir === (rootNorm || '/')) break;
    ancestors.push(dir);
    const up = parentPath(dir);
    if (up === dir) break; // fixed point ('/') — no further ancestor exists
    dir = up;
  }
  return ancestors;
}
