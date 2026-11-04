/**
 * Pure (React-free) diff construction for the session "Changed" view.
 *
 * Split out of SessionDiffView.tsx so the crash-prone createPatch → parseDiff →
 * tokenize pipeline can be unit-tested with the real `diff` + `react-diff-view`
 * libraries (no DOM, no CSS import). The original bug — a blank page on every
 * diff — lived here: `diff`'s createPatch emits an `Index:/===/--- name` unidiff
 * preamble, but react-diff-view's parser only normalizes `diff --git` headers and
 * throws synchronously on anything else, unmounting the whole React tree.
 */
import { createPatch } from 'diff';
import { parseDiff, type FileData, type TokenizeEnhancer } from 'react-diff-view';
import type { SessionFileChange } from '@/api/session-changes';

/**
 * Turn `diff`'s createPatch output into a git-style patch react-diff-view parses
 * reliably. We drop createPatch's preamble (everything before the first `@@` hunk
 * header) and prepend a real `diff --git` header — the path react-diff-view
 * normalizes without mangling. Returns null when there are no hunks (identical
 * content shouldn't reach here, but be safe).
 */
/** Context lines around each change. git's default 3 was too stingy for code
 *  review — you could see THAT a line changed but not the function around it,
 *  and kept clicking expand. 20 gives real surroundings, and nearby hunks
 *  (≤40 lines apart) merge into one continuous block via context overlap. */
export const PATCH_CONTEXT = 20;

/** Options of a built diff. */
export interface DiffBuildOptions {
  /** Lines that differ only in whitespace count as unchanged (git diff -w):
   *  every space, tab and line ending is ignored when two lines are compared.
   *  Unchanged lines show the AFTER side's text. */
  ignoreWhitespace?: boolean;
}

const stripWhitespace = (line: string): string => line.replace(/\s+/g, '');
/** jsdiff line comparator for ignoreWhitespace. */
const whitespaceBlindEquals = (left: string, right: string): boolean => left === right || stripWhitespace(left) === stripWhitespace(right);

export function toGitStylePatch(relPath: string, before: string, after: string, opts?: DiffBuildOptions): string | null {
  const raw = createPatch(relPath, before, after, '', '', {
    context: PATCH_CONTEXT,
    ...(opts?.ignoreWhitespace ? { comparator: whitespaceBlindEquals } : {}),
  });
  const lines = raw.split('\n');
  const hunkIdx = lines.findIndex((l) => l.startsWith('@@'));
  if (hunkIdx < 0) return null;
  const body = lines.slice(hunkIdx).join('\n');
  return [
    `diff --git a/${relPath} b/${relPath}`,
    'index 0000000..1111111 100644',
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    body,
  ].join('\n');
}

/**
 * Build a parsed FileData from a change's before/after via an in-memory git-style
 * diff. No git process — createPatch synthesizes the patch, parseDiff turns it
 * into hunks. Returns null for a no-op diff or any parse failure (so one
 * malformed diff can never throw out of the caller's useMemo and blank the panel).
 */
export function buildFileData(change: SessionFileChange, opts?: DiffBuildOptions): FileData | null {
  // Identical content (Edit whose old==new, or reconstruction collapsed to a
  // no-op) → nothing to show.
  if (change.before === change.after) return null;
  try {
    const patch = toGitStylePatch(change.relPath, change.before, change.after, opts);
    if (!patch) return null;
    const files = parseDiff(patch, { nearbySequences: 'zip' });
    return files[0] ?? null;
  } catch {
    return null;
  }
}

/** True when two texts differ, but only in whitespace (so ignoreWhitespace hides it all). */
export function differsOnlyInWhitespace(before: string, after: string): boolean {
  return before !== after && stripWhitespace(before) === stripWhitespace(after);
}

/** One node of a token path (a path runs root to leaf; a line is a list of paths). */
type PathNode = Parameters<TokenizeEnhancer>[0][0][number][number][number];

/**
 * A tokenize enhancer for Ignore whitespace, run after markEdits: a run of
 * marked text keeps its mark only between its first and last non-space
 * character, and a run of nothing but spaces or tabs loses it. Otherwise a
 * re-indented line that also changed one word still lit up its new
 * indentation (spaces between marked words stay marked: the run is one edit).
 */
export const unmarkWhitespaceEdits: TokenizeEnhancer = ([oldLines, newLines]) => [oldLines.map(unmarkLine), newLines.map(unmarkLine)];

const editAt = (p: PathNode[]): number => p.findIndex((n) => n.type === 'edit');
const leafText = (p: PathNode[]): string => {
  const leaf = p[p.length - 1];
  return leaf && typeof leaf.value === 'string' ? (leaf.value as string) : '';
};
const withoutEdit = (p: PathNode[]): PathNode[] => {
  const at = editAt(p);
  return at < 0 ? p : [...p.slice(0, at), ...p.slice(at + 1)];
};
const withText = (p: PathNode[], v: string): PathNode[] => [...p.slice(0, -1), { ...p[p.length - 1]!, value: v }];

function unmarkLine(paths: PathNode[][]): PathNode[][] {
  const out: PathNode[][] = [];
  for (let i = 0; i < paths.length;) {
    if (editAt(paths[i]!) < 0) { out.push(paths[i]!); i++; continue; }
    let j = i;
    while (j < paths.length && editAt(paths[j]!) >= 0) j++;
    const run = paths.slice(i, j);
    const text = run.map(leafText).join('');
    const from = text.length - text.trimStart().length;
    const to = text.trimEnd().length;
    let pos = 0;
    for (const p of run) {
      const v = leafText(p);
      const s0 = pos;
      const e0 = pos + v.length;
      pos = e0;
      if (from >= to) { out.push(withoutEdit(p)); continue; }
      if (s0 >= from && e0 <= to) { out.push(p); continue; }
      const a = Math.min(Math.max(from - s0, 0), v.length);
      const b = Math.min(Math.max(to - s0, 0), v.length);
      if (a > 0) out.push(withText(withoutEdit(p), v.slice(0, a)));
      if (b > a) out.push(withText(p, v.slice(a, b)));
      if (v.length > b) out.push(withText(withoutEdit(p), v.slice(b)));
    }
    i = j;
  }
  return out;
}
