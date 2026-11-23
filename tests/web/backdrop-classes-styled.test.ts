/**
 * Every click-catching backdrop a component renders by class is laid out by a stylesheet: one of the
 * element's classes is fixed (or absolute over a fixed layer). 2026-11-22: the overlay family's cleanup deleted `.cal-flyout-backdrop` as a frame of
 * its own, the calendar's flyouts kept rendering it as a zero-size div, and a press outside the
 * calendar list fell through to the popover's backdrop and closed the popover too
 * (calendar-create-popover.spec "drag-select, change the calendar and add").
 * Enumerated from the TSX, so a new backdrop class is checked without a list here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { walk, scanCss } from './css-scan';

const WEB_SRC = path.resolve(__dirname, '../../web/src');

/** The class lists of every element that carries a backdrop class. */
function backdropElements(): string[][] {
  const out: string[][] = [];
  for (const file of walk(WEB_SRC, ['.tsx'])) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/className=["'`{]([^"'`}]*)/g)) {
      const classes = m[1]!.match(/[a-z][\w-]*/g) ?? [];
      if (classes.some((c) => c.endsWith('-backdrop'))) out.push(classes);
    }
  }
  return out;
}

/** Classes a stylesheet positions fixed or absolute. */
function positionedClasses(): Set<string> {
  const out = new Set<string>();
  for (const file of walk(WEB_SRC, ['.css'])) {
    for (const d of scanCss(file, fs.readFileSync(file, 'utf8'))) {
      if (d.prop !== 'position' || !/^(?:fixed|absolute)$/.test(d.value.trim())) continue;
      for (const sel of d.selectors) for (const m of sel.matchAll(/\.([a-z][\w-]*)/g)) out.add(m[1]!);
    }
  }
  return out;
}

describe('backdrops are drawn', () => {
  it('finds the backdrops it guards', () => {
    const found = new Set(backdropElements().flat());
    for (const known of ['cal-flyout-backdrop', 'cal-popover-backdrop', 'wn-context-backdrop']) expect(found, known).toContain(known);
  });

  it('every backdrop a component renders is laid out by a stylesheet', () => {
    const positioned = positionedClasses();
    const missing = backdropElements().filter((classes) => !classes.some((c) => positioned.has(c))).map((c) => c.join(' '));
    expect(missing, 'a backdrop no stylesheet positions is a zero-size div that catches no press').toEqual([]);
  });
});
