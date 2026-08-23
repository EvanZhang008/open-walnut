/**
 * Auto hybrid layout segmentation (diffAutoSegment.ts): in auto mode each
 * hunk is sliced into per-region segments — an in-place replacement (a run
 * with both deletes and inserts) earns split, everything else stays unified.
 * Built on REAL parsed hunks via buildFileData (createPatch → parseDiff with
 * nearbySequences 'zip'), the exact pipeline the component feeds it.
 *
 * Runs under vitest.diff-view.config.ts.
 */
import { describe, it, expect } from 'vitest';
import type { HunkData } from 'react-diff-view';
import { buildFileData } from '@/components/sessions/diffPatch';
import { segmentHunkForAuto } from '@/components/sessions/diffAutoSegment';
import type { SessionFileChange } from '@/api/session-changes';

function change(before: string, after: string): SessionFileChange {
  return { filePath: '/abs/f.ts', relPath: 'f.ts', before, after, status: 'modified', ops: [], partial: false };
}

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `L${i + 1}`).join('\n') + '\n';

function firstHunk(before: string, after: string): HunkData {
  const file = buildFileData(change(before, after))!;
  expect(file).not.toBeNull();
  return file.hunks[0]!;
}

describe('segmentHunkForAuto — per-region split/unified slicing', () => {
  it('a pure insertion block yields NO split segment (full-width unified)', () => {
    const before = numbered(50);
    const after = before.replace('L25\n', 'L25\nnew1\nnew2\nnew3\n');
    const segs = segmentHunkForAuto(firstHunk(before, after));
    expect(segs.some((s) => s.viewType === 'split')).toBe(false);
    // Adjacent unified pieces merge — a no-replacement hunk stays ONE table.
    expect(segs.length).toBe(1);
  });

  it('an in-place replacement absorbs its short surrounding context into ONE split table', () => {
    const before = numbered(50);
    const after = before.replace('L25\n', 'L25-edited\n');
    const hunk = firstHunk(before, after);
    const segs = segmentHunkForAuto(hunk);

    // The context pieces around the replacement are ≤ ABSORB_MAX_ROWS, so the
    // whole hunk renders as one continuous side-by-side table — a
    // unified→split→unified flip for 20 lines of context each way made the
    // eye re-find its column twice for no benefit.
    expect(segs.length).toBe(1);
    expect(segs[0]!.viewType).toBe('split');
    expect(segs[0]!.hunk.changes.some((c) => c.type === 'delete')).toBe(true);
    expect(segs[0]!.hunk.changes.some((c) => c.type === 'insert')).toBe(true);
  });

  it('dense replacements with small context between them coalesce into ONE split run', () => {
    const before = numbered(120);
    let after = before;
    // Three in-place edits ~10 lines apart — the layout must NOT alternate.
    for (const n of [40, 50, 60]) after = after.replace(`L${n}\n`, `L${n}-edited\n`);
    const segs = segmentHunkForAuto(firstHunk(before, after));
    expect(segs.filter((s) => s.viewType === 'split').length).toBe(1);
    expect(segs.length).toBe(1);
  });

  it('asymmetric replacement (many old lines → one new) still earns split', () => {
    const before = numbered(60);
    const after = before.replace('L30\nL31\nL32\nL33\n', 'rewritten\n');
    const segs = segmentHunkForAuto(firstHunk(before, after));
    const split = segs.find((s) => s.viewType === 'split');
    expect(split).toBeDefined();
    expect(split!.hunk.changes.filter((c) => c.type === 'delete').length).toBe(4);
    expect(split!.hunk.changes.filter((c) => c.type === 'insert').length).toBe(1);
  });

  it('replacement AND a separate BIG pure-insert block: the insert stays unified', () => {
    const before = numbered(80);
    const added = Array.from({ length: 20 }, (_, i) => `added${i + 1}`).join('\n');
    const after = before
      .replace('L30\n', 'L30-edited\n')          // in-place → split
      .replace('L40\n', `L40\n${added}\n`);      // 20 inserted rows > ABSORB_MAX_EDIT_ROWS
    const segs = segmentHunkForAuto(firstHunk(before, after));
    const splits = segs.filter((s) => s.viewType === 'split');
    expect(splits.length).toBe(1);
    // The big insert block must NOT be dragged into split (blank left column) —
    // it stays inside a unified segment.
    const insertHome = segs.find((s) => s.viewType === 'unified'
      && s.hunk.changes.some((c) => c.type === 'insert' && c.content === 'added1'));
    expect(insertHome).toBeDefined();
  });

  it('a SMALL insert burst right between replacements rides the split run', () => {
    const before = numbered(80);
    const after = before
      .replace('L30\n', 'L30-edited\n')
      .replace('L35\n', 'L35\ntiny1\ntiny2\n')   // 2 inserted rows ≤ ABSORB_MAX_EDIT_ROWS
      .replace('L40\n', 'L40-edited\n');
    const segs = segmentHunkForAuto(firstHunk(before, after));
    // One continuous split table — no unified sliver between the two edits.
    expect(segs.filter((s) => s.viewType === 'split').length).toBe(1);
    expect(segs.length).toBe(1);
  });

  it('segments preserve every change in order and keep line numbers continuous', () => {
    const before = numbered(80);
    const after = before
      .replace('L30\n', 'L30-edited\n')
      .replace('L40\n', 'L40\nadded1\n');
    const hunk = firstHunk(before, after);
    const segs = segmentHunkForAuto(hunk);

    // Concatenated changes === the hunk's changes (same objects, same order) —
    // change keys (comments, selection) must survive slicing.
    const flat = segs.flatMap((s) => s.hunk.changes);
    expect(flat).toEqual(hunk.changes);
    expect(flat.every((c, i) => c === hunk.changes[i])).toBe(true);

    // Line-number bookkeeping: each segment starts where the previous ended,
    // and totals match the source hunk.
    let old = hunk.oldStart;
    let neu = hunk.newStart;
    for (const s of segs) {
      expect(s.hunk.oldStart).toBe(old);
      expect(s.hunk.newStart).toBe(neu);
      old += s.hunk.oldLines;
      neu += s.hunk.newLines;
    }
    expect(old - hunk.oldStart).toBe(hunk.oldLines);
    expect(neu - hunk.newStart).toBe(hunk.newLines);
  });
});
