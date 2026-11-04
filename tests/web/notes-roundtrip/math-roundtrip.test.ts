/**
 * Math stays plain markdown: a ```math fence and GitHub's $`latex`$ inline form load into
 * ordinary code nodes that the math decorations find, and save back byte for byte. This
 * pins the parse/serialize half; the plugin itself only adds decorations (no transaction of
 * its own changes the doc), and the real-UI check confirms the saved bytes with it mounted.
 */
import { describe, it, expect } from 'vitest';
import { createNotesMarkdownHarness } from './editor-harness';
import { findMath } from '@/components/notes/extensions/math-render';

const h = createNotesMarkdownHarness();

const NOTE = [
  '# Physics',
  '',
  'Energy is $`e = mc^2`$ and a ratio is $`\\frac{a}{b}`$.',
  '',
  '```math',
  '\\sum_{i=1}^n i = \\frac{n(n+1)}{2}',
  '```',
  '',
  'It costs $5 and $10, and `npm test` is plain code.',
  '',
  '- a list item with $`x^2`$',
  '',
  '> A quote: $`\\alpha + \\beta`$',
  '',
  '| a | b |',
  '| --- | --- |',
  '| $`\\pi`$ | 2 |',
  '',
  '```math',
  '\\frac{a',
  '```',
].join('\n');

describe('math markdown round-trip', () => {
  it('saves a note with block and inline math byte for byte', () => {
    expect(h.roundTrip(NOTE)).toBe(NOTE);
  });

  it('finds every formula in the loaded note and nothing in the prose', () => {
    expect(findMath(h.mdToDoc(NOTE)).map((m) => [m.display, m.latex])).toEqual([
      [false, 'e = mc^2'],
      [false, '\\frac{a}{b}'],
      [true, '\\sum_{i=1}^n i = \\frac{n(n+1)}{2}'],
      [false, 'x^2'],
      [false, '\\alpha + \\beta'],
      [false, '\\pi'],
      [true, '\\frac{a'],
    ]);
  });

  it('round-trips a multi-line math block and an empty one', () => {
    const md = ['```math', '\\begin{aligned}', 'a &= b \\\\', 'c &= d', '\\end{aligned}', '```', '', '```math', '```'].join('\n');
    expect(h.roundTrip(md)).toBe(md);
  });
});
