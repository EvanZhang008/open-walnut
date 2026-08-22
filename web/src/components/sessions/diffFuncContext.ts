/**
 * Pure (React-free) "which function is this?" context for the Changed view's
 * collapsed-context bars — the same job as git's hunk-header funcname
 * (`@@ … @@ private void deliverEvents(…)`), computed client-side because our
 * hunks are built from before/after strings, not `git diff` output.
 *
 * Given the OLD-side source and an old line number, scan UPWARD for the nearest
 * line that looks like a definition. Language-aware first (keyword-led forms at
 * any indent), then git's default heuristic (a line starting at column 0 with a
 * letter/_/$) as the fallback for brace languages.
 */

/** Keyword-led definition lines, any indentation. Covers the common cases:
 *  js/ts (function/class/interface + exported arrow consts), python (def/class),
 *  go (func), rust (fn/impl/trait), java/c#/kotlin (modifier-led method sigs),
 *  ruby (def/class/module), swift (func/class/struct/extension). */
const DEF_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b\s*\w*/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/,
  /^\s*(?:export\s+)?(?:interface|enum|trait|impl|struct|module|extension|object)\s+\w+/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|\w+\s*=>)/,
  /^\s*(?:async\s+)?def\s+\w+/,                       // python
  /^\s*func\s+(?:\([^)]*\)\s*)?\w+/,                  // go (incl. method receivers)
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+\w+/, // rust
  // java/c#/kotlin-style: modifier-led signature ending in `(` args
  /^\s*(?:@\w+\s+)*(?:public|private|protected|internal|static|final|abstract|synchronized|override|native)\b[^;={]*\w+\s*\(/,
];

/** git's default xfuncname: an unindented line starting with a letter, `_` or `$`
 *  (top-level definitions in brace languages). Skip obvious non-defs. */
const GIT_DEFAULT = /^[A-Za-z_$]/;
const NOISE = /^\s*(?:\/\/|\/\*|\*|#|--|'|"|`|@|\}|\{|\)|else\b|return\b|import\b|from\b|package\b|using\b|include\b)/;

const MAX_SCAN = 600;   // lines to scan upward before giving up
const MAX_LEN = 90;     // display truncation

function clean(line: string): string {
  // Drop a trailing open-brace / colon and collapse whitespace for display.
  const s = line.trim().replace(/[{:]\s*$/, '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_LEN ? `${s.slice(0, MAX_LEN - 1)}…` : s;
}

/** Split once per file, reuse across gaps (the caller memoizes). */
export function splitSourceLines(source: string | null | undefined): string[] {
  return (source ?? '').split('\n');
}

/**
 * The nearest enclosing definition at/above 1-based `line` in `lines`, or null.
 * Deliberately scans from `line` itself: when a hunk STARTS at a definition,
 * naming that definition ("the code below is X") beats naming the previous one.
 */
export function functionContext(lines: string[], line: number): string | null {
  const start = Math.min(lines.length, Math.max(1, line));
  const stop = Math.max(0, start - MAX_SCAN);
  for (let i = start; i > stop; i--) {
    const text = lines[i - 1];
    if (!text || !text.trim()) continue;
    if (NOISE.test(text)) continue;
    if (DEF_PATTERNS.some((re) => re.test(text))) return clean(text);
    if (GIT_DEFAULT.test(text)) return clean(text);
  }
  return null;
}
