/**
 * A Notes search for several words opens the note with the find bar on one of
 * them; the copy chosen is the one next to the others (web/src/utils/find-near-words.ts).
 */
import { describe, expect, it } from 'vitest';
import { nearestToOthers, otherWords } from '@/utils/find-near-words';

const LINE = 'A heron by the gate, a heron on the roof and a heron over the marsh at dusk.';
const hits = (text: string, w: string) => {
  const out: number[] = [];
  for (let i = text.indexOf(w); i !== -1; i = text.indexOf(w, i + w.length)) out.push(i);
  return out;
};

describe('otherWords', () => {
  it('names the typed words the bar does not search', () => {
    expect(otherWords('marsh heron', 'heron')).toEqual(['marsh']);
    expect(otherWords('Marsh  heron gate', 'Heron')).toEqual(['Marsh', 'gate']);
  });
  it('is empty when the bar searches what was typed', () => {
    expect(otherWords('heron', 'heron')).toEqual([]);
    expect(otherWords('marsh heron', 'marsh heron')).toEqual([]);
    expect(otherWords('a heron', 'heron')).toEqual([]);
  });
});

describe('nearestToOthers', () => {
  it('picks the copy next to the other word, wherever it is in the list', () => {
    const h = hits(LINE, 'heron');
    expect(nearestToOthers(LINE, h, ['marsh'], false)).toBe(2);
    const spread = `heron by the gate. ${'x'.repeat(300)} heron on the roof. ${'x'.repeat(300)} heron over the marsh.`;
    const s = hits(spread, 'heron');
    expect(nearestToOthers(spread, s, ['gate'], false)).toBe(0);
    expect(nearestToOthers(spread, s, ['roof'], false)).toBe(1);
    expect(nearestToOthers(spread, s, ['marsh'], false)).toBe(2);
  });
  it('counts more nearby words before distance', () => {
    const text = `heron marsh ${'x'.repeat(400)} heron gate roof`;
    expect(nearestToOthers(text, hits(text, 'heron'), ['marsh', 'gate', 'roof'], false)).toBe(1);
  });
  it('ignores case unless asked', () => {
    expect(nearestToOthers(LINE, hits(LINE, 'heron'), ['MARSH'], false)).toBe(2);
    expect(nearestToOthers(LINE, hits(LINE, 'heron'), ['MARSH'], true)).toBe(-1);
  });
  it('keeps the usual pick when the other words are nowhere', () => {
    expect(nearestToOthers(LINE, hits(LINE, 'heron'), ['meadow'], false)).toBe(-1);
    expect(nearestToOthers(LINE, [], ['marsh'], false)).toBe(-1);
    expect(nearestToOthers(LINE, hits(LINE, 'heron'), [], false)).toBe(-1);
  });
});
