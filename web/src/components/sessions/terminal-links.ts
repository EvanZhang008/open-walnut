/**
 * File paths in terminal output, for the terminal's clickable links.
 *
 * A click on one opens it in the session's Files view at its line
 * (SessionPanel's clicked-path opener looks it up first, so a path that is not
 * there says so instead of opening the wrong folder). URLs are not found here:
 * the web-links addon keeps opening them as before, and a path inside a URL is
 * never a path link.
 *
 * What counts as a path, so ordinary words never light up:
 *   - absolute or home paths with two or more parts: `/x/y`, `~/x/y.ts`
 *   - `./x`, `../x`
 *   - relative paths with a slash and a file name: `src/a.ts`, `web/src/x.tsx`
 *   - a bare file name with a known extension (`package.json`, `x.test.ts`; a
 *     bare `.js` name only with a line, since `node.js` is a product) or with a
 *     line (`main.go:12`)
 *   - a file known by its name (`Makefile:3`, `docs/README`), a dotfile (`.env`),
 *     and `dir/name:12` (a line makes any two-part path a file)
 * Parts may be in any script (`docs/报告/a.md`).
 *   - a quoted name with spaces that ends in a known extension:
 *     `"docs/my notes.md":4`, `File "/x/my app/main.py", line 8`
 * followed by an optional position: `:12`, `:12:5`, `(12,5)`, `#L12`, or a
 * Python traceback's `", line 12`. `git diff`'s `a/` and `b/` prefixes go.
 *
 * Pure (tests/web/terminal-links.test.ts).
 */

export interface TerminalPathLink {
  /** Index of the first character in the line (UTF-16), and one past the last. */
  start: number;
  end: number;
  /** The path as it should be looked up (prefixes and position removed). */
  path: string;
  line?: number;
  col?: number;
  /** A `git diff` path (its `a/` `b/` gone): it is relative to the repository root, wherever the shell is. */
  fromRepoRoot?: true;
  /**
   * Set when `path` was made absolute from where the shell is: the next places
   * to try, in order, when that one is missing (the repository root, then the
   * path as printed, from the session's directory).
   */
  fallbackPaths?: string[];
  /** The path as the output printed it, for a note when no place has it. */
  printed?: string;
}

const KNOWN_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'md', 'mdx', 'txt', 'log', 'yml', 'yaml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'lock', 'html', 'htm', 'css', 'scss', 'less', 'svg', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'kts', 'swift', 'm', 'mm', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh',
  'fish', 'sql', 'xml', 'gradle', 'vue', 'svelte', 'astro', 'lua', 'dart', 'scala', 'ex', 'exs', 'erl',
  'hs', 'ml', 'r', 'pl', 'proto', 'graphql', 'gql', 'tf', 'hcl', 'csv', 'tsv', 'patch', 'diff', 'ipynb',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'mp4', 'mov', 'zip', 'tgz', 'gz',
]);

// Files whose names carry no extension, yet are plainly files (`Makefile:12`, `src/README`).
const KNOWN_NAMES = new Set([
  'makefile', 'gnumakefile', 'dockerfile', 'containerfile', 'readme', 'license', 'licence', 'copying', 'notice',
  'changelog', 'changes', 'authors', 'contributors', 'codeowners', 'owners', 'todo', 'gemfile', 'rakefile',
  'podfile', 'brewfile', 'procfile', 'jenkinsfile', 'vagrantfile', 'caddyfile', 'justfile', 'snakefile',
  'build', 'workspace', 'cmakelists', 'kconfig', 'pipfile', 'version', 'manifest',
]);

// One path part: letters and digits of any script (`docs/报告/a.md`), no spaces,
// quotes, brackets or separators a shell prints around paths. A part may be a
// dot name (`.config`, `.bin`) or `.` / `..` (`../../x.ts`, `a/../b`).
const NAME = String.raw`\.?[\p{L}\p{N}\p{M}_@%+~-][\p{L}\p{N}\p{M}_@%+~.-]*`;
const PART = String.raw`(?:${NAME}|\.{1,2}(?=\/))`;
// The path, then an optional position. The position forms are captured apart.
const PATH_RE = new RegExp(
  String.raw`(?:^|(?<=[\s"'` + '`' + String.raw`(\[<{=:,|]))` +
  String.raw`((?:~|\$HOME|\$\{HOME\})?(?:\/${PART})+\/?|${PART}(?:\/${PART})*)` +
  String.raw`(?::(\d+)(?::(\d+))?|\((\d+),\s?(\d+)\)|#L(\d+)|", line (\d+))?`,
  'gu',
);
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi;
// A quoted path with spaces in it, then an optional position (`:12:5`, `, line 12`).
const QUOTED_RE = /(["'])([^"'\n]* [^"'\n]*)\1(?::(\d+)(?::(\d+))?|, line (\d+))?/g;

function extOf(path: string): string {
  const leaf = path.split('/').pop() ?? '';
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : '';
}

function looksLikePath(path: string, hasLine: boolean): boolean {
  if (path.length < 2 || /^\d+([.,:/-]\d+)*$/.test(path)) return false; // numbers, times, versions, dates
  if (/^[.~]?\/$|^\.\.?$/.test(path)) return false;
  const parts = path.replace(/^~/, '').split('/').filter(Boolean);
  const leaf0 = parts[parts.length - 1] ?? '';
  if (path.startsWith('/') || path.startsWith('~/')) return parts.length >= 2 || (parts.length === 1 && (!!extOf(path) || /^\.[\p{L}_-]/u.test(leaf0)));
  if (path.startsWith('./') || path.startsWith('../')) return parts.length >= 2;
  const leaf = parts[parts.length - 1] ?? '';
  // A file known by its name alone (`Makefile`, `README`) or a dotfile (`.env`).
  const namedFile = KNOWN_NAMES.has(leaf.toLowerCase().replace(/\.txt$/, '')) || /^\.[\p{L}_-]/u.test(leaf);
  if (parts.length >= 2) {
    // `a/b` alone is often prose ("and/or", "read/write"): ask for a file name
    // with an extension or known by its name, a dotted directory, three parts,
    // or a line (`bin/run:12` is a file at a line, never prose).
    return !!extOf(path) || namedFile || hasLine || parts.length >= 3 || parts.some((p) => p.startsWith('.'));
  }
  if (namedFile) return true;
  const ext = extOf(path);
  // `node.js`, `next.js`: a bare `.js` name is as often a product as a file.
  if (ext === 'js' && !hasLine) return false;
  return KNOWN_EXT.has(ext) || (hasLine && !!ext);
}

/** The path links in one line of terminal text. */
export function findTerminalPathLinks(text: string): TerminalPathLink[] {
  if (!text.trim()) return [];
  const urls: [number, number][] = [];
  for (const m of text.matchAll(URL_RE)) urls.push([m.index!, m.index! + m[0].length]);
  const inUrl = (a: number, b: number) => urls.some(([s, e]) => a < e && b > s);
  const gitLine = /^(diff --git |--- |\+\+\+ )/.test(text);

  const out: TerminalPathLink[] = [];
  // Quoted names with spaces first: the words inside them are not links of their own.
  const quoted: [number, number][] = [];
  for (const m of text.matchAll(QUOTED_RE)) {
    const path = m[2]!.trim();
    const start = m.index!;
    const end = start + m[0].length;
    if (inUrl(start, end) || !quotedPath(path)) continue;
    quoted.push([start, end]);
    const line = Number(m[3] ?? m[5] ?? 0);
    const col = Number(m[4] ?? 0);
    out.push({ start, end, path, ...(line > 0 ? { line } : {}), ...(col > 0 ? { col } : {}) });
  }
  const inQuoted = (a: number, b: number) => quoted.some(([s, e]) => a < e && b > s);
  for (const m of text.matchAll(PATH_RE)) {
    let raw = m[1]!;
    let start = m.index!;
    if (!raw) continue;
    // Trailing sentence punctuation is not part of the path.
    const trimmed = raw.replace(/[.,]+$/, '');
    const cut = raw.length - trimmed.length;
    raw = trimmed;
    const lineStr = cut > 0 ? undefined : (m[2] ?? m[4] ?? m[6] ?? m[7]);
    const colStr = cut > 0 ? undefined : (m[3] ?? m[5]);
    const end = cut > 0 ? start + raw.length : start + m[0].length;
    if (inUrl(start, end) || inQuoted(start, end)) continue;
    // `$HOME/x` as printed (an unexpanded variable in a log or an echo) is `~/x`.
    let path = raw.replace(/^\$(?:HOME|\{HOME\})(?=\/)/, '~');
    let fromRepoRoot = false;
    if (gitLine && /^[ab]\/./.test(path)) {
      path = path.slice(2);
      start += 2;
      fromRepoRoot = true;
    }
    if (path.endsWith('/') && path.length > 1) path = path.slice(0, -1);
    if (!looksLikePath(path, lineStr !== undefined)) continue;
    const line = lineStr !== undefined ? Number(lineStr) : undefined;
    const col = colStr !== undefined ? Number(colStr) : undefined;
    out.push({
      start,
      end,
      path,
      ...(line !== undefined && line > 0 ? { line } : {}),
      ...(col !== undefined && col > 0 ? { col } : {}),
      ...(fromRepoRoot ? { fromRepoRoot: true as const } : {}),
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * A quoted name with spaces is a path only when it reads as one: a file with a
 * known extension at the end, few spaces, no position or prose after the name
 * (`'see app.ts:27 for it'` is a sentence, not a file).
 */
function quotedPath(path: string): boolean {
  if (path.length < 3 || path.length > 260 || (path.match(/ /g)?.length ?? 0) > 4) return false;
  if (/[:;|<>*?]/.test(path.replace(/^[A-Za-z]:/, ''))) return false;
  return KNOWN_EXT.has(extOf(path));
}

/**
 * A relative path in the output, made absolute against the shell's working
 * directory (`cwd`, absolute). `.` and `..` parts are folded; an absolute or
 * home path is returned as it is.
 */
export function resolveTerminalPath(cwd: string, path: string): string {
  if (path.startsWith('/') || path.startsWith('~') || !cwd.startsWith('/')) return path;
  const parts = cwd.split('/').filter(Boolean);
  for (const p of path.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return `/${parts.join('/')}`;
}

/**
 * Where to look for a relative path from the terminal, in order: from the
 * shell's directory, then from the root of its git repository (a linter or
 * test runner prints paths from there), then as printed (the session's
 * directory). A `git diff` path tries the repository root first.
 */
export function terminalPathCandidates(link: TerminalPathLink, place: { cwd: string | null; root?: string | null }): string[] {
  // `/a/src/../big.txt` is `/a/big.txt`.
  if (link.path.startsWith('/')) return [resolveTerminalPath('/', link.path.slice(1))];
  if (link.path.startsWith('~')) return [link.path];
  const fromCwd = place.cwd ? resolveTerminalPath(place.cwd, link.path) : null;
  const fromRoot = place.root ? resolveTerminalPath(place.root, link.path) : null;
  const order = link.fromRepoRoot ? [fromRoot, fromCwd] : [fromCwd, fromRoot];
  return [...new Set([...order.filter((p): p is string => !!p), link.path])];
}

/** The few buffer calls a logical line needs (xterm's IBuffer, or a test's fake). */
export interface LinkBuffer {
  getLine(y: number): {
    readonly isWrapped: boolean;
    readonly length: number;
    getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
  } | undefined;
}

/** A cell position, 1-based like xterm's link ranges. */
export interface CellPos { x: number; y: number }

/**
 * The text of the logical line that buffer row `row` (0-based) belongs to, rows
 * a long line wrapped onto joined, and the cell of every character in it, so a
 * path found in the text maps back to the cells it covers (wide characters
 * take two cells and one character).
 */
export function logicalLineAt(buffer: LinkBuffer, row: number): { text: string; cells: CellPos[] } {
  let first = row;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let last = row;
  while (buffer.getLine(last + 1)?.isWrapped) last++;
  let text = '';
  const cells: CellPos[] = [];
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue; // the right half of a wide character
      const ch = cell.getChars() || ' ';
      for (let k = 0; k < ch.length; k++) cells.push({ x: x + 1, y: y + 1 });
      text += ch;
    }
  }
  return { text, cells };
}

/**
 * The path links of the logical line under buffer row `row`, as cell ranges
 * (end inclusive), keeping only the ones that cross that row.
 */
export function pathLinksAtRow(buffer: LinkBuffer, row: number): { link: TerminalPathLink; start: CellPos; end: CellPos; text: string }[] {
  const { text, cells } = logicalLineAt(buffer, row);
  const y = row + 1;
  return findTerminalPathLinks(text)
    .map((link) => ({ link, start: cells[link.start]!, end: cells[link.end - 1]!, text: text.slice(link.start, link.end) }))
    .filter((l) => l.start && l.end && l.start.y <= y && l.end.y >= y);
}
