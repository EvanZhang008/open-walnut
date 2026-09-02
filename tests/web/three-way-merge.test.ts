/**
 * Three-way merge for Live Edit mode.
 *
 * What is actually at stake: this function decides whether the user's typing and
 * an agent's write to the SAME file can both survive. A false "clean" silently
 * deletes one of them; a false "conflict" only costs a banner, so the rule is
 * deliberately conservative — but it must still be clean for the cases that
 * happen constantly (two people editing different parts of a file, both
 * appending, the same edit arriving twice).
 *
 * The trailing-newline and CRLF cases are here because they are how a merge
 * quietly rewrites a whole file: an "off by one newline" result shows up in git
 * as every line changed.
 */
import { describe, it, expect } from 'vitest';
import { threeWayMerge, diffToHunks } from '../../web/src/utils/three-way-merge';

/** The merged text, or a readable failure when the merge conflicted. */
function merged(base: string, ours: string, theirs: string): string {
  const res = threeWayMerge(base, ours, theirs);
  if (!res.ok) throw new Error(`expected a clean merge, got ${res.conflicts} conflict(s)`);
  return res.merged;
}

describe('diffToHunks', () => {
  it('expresses a replacement as ONE hunk in base coordinates', () => {
    // Two removed lines + three added ones is a single edit, not two — merging
    // them is what keeps a side from conflicting with itself.
    const hunks = diffToHunks(['a', 'b', 'c', 'd'], ['a', 'X', 'Y', 'Z', 'd']);
    expect(hunks).toEqual([{ baseStart: 1, baseEnd: 3, lines: ['X', 'Y', 'Z'] }]);
  });

  it('gives a pure insertion an EMPTY base range', () => {
    const hunks = diffToHunks(['a', 'b'], ['a', 'new', 'b']);
    expect(hunks).toEqual([{ baseStart: 1, baseEnd: 1, lines: ['new'] }]);
  });

  it('gives a deletion an empty replacement', () => {
    const hunks = diffToHunks(['a', 'b', 'c'], ['a', 'c']);
    expect(hunks).toEqual([{ baseStart: 1, baseEnd: 2, lines: [] }]);
  });

  it('returns nothing for identical inputs', () => {
    expect(diffToHunks(['a', 'b'], ['a', 'b'])).toEqual([]);
  });
});

describe('threeWayMerge — clean cases', () => {
  it('merges edits in different regions', () => {
    const base = 'one\ntwo\nthree\nfour\nfive\n';
    const ours = 'ONE\ntwo\nthree\nfour\nfive\n';
    const theirs = 'one\ntwo\nthree\nfour\nFIVE\n';
    expect(merged(base, ours, theirs)).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
  });

  it('merges when both sides append', () => {
    const base = 'a\nb\n';
    expect(merged(base, 'a\nb\nours\n', 'a\nb\ntheirs\n')).toBe('a\nb\nours\ntheirs\n');
  });

  it('merges when one side deletes a block the other left alone', () => {
    const base = 'keep\ndrop1\ndrop2\nkeep2\ntail\n';
    const ours = 'keep\ndrop1\ndrop2\nkeep2\nTAIL\n';
    const theirs = 'keep\nkeep2\ntail\n';
    expect(merged(base, ours, theirs)).toBe('keep\nkeep2\nTAIL\n');
  });

  it('applies an identical edit made on both sides once', () => {
    const base = 'a\nb\nc\n';
    const same = 'a\nB!\nc\n';
    expect(merged(base, same, same)).toBe('a\nB!\nc\n');
  });

  it('applies an identical deletion made on both sides once', () => {
    const base = 'a\nb\nc\n';
    expect(merged(base, 'a\nc\n', 'a\nc\n')).toBe('a\nc\n');
  });

  it('merges ADJACENT edits (ours line 5, theirs line 6)', () => {
    // Touching base ranges are half-open, so [4,5) and [5,6) do not overlap.
    const base = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n';
    const ours = 'l1\nl2\nl3\nl4\nOURS\nl6\nl7\n';
    const theirs = 'l1\nl2\nl3\nl4\nl5\nTHEIRS\nl7\n';
    expect(merged(base, ours, theirs)).toBe('l1\nl2\nl3\nl4\nOURS\nTHEIRS\nl7\n');
  });

  it('takes theirs when our buffer never diverged from base', () => {
    const base = 'a\nb\n';
    expect(merged(base, base, 'a\nb\nc\n')).toBe('a\nb\nc\n');
  });

  it('takes ours when disk never diverged from base', () => {
    const base = 'a\nb\n';
    expect(merged(base, 'a\nb\nmine\n', base)).toBe('a\nb\nmine\n');
  });

  it('merges into an EMPTY base', () => {
    expect(merged('', 'hello\n', '')).toBe('hello\n');
    // Both sides wrote into an empty file at the same (empty) position.
    expect(merged('', 'ours\n', 'theirs\n')).toBe('ours\ntheirs\n');
  });

  it('merges a whole-file rewrite by one side only', () => {
    const base = 'a\nb\nc\n';
    expect(merged(base, 'totally different\n', base)).toBe('totally different\n');
  });
});

describe('threeWayMerge — conflicts', () => {
  it('reports a conflict when both sides changed the SAME line differently', () => {
    const res = threeWayMerge('a\nb\nc\n', 'a\nOURS\nc\n', 'a\nTHEIRS\nc\n');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.conflicts).toBe(1);
  });

  it('reports a conflict when their replacement swallows our edited line', () => {
    const base = 'l1\nl2\nl3\nl4\n';
    const res = threeWayMerge(base, 'l1\nl2\nOURS\nl4\n', 'l1\nX\nY\nl4\n');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.conflicts).toBeGreaterThanOrEqual(1);
  });

  it('reports a conflict when one side deletes the block the other edited', () => {
    const base = 'a\nb\nc\nd\n';
    const res = threeWayMerge(base, 'a\nb-edited\nc\nd\n', 'a\nd\n');
    expect(res.ok).toBe(false);
  });

  it('counts each independent overlap', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng\n';
    const ours = 'a\nB1\nc\nd\ne\nF1\ng\n';
    const theirs = 'a\nB2\nc\nd\ne\nF2\ng\n';
    const res = threeWayMerge(base, ours, theirs);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.conflicts).toBe(2);
  });

  it('still merges the non-overlapping region cleanly when nothing overlaps', () => {
    // Guards the counter itself: three separate regions, all disjoint.
    const base = 'a\nb\nc\nd\ne\n';
    const ours = 'A\nb\nc\nd\ne\n';
    const theirs = 'a\nb\nC\nd\nE\n';
    expect(merged(base, ours, theirs)).toBe('A\nb\nC\nd\nE\n');
  });
});

describe('threeWayMerge — line endings', () => {
  it('keeps a missing trailing newline', () => {
    const base = 'a\nb';
    expect(merged(base, 'A\nb', 'a\nB')).toBe('A\nB');
  });

  it('keeps a present trailing newline', () => {
    const base = 'a\nb\n';
    expect(merged(base, 'A\nb\n', 'a\nB\n')).toBe('A\nB\n');
  });

  it('honours the side that ADDED the trailing newline', () => {
    const base = 'a\nb';
    // Ours only edits line 1 but also terminates the file; theirs carries base's
    // missing newline along, so ours is the intent.
    expect(merged(base, 'A\nb\n', 'a\nB')).toBe('A\nB\n');
  });

  it('honours the side that REMOVED the trailing newline', () => {
    const base = 'a\nb\n';
    expect(merged(base, 'A\nb', 'a\nB\n')).toBe('A\nB');
  });

  it('merges CRLF input and writes CRLF back out', () => {
    const base = 'a\r\nb\r\nc\r\n';
    const ours = 'A\r\nb\r\nc\r\n';
    const theirs = 'a\r\nb\r\nC\r\n';
    expect(merged(base, ours, theirs)).toBe('A\r\nb\r\nC\r\n');
  });

  it('does not treat a CRLF/LF difference as an edit', () => {
    // Same lines, different encoding on each side: normalising before the diff
    // is what stops "the agent saved with CRLF" from conflicting with every line.
    const res = threeWayMerge('a\nb\nc\n', 'a\r\nb\r\nc\r\n', 'a\nb\nc\n');
    expect(res.ok).toBe(true);
  });

  it('uses OUR dominant ending when the two sides disagree', () => {
    const base = 'a\nb\nc\n';
    const ours = 'A\r\nb\r\nc\r\n';
    const theirs = 'a\nb\nC\n';
    expect(merged(base, ours, theirs)).toBe('A\r\nb\r\nC\r\n');
  });

  it('handles a single-line file with no line break at all', () => {
    expect(merged('a', 'a', 'b')).toBe('b');
  });

  it('preserves interior empty lines', () => {
    const base = 'a\n\nb\n\nc\n';
    const ours = 'A\n\nb\n\nc\n';
    const theirs = 'a\n\nb\n\nC\n';
    expect(merged(base, ours, theirs)).toBe('A\n\nb\n\nC\n');
  });
});
