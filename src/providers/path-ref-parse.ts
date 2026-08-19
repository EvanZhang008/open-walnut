/**
 * Clean up a path REFERENCE the way a reader would before looking for the file.
 *
 * A path in prose is almost never a bare path. It arrives wrapped in backticks,
 * carrying a `:42` line number, trailing a sentence period, or spelled with
 * Windows separators. Every one of those made the resolver miss a file that was
 * sitting right there, because the decoration became part of the name it searched
 * for. Stripping is therefore not cosmetic: it is the difference between finding
 * the file and showing an error.
 *
 * Kept in its own module (no fs, no async, no imports) so both the resolver and
 * the HTTP edges can share exactly one definition of "what the user meant", and
 * so the rules are testable as pure functions.
 */

/** A reference split into the path part and the position the reader asked for. */
export interface ParsedRef {
  /** The path with decoration removed. May still be relative or wrong. */
  path: string;
  /** 1-based line, when the reference carried one. */
  line?: number;
  /** 1-based column, when the reference carried one. */
  column?: number;
  /** End line of a range reference (`:10-20`, `#L10-L20`). */
  endLine?: number;
}

/**
 * Wrapping characters that come in pairs around a quoted path. Stripped only when
 * BOTH ends match, so a filename that legitimately starts with one survives.
 */
const WRAPPERS: Array<[string, string]> = [
  ['`', '`'], ['"', '"'], ["'", "'"],
  ['<', '>'],     // <path/to/file> — common in prose and in git output
  ['(', ')'], ['[', ']'], ['{', '}'],
];

/**
 * Punctuation that can only be sentence noise at the very end of a reference.
 *
 * `.` is deliberately included even though extensions contain dots: a path never
 * legitimately ENDS in a dot, so a trailing one is a sentence period. Dots inside
 * the name (`file.ts`, `mod..old`) are untouched — this only trims the last char.
 */
const TRAILING_NOISE = /[.,;:!?)\]}>"'`]+$/;

/**
 * Leading noise: list markers and prose glue that precede a quoted path.
 * `./` is NOT stripped here — it is meaningful (explicitly cwd-relative) and the
 * resolver handles it.
 */
const LEADING_NOISE = /^[-*+\s>]+/;

/**
 * Position suffixes, most specific first. Each is anchored to the END so a colon
 * inside a path (rare but legal) can't be mistaken for a line number.
 *
 *   file.ts:42        file.ts:42:7        file.ts:10-20
 *   file.ts#L42       file.ts#L10-L20     file.ts#42
 *   file.ts(42)       file.ts(42,7)       file.ts, line 42
 *   file.ts:L42
 */
const POSITION_PATTERNS: Array<{ re: RegExp; map: (m: RegExpMatchArray) => Omit<ParsedRef, 'path'> }> = [
  // #L10-L20 / #L10-20 — a GitHub range
  { re: /#L(\d+)[-–]L?(\d+)$/i, map: (m) => ({ line: +m[1]!, endLine: +m[2]! }) },
  // :10-20 — a plain range
  { re: /:(\d+)[-–](\d+)$/, map: (m) => ({ line: +m[1]!, endLine: +m[2]! }) },
  // #L42 / #42 — a GitHub single line
  { re: /#L?(\d+)$/i, map: (m) => ({ line: +m[1]! }) },
  // (42,7) / (42, 7) — a compiler-style position
  { re: /\((\d+),\s*(\d+)\)$/, map: (m) => ({ line: +m[1]!, column: +m[2]! }) },
  // (42)
  { re: /\((\d+)\)$/, map: (m) => ({ line: +m[1]! }) },
  // , line 42 / " line 42" — prose
  { re: /[,\s]+lines?\s+(\d+)$/i, map: (m) => ({ line: +m[1]! }) },
  // :42:7 — the editor/grep convention
  { re: /:(\d+):(\d+)$/, map: (m) => ({ line: +m[1]!, column: +m[2]! }) },
  // :L42
  { re: /:L(\d+)$/i, map: (m) => ({ line: +m[1]! }) },
  // :42 — last, because it is the least specific
  { re: /:(\d+)$/, map: (m) => ({ line: +m[1]! }) },
];

/** Strip one layer of matched wrappers, repeatedly (``"path"`` happens). */
function unwrap(s: string): string {
  let out = s;
  for (let i = 0; i < 4; i++) {
    let changed = false;
    for (const [open, close] of WRAPPERS) {
      if (out.length > open.length + close.length && out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(open.length, out.length - close.length);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return out;
}

/**
 * Collapse separators: Windows `\` → `/`, and runs of `/` → one.
 *
 * A backslash is a legal character in a POSIX filename, so this trades an
 * essentially unseen case (a file literally named `a\b`) for the very common one
 * (a Windows-style path, or an escaped path pasted out of a shell command).
 */
function normalizeSeparators(s: string): string {
  return s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

/**
 * Turn a reference as WRITTEN into the path plus the position asked for.
 *
 * Order matters and is load-bearing: unwrap before trimming noise (so the closing
 * quote doesn't look like sentence punctuation), extract the position before
 * trimming trailing noise (so `file.ts:42.` keeps its 42), and collapse separators
 * last so pattern matching sees a canonical string.
 */
export function parsePathRef(raw: string): ParsedRef {
  if (typeof raw !== 'string') return { path: '' };
  let s = raw.trim();

  // A reference whose LAST SEGMENT is traversal must survive parsing intact.
  // Trailing-noise trimming would otherwise eat the dots (`a/b/..` → `a/b`) and
  // hand the safety check a path that looks clean — the check then passes and the
  // caller resolves a directory the reference was trying to escape into. Bail out
  // early and let isUnsafePathRef reject the original.
  //
  // BOTH separators are checked here even though backslash conversion happens
  // later: doing it in the other order let `a\..` reach the trimmer as a single
  // segment, lose its dots, and come out clean. Any rule that can DELETE a `..`
  // has to run after every rule that can CREATE one.
  if (/(?:^|[/\\])\.\.[/\\]*$/.test(s)) return { path: s };

  s = s.replace(LEADING_NOISE, '');
  s = unwrap(s.trim()).trim();

  let pos: Omit<ParsedRef, 'path'> = {};
  for (const { re, map } of POSITION_PATTERNS) {
    const m = s.match(re);
    if (m) {
      pos = map(m);
      s = s.slice(0, m.index);
      break;
    }
  }

  // Now that any position is off the end, remaining tail punctuation is prose.
  s = s.replace(TRAILING_NOISE, '');
  // A second unwrap pass: `(src/a.ts)` becomes `src/a.ts` only after the ')' that
  // the position matcher might have consumed is accounted for.
  s = unwrap(s.trim()).trim().replace(TRAILING_NOISE, '');
  s = normalizeSeparators(s);
  // Trailing slash carries no information for us (a dir ref is a dir ref) and a
  // pathspec built from it would be wrong.
  if (s.length > 1) s = s.replace(/\/+$/, '');

  return { path: s, ...pos };
}

/**
 * True when a reference must not be searched for at all.
 *
 * Traversal is checked SEGMENT-wise, not by substring: `mod..old/thing.ts` is a
 * perfectly ordinary filename that the old substring check rejected outright, so
 * the file became unreachable. Only a segment that IS `..` escapes a directory.
 *
 * Shell metacharacters stay banned wholesale. Nothing here is passed through a
 * shell (every subprocess uses argv), but the reference also reaches `git`
 * pathspecs and remote daemons, so the narrow rule is the safe one.
 */
export function isUnsafePathRef(ref: string): boolean {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 4096) return true;
  if (ref.includes('\0')) return true;
  if (/[;&|`$(){}!<>\n\r]/.test(ref)) return true;
  // Split on BOTH separators: this function is also called on raw, unparsed input
  // (the HTTP edges guard the reference before anything normalizes it), where a
  // Windows-style `a\..\b` is the same escape as `a/../b`.
  return ref.split(/[/\\]/).some((seg) => seg === '..');
}
