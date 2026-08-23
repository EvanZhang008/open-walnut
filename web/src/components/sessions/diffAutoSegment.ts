/**
 * Hybrid "auto" layout segmentation for the session diff.
 *
 * A per-file split/unified choice wastes screen either way: one in-place edit
 * flips a 700-line-insertion file to split (blank left column all the way
 * down, unchanged context duplicated on both sides), while forcing unified
 * robs a real replacement of its side-by-side comparison. Auto instead slices
 * each hunk's change list into RUNS and gives each run the layout it earns:
 *
 *   - a run holding BOTH deletes and inserts (an in-place replacement — the
 *     only case where there are two sides to compare) → its own SPLIT segment;
 *   - everything else (context, pure insertions, pure deletions) → UNIFIED,
 *     full width.
 *
 * Each segment becomes a synthetic HunkData rendered by its own <Diff>. The
 * ChangeData objects are reused by reference, so change keys — and everything
 * keyed on them (comments, gutter events, selection, search) — stay stable.
 */
import type { ChangeData, HunkData } from 'react-diff-view';

export interface DiffSegment {
  viewType: 'split' | 'unified';
  hunk: HunkData;
}

/** Slice one (possibly expanded) hunk into ordered unified/split segments. */
export function segmentHunkForAuto(hunk: HunkData): DiffSegment[] {
  // Pass 1: group consecutive changes into edit runs vs context runs.
  interface Group { edit: boolean; changes: ChangeData[] }
  const groups: Group[] = [];
  for (const c of hunk.changes) {
    const edit = c.type === 'delete' || c.type === 'insert';
    const last = groups[groups.length - 1];
    if (last && last.edit === edit) last.changes.push(c);
    else groups.push({ edit, changes: [c] });
  }

  // Pass 2: pick each group's layout, then merge same-layout neighbours.
  // Size asymmetry does NOT demote a replacement to unified: replacing 10 old
  // lines with 2 new ones still has two sides worth comparing.
  interface Piece { viewType: DiffSegment['viewType']; changes: ChangeData[] }
  const pieces: Piece[] = [];
  for (const g of groups) {
    const paired = g.edit
      && g.changes.some((c) => c.type === 'delete')
      && g.changes.some((c) => c.type === 'insert');
    const viewType = paired ? 'split' : 'unified';
    const last = pieces[pieces.length - 1];
    if (last && last.viewType === viewType) last.changes.push(...g.changes);
    else pieces.push({ viewType, changes: [...g.changes] });
  }

  // Pass 3: synthesize a HunkData per piece with correct line-number starts.
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const out: DiffSegment[] = [];
  for (const p of pieces) {
    const oldStart = oldLine;
    const newStart = newLine;
    for (const c of p.changes) {
      if (c.type === 'normal') { oldLine++; newLine++; }
      else if (c.type === 'delete') oldLine++;
      else newLine++;
    }
    const oldLines = oldLine - oldStart;
    const newLines = newLine - newStart;
    out.push({
      viewType: p.viewType,
      hunk: {
        ...hunk,
        oldStart,
        oldLines,
        newStart,
        newLines,
        changes: p.changes,
        // content doubles as the React key — line numbers make it unique.
        content: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
      },
    });
  }
  return out;
}
