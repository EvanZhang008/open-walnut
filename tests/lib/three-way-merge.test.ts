/**
 * Three-way merge for Live Edit mode.
 *
 * What is actually at stake: this function decides whether the user's typing and
 * an agent's write to the SAME file can both survive. A false "clean" silently
 * deletes one of them; a false "conflict" only costs a banner, so the rule is
 * deliberately conservative, but it must still be clean for the cases that
 * happen constantly (two people editing different parts of a file, both
 * appending, the same edit arriving twice).
 *
 * The trailing-newline and CRLF cases are here because they are how a merge
 * quietly rewrites a whole file: an "off by one newline" result shows up in git
 * as every line changed.
 */
import { describe, it, expect } from 'vitest';
import { threeWayMerge, diffToHunks } from '../../src/lib/three-way-merge';

/** The merged text, or a readable failure when the merge conflicted. */
function merged(base: string, ours: string, theirs: string): string {
  const res = threeWayMerge(base, ours, theirs);
  if (!res.ok) throw new Error(`expected a clean merge, got ${res.conflicts} conflict(s)`);
  return res.merged;
}

describe('diffToHunks', () => {
  it('expresses a replacement as ONE hunk in base coordinates', () => {
    // Two removed lines + three added ones is a single edit, not two: merging
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

describe('threeWayMerge: clean cases', () => {
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

describe('threeWayMerge: conflicts', () => {
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

describe('threeWayMerge inline edits', () => {
  it.each([
    ['latency 12 ms and retry limit 3', 'latency 10 ms and retry limit 3', 'latency 12 ms and retry limit 5', 'latency 10 ms and retry limit 5'],
    ['| Alpha | 12 ms | pending |', '| Alpha | 10 ms | pending |', '| Alpha | 12 ms | approved |', '| Alpha | 10 ms | approved |'],
    ['Alpha beta gamma', 'Alpha gamma', 'Alpha beta delta', 'Alpha delta'],
    ['caf\u00e9 \u4e2d\u6587 latency 12 retry 3', 'caf\u00e9 \u4e2d\u6587 latency 10 retry 3', 'caf\u00e9 \u4e2d\u6587 latency 12 retry 5', 'caf\u00e9 \u4e2d\u6587 latency 10 retry 5'],
    ['| A | 12 | pending |', '| A  | 10 | pending |', '| A | 12 | approved |', '| A  | 10 | approved |'],
    ['same word and tail', 'changed word and tail', 'same word and ending', 'changed word and ending'],
    ['alpha beta gamma delta epsilon', 'alpha NEW beta gamma delta epsilon', 'alpha beta gamma delta END epsilon', 'alpha NEW beta gamma delta END epsilon'],
    ['alpha beta gamma delta epsilon', 'alpha gamma delta epsilon', 'alpha beta gamma epsilon', 'alpha gamma epsilon'],
    ['alpha beta gamma delta epsilon', 'alpha BETA gamma delta epsilon', 'alpha beta gamma delta', 'alpha BETA gamma delta'],
    ['alpha beta gamma delta epsilon', 'alpha beta gamma delta epsilon plus', 'first alpha beta gamma delta epsilon', 'first alpha beta gamma delta epsilon plus'],
  ])('combines disjoint words in %s', (base, ours, theirs, expected) => {
    expect(merged(base, ours, theirs)).toBe(expected);
    expect(merged(base, theirs, ours)).toBe(expected);
  });

  it.each([
    ['choice original', 'choice human', 'choice agent'],
    ['retry 123', 'retry 124', 'retry 223'],
    ['hello world', 'hello human world', 'hello agent world'],
    ['alpha beta gamma', 'alpha gamma', 'alpha edited gamma'],
    ['top', 'ours-top', 'THEIRS'],
    ['item value', 'item value-added', 'item changed'],
  ])('preserves a real inline conflict in %s', (base, ours, theirs) => {
    expect(threeWayMerge(base, ours, theirs).ok).toBe(false);
    expect(threeWayMerge(base, theirs, ours).ok).toBe(false);
  });

  it('does not duplicate a shared edit while combining another word', () => {
    expect(merged('left 1 middle 2 right 3', 'left 4 middle 2 right 5', 'left 4 middle 6 right 3'))
      .toBe('left 4 middle 6 right 5');
  });

  it('combines separated edits within a long table row', () => {
    const base = `| ${'design detail '.repeat(380)} latency 12 ms | retry limit 3 |`;
    expect(base.length).toBeGreaterThan(4900);
    expect(merged(base, base.replace('12 ms', '10 ms'), base.replace('limit 3', 'limit 5')))
      .toBe(base.replace('12 ms', '10 ms').replace('limit 3', 'limit 5'));
  });

  it('combines one overlapping block with several edits on the other side', () => {
    const base = 'row 1 alpha\nrow 2 beta\nrow 3 gamma\n';
    const ours = 'row 1 ALPHA\nrow 2 BETA\nrow 3 GAMMA\n';
    const theirs = 'ROW 1 alpha\nrow 2 beta\nROW 3 gamma\n';
    expect(merged(base, ours, theirs)).toBe('ROW 1 ALPHA\nrow 2 BETA\nROW 3 GAMMA\n');
  });

  it('preserves both writers across generated same-line and multi-line edits', () => {
    const words = ['alpha', 'beta', 'gamma', 'delta'];
    for (let lines = 1; lines <= 8; lines++) {
      const base = Array.from({ length: lines }, (_, i) => `row${i} alpha${i} beta${i} gamma${i} delta${i}`).join('\n') + '\n';
      for (let x = 0; x < lines * 4; x++) {
        for (let y = 0; y < lines * 4; y++) {
          const a = words[x % 4] + Math.floor(x / 4);
          const b = words[y % 4] + Math.floor(y / 4);
          const ours = base.replace(a, `HUMAN${x}`);
          const theirs = base.replace(b, `AGENT${y}`);
          const result = threeWayMerge(base, ours, theirs);
          if (x === y) expect(result.ok).toBe(false);
          else expect(result).toEqual({ ok: true, merged: base.replace(a, `HUMAN${x}`).replace(b, `AGENT${y}`) });
        }
      }
    }
  });

  it('does not guess line alignment after an overlapping structural rewrite', () => {
    expect(threeWayMerge('latency 12 retry 3\n', 'before\nlatency 10 retry 3\nafter\n', 'latency 12 retry 5\n').ok).toBe(false);
  });

  it('preserves CRLF and the final newline during inline merge', () => {
    expect(merged('first\r\nlatency 12 retry 3\r\n', 'first\r\nlatency 10 retry 3\r\n', 'first\r\nlatency 12 retry 5\r\n'))
      .toBe('first\r\nlatency 10 retry 5\r\n');
  });

  it('combines table edits when serialization also changes alignment spacing', () => {
    const base = '| Option | Latency | Decision |\n|:--|--:|:--:|\n| Alpha | 12 ms | pending |\n';
    const ours = base.replace('|:--|--:|:--:|', '| :-- | --: | :-: |').replace('12 ms', '10 ms');
    const theirs = base.replace('pending', 'approved');
    expect(merged(base, ours, theirs)).toBe(ours.replace('pending', 'approved'));
  });
});

describe('threeWayMerge: line endings', () => {
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

// -- WP11 (docs/plan/walnut-replica-servers-impl.md section 6): the library moved to
// src/lib, a step budget instead of a wall clock, conflict regions, the id line, and
// the N-version merge the Mac's notes drain uses. --

import { Worker } from 'node:worker_threads'
import { afterAll } from 'vitest'
import { mergeVersions, MAX_EDIT_LENGTH, idLineOf } from '../../src/lib/three-way-merge'

describe('threeWayMerge: conflict regions and both resolutions', () => {
  it('lists each region with its base range and both sides, and both full resolutions', () => {
    const base = 'a\nb\nc\nd\ne\n'
    const ours = 'a\nB1\nc\nd\nE1\n'
    const theirs = 'a\nB2\nc\nd\nE2\n'
    const r = threeWayMerge(base, ours, theirs)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.conflicts).toBe(2)
    expect(r.regions).toEqual([
      { baseRange: [1, 2], ours: ['B1'], theirs: ['B2'] },
      { baseRange: [4, 5], ours: ['E1'], theirs: ['E2'] },
    ])
    expect(r.oursText).toBe(ours)
    expect(r.theirsText).toBe(theirs)
    expect(r.overBudget).toBe(false)
  })

  it('a resolution keeps the clean edits of the other side', () => {
    const base = 'one\ntwo\nthree\nfour\nfive\n'
    const ours = 'ONE\ntwo\nthree-ours\nfour\nfive\n'
    const theirs = 'one\ntwo\nthree-theirs\nfour\nFIVE\n'
    const r = threeWayMerge(base, ours, theirs)
    if (r.ok) throw new Error('expected a conflict')
    expect(r.oursText).toBe('ONE\ntwo\nthree-ours\nfour\nFIVE\n')
    expect(r.theirsText).toBe('ONE\ntwo\nthree-theirs\nfour\nFIVE\n')
    // An edit next to a conflicting line is part of that side's hunk: it goes with the region.
    const adjacent = threeWayMerge('a\nb\nc\n', 'a\nB1\nc\n', 'a\nB2\nC2\n')
    if (adjacent.ok) throw new Error('expected a conflict')
    expect(adjacent.oursText).toBe('a\nB1\nc\n')
    expect(adjacent.theirsText).toBe('a\nB2\nC2\n')
  })

  it('an identical insertion made on both sides at one point lands once', () => {
    expect(merged('a\nb\n', 'a\nX\nb\n', 'a\nX\nb\n')).toBe('a\nX\nb\n')
    expect(merged('a\nb\n', 'a\nX\nb\nY\n', 'a\nX\nb\n')).toBe('a\nX\nb\nY\n')
  })

  it('an insertion another side holds inside a longer one at the same point lands once (a save applied, then a longer save on the old base)', () => {
    expect(merged('a\nb\n', 'a\nX\nb\n', 'a\nX\nZ\nb\n')).toBe('a\nX\nZ\nb\n')
    expect(merged('a\nb\n', 'a\nX\nZ\nb\n', 'a\nZ\nb\n')).toBe('a\nX\nZ\nb\n')
    // Two different paragraphs that only share a blank line both stay, as before.
    expect(merged('a\nb\n', 'a\n\nP\nb\n', 'a\n\nQ\nb\n')).toBe('a\n\nP\n\nQ\nb\n')
  })
})

describe('threeWayMerge: the step budget replaces the wall clock', () => {
  it('a line diff past maxEditLength is one region over the whole document', () => {
    const base = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const ours = base.replace(/line/g, 'ours')
    const theirs = base.replace(/line/g, 'theirs')
    const r = threeWayMerge(base, ours, theirs, { maxEditLength: 10 })
    if (r.ok) throw new Error('expected over budget')
    expect(r).toMatchObject({ conflicts: 1, overBudget: true, oursText: ours, theirsText: theirs })
    expect(r.regions[0]!.baseRange).toEqual([0, 50])
  })

  it('the same inputs give the same answer while other threads keep every core busy', async () => {
    const base = Array.from({ length: 400 }, (_, i) => `row ${i} alpha${i} beta${i} gamma${i} delta${i} epsilon${i}`).join('\n') + '\n'
    const ours = base.replace(/alpha(\d+)/g, (_m, n) => (Number(n) % 2 ? `A${n}` : `alpha${n}`))
    const theirs = base.replace(/epsilon(\d+)/g, (_m, n) => (Number(n) % 3 ? `E${n}` : `epsilon${n}`))
    const reference = JSON.stringify(threeWayMerge(base, ours, theirs))
    busy = Array.from({ length: 3 }, () => new Worker('const end = Date.now() + 20000; while (Date.now() < end) {}', { eval: true }))
    for (let i = 0; i < 20; i++) expect(JSON.stringify(threeWayMerge(base, ours, theirs))).toBe(reference)
    expect(JSON.parse(reference).ok).toBe(true)
  }, 60_000)
})

let busy: Worker[] = []
afterAll(async () => { await Promise.all(busy.map((w) => w.terminate())); busy = [] })

describe('threeWayMerge: line endings, the final newline, the id line, Unicode', () => {
  it('keeps CRLF through a line-level merge with a conflict-free edit on each side', () => {
    const base = 'a\r\nb\r\nc\r\nd\r\n'
    expect(merged(base, 'A\r\nb\r\nc\r\nd\r\n', 'a\r\nb\r\nc\r\nD\r\n')).toBe('A\r\nb\r\nc\r\nD\r\n')
  })

  it('keeps a missing final newline when only one side touched the end', () => {
    expect(merged('a\nb', 'A\nb', 'a\nb\nc')).toBe('A\nb\nc')
  })

  it('takes the id: line of the side named by idFrom, so the ids never conflict', () => {
    const base = '---\nid: n_base\ntitle: T\n---\nbody one\nbody two\n'
    const ours = '---\nid: n_ours\ntitle: T\n---\nBODY ONE\nbody two\n'
    const theirs = '---\nid: n_mac\ntitle: T\n---\nbody one\nBODY TWO\n'
    const r = threeWayMerge(base, ours, theirs, { idFrom: 'theirs' })
    expect(r).toEqual({ ok: true, merged: '---\nid: n_mac\ntitle: T\n---\nBODY ONE\nBODY TWO\n' })
    expect(idLineOf(r.ok ? r.merged : '')).toBe('id: n_mac')
  })

  it('merges Unicode text written as \\u escapes word by word', () => {
    const base = 'caf\u00e9 \u4e2d\u6587 \u{1F600} one two\n'
    const ours = 'caf\u00e9 \u4e2d\u6587 \u{1F600} ONE two\n'
    const theirs = 'caf\u00e9 \u65e5\u672c \u{1F600} one two\n'
    expect(merged(base, ours, theirs)).toBe('caf\u00e9 \u65e5\u672c \u{1F600} ONE two\n')
  })
})

describe('threeWayMerge: 1 MB documents', () => {
  const big = Array.from({ length: 20_000 }, (_, i) => `paragraph ${i} ${'x'.repeat(40)}`).join('\n') + '\n'

  it('merges disjoint edits of a 1 MB note at both ends', () => {
    expect(big.length).toBeGreaterThan(1_000_000)
    const ours = big.replace('paragraph 10 ', 'paragraph TEN ')
    const theirs = big.replace('paragraph 19990 ', 'paragraph LAST ')
    expect(merged(big, ours, theirs)).toBe(big.replace('paragraph 10 ', 'paragraph TEN ').replace('paragraph 19990 ', 'paragraph LAST '))
  })

  it('a 1 MB conflict is one region per edited line, both texts whole', () => {
    const ours = big.replace('paragraph 5000 ', 'paragraph OURS ')
    const theirs = big.replace('paragraph 5000 ', 'paragraph THEIRS ')
    const r = threeWayMerge(big, ours, theirs)
    if (r.ok) throw new Error('expected a conflict')
    expect(r.regions.map((x) => x.baseRange)).toEqual([[5000, 5001]])
    expect(r.oursText).toBe(ours)
    expect(r.theirsText).toBe(theirs)
  })

  it('the default budget is the plan\'s 50,000 steps', () => {
    expect(MAX_EDIT_LENGTH).toBe(50_000)
  })
})

describe('mergeVersions: several versions of one note', () => {
  const base = 'a\nb\nc\nd\ne\n'
  const v = (key: string, text: string, at: number) => ({ key, text, at })

  it('applies every clean edit, and the answer does not depend on the order the versions come in', () => {
    const list = [v('mac', 'A\nb\nc\nd\ne\n', 1), v('h1', 'a\nb\nC\nd\ne\n', 2), v('h2', 'a\nb\nc\nd\nE\n', 3)]
    const r = mergeVersions(base, list)
    expect(r).toMatchObject({ text: 'A\nb\nC\nd\nE\n', conflicts: 0, losers: [] })
    for (const order of [[2, 1, 0], [1, 0, 2], [0, 2, 1]]) {
      expect(mergeVersions(base, order.map((i) => list[i]))).toEqual(r)
    }
  })

  it('in a conflicting region the newest version wins; each loser gets its whole resolution', () => {
    const list = [v('mac', 'a\nB-mac\nc\nd\nE-mac\n', 5), v('h1', 'a\nB-h1\nc\nd\ne\n', 9), v('h2', 'a\nb\nc\nd\nE-h2\n', 1)]
    const r = mergeVersions(base, list)
    expect(r.text).toBe('a\nB-h1\nc\nd\nE-mac\n')
    expect(r.conflicts).toBe(2)
    expect(r.losers.sort()).toEqual(['h2', 'mac'])
    expect(r.wins.mac).toBe('a\nB-mac\nc\nd\nE-mac\n')
    expect(r.wins.h2).toBe('a\nB-h1\nc\nd\nE-h2\n')
    expect(r.regions.map((x) => [x.baseRange, x.winner])).toEqual([[[1, 2], 'h1'], [[4, 5], 'mac']])
    expect(mergeVersions(base, [list[2], list[0], list[1]])).toEqual(r)
  })

  it('a tie in time is broken by the key, never by the order given', () => {
    const list = [v('x', 'a\nX\nc\nd\ne\n', 7), v('y', 'a\nY\nc\nd\ne\n', 7)]
    expect(mergeVersions(base, list).text).toBe('a\nY\nc\nd\ne\n')
    expect(mergeVersions(base, [list[1], list[0]]).text).toBe('a\nY\nc\nd\ne\n')
  })

  it('identical versions are one: no conflict, no loser', () => {
    const r = mergeVersions(base, [v('h1', 'a\nZ\nc\nd\ne\n', 1), v('h2', 'a\nZ\nc\nd\ne\n', 2), v('mac', base, 0)])
    expect(r).toMatchObject({ text: 'a\nZ\nc\nd\ne\n', conflicts: 0, losers: [] })
  })

  it('the id line comes from idFrom, the line endings from eolFrom', () => {
    const b = '---\r\nid: n-old\r\n---\r\none\r\ntwo\r\n'
    const mac = '---\r\nid: n-mac\r\n---\r\nONE\r\ntwo\r\n'
    const host = '---\nid: n-host\n---\none\nTWO\n'
    const r = mergeVersions(b, [v('host', host, 9), v('mac', mac, 1)], { idFrom: 'mac', eolFrom: 'mac' })
    expect(r.text).toBe('---\r\nid: n-mac\r\n---\r\nONE\r\nTWO\r\n')
    expect(mergeVersions(b, [v('mac', mac, 1), v('host', host, 9)], { idFrom: 'mac', eolFrom: 'mac' })).toEqual(r)
  })

  it('wholeNote: one region, the newest version whole, every other changed version a loser', () => {
    const list = [v('mac', 'a\nb\nc\nd\nE\n', 1), v('h1', 'A\nb\nc\nd\ne\n', 2)]
    const r = mergeVersions(base, list, { wholeNote: true })
    expect(r).toMatchObject({ text: 'A\nb\nc\nd\ne\n', conflicts: 1, overBudget: true, losers: ['mac'], wins: { mac: 'a\nb\nc\nd\nE\n' } })
    expect(r.regions).toEqual([{ baseRange: [0, 5], winner: 'h1', versions: { mac: ['a', 'b', 'c', 'd', 'E'], h1: ['A', 'b', 'c', 'd', 'e'] } }])
  })
})
