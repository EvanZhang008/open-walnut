/**
 * HIGH-FIDELITY gate for the "expand collapsed context" (unfold) control in the
 * session "Changed" view (the user request: "it should have a way to expand the
 * nearby [context]; right now it auto-collapses and never expands").
 *
 * Two layers, both against the REAL react-diff-view from web/node_modules:
 *   1. computeExpandGaps geometry — for a real parsed diff with a real collapsed
 *      block, assert which [start,end) OLD-side ranges each unfold button targets.
 *   2. End-to-end reveal — feed those exact ranges to the real expandFromRawCode
 *      (+ the full old source) and assert the hidden context lines actually
 *      reappear as NORMAL changes with the right content. A reverted fix (no
 *      expansion, or wrong line math) fails here loudly, not in the browser.
 *
 * Runs under vitest.diff-view.config.ts (repo-root-rooted, react-diff-view aliased
 * to its ESM bundle). Pure data — no DOM, the component is never mounted.
 */
import { describe, it, expect } from 'vitest';
import { expandFromRawCode, isNormal, type HunkData } from 'react-diff-view';
import { buildFileData } from '@/components/sessions/diffPatch';
import { computeExpandGaps, oldSourceLineCount, UNFOLD_CHUNK } from '@/components/sessions/diffExpand';
import type { SessionFileChange } from '@/api/session-changes';

function change(before: string, after: string): SessionFileChange {
  return { filePath: '/abs/f.ts', relPath: 'f.ts', before, after, status: 'modified', ops: [], partial: false };
}

/** Build a numbered-line file "L1\nL2\n…\nLn\n". */
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `L${i + 1}`).join('\n') + '\n';

/** All NORMAL (context) change contents across a hunk list, in render order. */
function normalContents(hunks: HunkData[]): string[] {
  const out: string[] = [];
  for (const h of hunks) for (const c of h.changes) if (isNormal(c)) out.push(c.content);
  return out;
}

describe('oldSourceLineCount — the ceiling expansion can draw from', () => {
  it('counts lines, dropping the lone trailing newline (no phantom final line)', () => {
    expect(oldSourceLineCount('a\nb\nc\n')).toBe(3);
    expect(oldSourceLineCount('a\nb\nc')).toBe(3);   // no trailing newline
    expect(oldSourceLineCount('')).toBe(0);
    expect(oldSourceLineCount(null)).toBe(0);
    expect(oldSourceLineCount(undefined)).toBe(0);
  });
});

describe('computeExpandGaps — which hidden lines each unfold button reveals', () => {
  it('no old source → no gaps (nothing to reveal, e.g. a brand-new file)', () => {
    const file = buildFileData(change('', 'new\n'))!;
    expect(computeExpandGaps(file.hunks, 0)).toEqual([]);
  });

  it('a single change in a long file yields a LEADING gap (above) and a TRAILING gap (below)', () => {
    // 120-line file; change only line 60 → with PATCH_CONTEXT=20 the diff shows
    // ~lines 40-80, hiding 1-39 above and 81-120 below. Both gaps are bigger
    // than one chunk → both get directional buttons.
    const before = numbered(120);
    const after = before.replace('L60\n', 'L60-edited\n');
    const file = buildFileData(change(before, after))!;
    const gaps = computeExpandGaps(file.hunks, oldSourceLineCount(before));

    // Exactly two gaps: one before hunk 0 (leading), one trailing (after last hunk).
    expect(gaps.map((g) => g.hunkIndex)).toEqual([0, file.hunks.length]);
    const [leading, trailing] = gaps;

    // Leading gap starts at old line 1. Big gap → offers `up` (reveal just above
    // the hunk) but NOT `down` (no hunk above the file's very top to grow from).
    expect(leading!.all[0]).toBe(1);
    expect(leading!.lines).toBeGreaterThan(UNFOLD_CHUNK);
    expect(leading!.down).toBeUndefined();
    expect(leading!.up).toBeDefined();
    // `up` reveals exactly the last UNFOLD_CHUNK lines of the gap (abutting the hunk).
    expect(leading!.up![1] - leading!.up![0]).toBe(UNFOLD_CHUNK);
    expect(leading!.up![1]).toBe(leading!.all[1]);

    // Trailing gap reaches EOF and only has a hunk ABOVE → offers `down`, never `up`.
    expect(trailing!.all[1]).toBe(oldSourceLineCount(before) + 1);
    expect(trailing!.lines).toBeGreaterThan(UNFOLD_CHUNK);
    expect(trailing!.down).toBeDefined();
    expect(trailing!.up).toBeUndefined();
    expect(trailing!.down![0]).toBe(trailing!.all[0]);
    expect(trailing!.down![1] - trailing!.down![0]).toBe(UNFOLD_CHUNK);
  });

  it('a small gap between two nearby changes → "expand all" only (no directional chunks)', () => {
    // Edit line 30 and line 80 of a 120-line file. With PATCH_CONTEXT=20 the two
    // hunks (L10-L50, L60-L100) stay separate, leaving a small hidden block
    // (L51-L59, ≤ UNFOLD_CHUNK) between them → a single "expand all", no chunks.
    const before = numbered(120);
    const after = before.replace('L30\n', 'L30x\n').replace('L80\n', 'L80x\n');
    const file = buildFileData(change(before, after))!;
    expect(file.hunks.length).toBe(2); // two separate hunks with a real gap between
    const gaps = computeExpandGaps(file.hunks, oldSourceLineCount(before));

    const between = gaps.find((g) => g.hunkIndex === 1);
    expect(between).toBeDefined();
    expect(between!.lines).toBeGreaterThan(0);
    expect(between!.lines).toBeLessThanOrEqual(UNFOLD_CHUNK);
    expect(between!.up).toBeUndefined();
    expect(between!.down).toBeUndefined();
    // "expand all" spans the whole hidden block between the two hunks.
    expect(between!.all[0]).toBeLessThan(between!.all[1]);
  });

  it('no hidden lines anywhere (every line changed) → no gaps', () => {
    const before = 'a\nb\nc\n';
    const after = 'A\nB\nC\n';
    const file = buildFileData(change(before, after))!;
    // One hunk covering the whole file, nothing collapsed around it.
    expect(computeExpandGaps(file.hunks, oldSourceLineCount(before))).toEqual([]);
  });
});

describe('end-to-end reveal — the computed ranges actually un-hide the right source', () => {
  it('"expand all" on the leading gap brings back lines 1..N as NORMAL context', () => {
    const before = numbered(60);
    const after = before.replace('L30\n', 'L30-edited\n');
    const file = buildFileData(change(before, after))!;
    const gaps = computeExpandGaps(file.hunks, oldSourceLineCount(before));
    const leading = gaps.find((g) => g.hunkIndex === 0)!;

    const beforeReveal = normalContents(file.hunks);
    expect(beforeReveal).not.toContain('L1');  // line 1 is hidden initially
    expect(beforeReveal).not.toContain('L5');

    // Reveal the leading gap with the EXACT range the "expand all" button uses.
    const expanded = expandFromRawCode(file.hunks, before, leading.all[0], leading.all[1]);
    const afterReveal = normalContents(expanded);
    // The previously-hidden top-of-file context is now present.
    expect(afterReveal).toContain('L1');
    expect(afterReveal).toContain('L10');
    expect(afterReveal).toContain('L26');
    // And the edited region is still intact (the hunk's own context survives).
    expect(afterReveal.length).toBeGreaterThan(beforeReveal.length);
  });

  it('directional "↑ N" reveals only the chunk abutting the hunk, not the whole gap', () => {
    // Change deep enough (L80 of 120) that the leading gap (L1-L59) stays bigger
    // than one chunk even with PATCH_CONTEXT=20 — directional ↑ only exists then.
    const before = numbered(120);
    const after = before.replace('L80\n', 'L80-edited\n');
    const file = buildFileData(change(before, after))!;
    const gaps = computeExpandGaps(file.hunks, oldSourceLineCount(before));
    const leading = gaps.find((g) => g.hunkIndex === 0)!;
    expect(leading.up).toBeDefined();

    const expanded = expandFromRawCode(file.hunks, before, leading.up![0], leading.up![1]);
    const revealed = normalContents(expanded);
    // The chunk just above the hunk is revealed…
    expect(revealed).toContain(`L${leading.up![1] - 1}`);
    // …but the very top of the file is still hidden (we only grew one chunk).
    expect(revealed).not.toContain('L1');
  });

  it('"expand all" on the trailing gap brings back the tail down to EOF', () => {
    const before = numbered(60);
    const after = before.replace('L30\n', 'L30-edited\n');
    const file = buildFileData(change(before, after))!;
    const oldN = oldSourceLineCount(before);
    const trailing = computeExpandGaps(file.hunks, oldN).find((g) => g.hunkIndex === file.hunks.length)!;

    const expanded = expandFromRawCode(file.hunks, before, trailing.all[0], trailing.all[1]);
    const revealed = normalContents(expanded);
    expect(revealed).toContain(`L${oldN}`);       // last line of the file
    expect(revealed).toContain(`L${oldN - 5}`);   // and its neighbours
  });
});
