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

  it('an in-place replacement becomes its own split segment; context stays unified', () => {
    const before = numbered(50);
    const after = before.replace('L25\n', 'L25-edited\n');
    const hunk = firstHunk(before, after);
    const segs = segmentHunkForAuto(hunk);

    const splits = segs.filter((s) => s.viewType === 'split');
    expect(splits.length).toBe(1);
    // The split segment holds ONLY the paired edit rows — no context rides
    // along (duplicated identical left/right context was the complaint).
    expect(splits[0]!.hunk.changes.every((c) => c.type !== 'normal')).toBe(true);
    expect(splits[0]!.hunk.changes.some((c) => c.type === 'delete')).toBe(true);
    expect(splits[0]!.hunk.changes.some((c) => c.type === 'insert')).toBe(true);
    // unified → split → unified, in order.
    expect(segs.map((s) => s.viewType)).toEqual(['unified', 'split', 'unified']);
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

  it('replacement AND a separate pure-insert block: only the replacement splits', () => {
    const before = numbered(80);
    const after = before
      .replace('L30\n', 'L30-edited\n')                      // in-place → split
      .replace('L40\n', 'L40\nadded1\nadded2\nadded3\n');    // pure insert → unified
    const segs = segmentHunkForAuto(firstHunk(before, after));
    const splits = segs.filter((s) => s.viewType === 'split');
    expect(splits.length).toBe(1);
    // The insert block stayed inside a unified segment.
    const insertHome = segs.find((s) => s.viewType === 'unified'
      && s.hunk.changes.some((c) => c.type === 'insert' && c.content === 'added1'));
    expect(insertHome).toBeDefined();
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
