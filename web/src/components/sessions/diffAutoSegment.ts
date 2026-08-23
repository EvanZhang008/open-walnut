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

// Layout flips are a reading cost: every split↔unified boundary makes the eye
// re-find its column. A unified stretch sandwiched between (or leaning on)
// split segments is absorbed INTO the split run when it's small enough that
// one continuous side-by-side table reads better than three alternating ones:
//   - context rows render usefully on both sides, so up to a full merged
//     between-hunk gap (2× the 20-line patch context) may ride along;
//   - pure insert/delete rows show a blank half in split — only a short burst
//     is tolerable before the blank column becomes the old per-file problem.
const ABSORB_MAX_ROWS = 40;
const ABSORB_MAX_EDIT_ROWS = 12;

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

  // Pass 2.5: coalesce. Small unified pieces adjacent to a split piece join
  // the split run (see ABSORB_* above), then same-layout neighbours re-merge.
  // Loops to a fixpoint: each absorption can bring the next small piece into
  // contact with the (grown) split run. Bounded by the piece count.
  const absorbable = (p: Piece): boolean => {
    if (p.viewType !== 'unified' || p.changes.length > ABSORB_MAX_ROWS) return false;
    const editRows = p.changes.reduce((n, c) => n + (c.type === 'normal' ? 0 : 1), 0);
    return editRows <= ABSORB_MAX_EDIT_ROWS;
  };
  for (;;) {
    const i = pieces.findIndex((p, idx) => absorbable(p)
      && (pieces[idx - 1]?.viewType === 'split' || pieces[idx + 1]?.viewType === 'split'));
    if (i < 0) break;
    pieces[i]!.viewType = 'split';
    // Re-merge with the split neighbour(s) so the run is one piece again.
    if (pieces[i + 1]?.viewType === 'split') {
      pieces[i]!.changes.push(...pieces[i + 1]!.changes);
      pieces.splice(i + 1, 1);
    }
    if (pieces[i - 1]?.viewType === 'split') {
      pieces[i - 1]!.changes.push(...pieces[i]!.changes);
      pieces.splice(i, 1);
    }
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
