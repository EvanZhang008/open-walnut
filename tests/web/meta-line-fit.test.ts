import { describe, expect, it } from 'vitest';
import { lineOf, wrapMarks } from '../../web/src/utils/meta-line-fit';

const box = (top: number, left: number, height = 16, width = 30) => ({ top, left, height, width });

describe('lineOf: the line of words each item of a search row sits on', () => {
  it('one line, even with items of different heights', () => {
    expect(lineOf([box(100, 0, 18), box(101, 40, 16), box(100, 80)])).toEqual([0, 0, 0]);
  });
  it('counts lines in reading order (CSS order draws the project first)', () => {
    expect(lineOf([box(100, 60), box(120, 0), box(120, 40), box(100, 0)])).toEqual([0, 1, 1, 0]);
  });
  it('an item not drawn is on no line', () => {
    expect(lineOf([box(100, 0), box(0, 0, 0, 0), box(120, 0)])).toEqual([0, -1, 1]);
  });
});

describe('wrapMarks: the word that opens a wrapped line, and how far its line moves left', () => {
  it('marks the leftmost item of each wrapped line and shifts that whole line by its dot room', () => {
    const marks = wrapMarks([box(100, 0), box(100, 50), box(120, 40), box(120, 0), box(140, 0)], [0, 9, 9, 11, 8]);
    expect(marks).toEqual([
      { start: false, shift: 0 }, { start: false, shift: 0 },
      { start: false, shift: 11 }, { start: true, shift: 11 },
      { start: true, shift: 8 },
    ]);
  });
  it('a single line moves nothing', () => {
    expect(wrapMarks([box(100, 0), box(100, 40)], [0, 9])).toEqual([{ start: false, shift: 0 }, { start: false, shift: 0 }]);
  });
});

