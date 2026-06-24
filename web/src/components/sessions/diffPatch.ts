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
import { parseDiff, type FileData } from 'react-diff-view';
import type { SessionFileChange } from '@/api/session-changes';

/**
 * Turn `diff`'s createPatch output into a git-style patch react-diff-view parses
 * reliably. We drop createPatch's preamble (everything before the first `@@` hunk
 * header) and prepend a real `diff --git` header — the path react-diff-view
 * normalizes without mangling. Returns null when there are no hunks (identical
 * content shouldn't reach here, but be safe).
 */
export function toGitStylePatch(relPath: string, before: string, after: string): string | null {
  const raw = createPatch(relPath, before, after, '', '', { context: 3 });
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
export function buildFileData(change: SessionFileChange): FileData | null {
  // Identical content (Edit whose old==new, or reconstruction collapsed to a
  // no-op) → nothing to show.
  if (change.before === change.after) return null;
  try {
    const patch = toGitStylePatch(change.relPath, change.before, change.after);
    if (!patch) return null;
    const files = parseDiff(patch, { nearbySequences: 'zip' });
    return files[0] ?? null;
  } catch {
    return null;
  }
}
