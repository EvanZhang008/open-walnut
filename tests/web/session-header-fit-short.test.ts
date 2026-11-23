/**
 * A tool row item with a short form folds to it before anything goes into the row's "..." menu,
 * the header rule's first step (web/src/components/common/HeaderFit.tsx): a pinned Time pill reads
 * "You 0m · Agent 9h" where the row has room and keeps its icons where it does not, instead of
 * leaving the row (2026-11-23, a second column at 1280 px put the worded pill into "...").
 */
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { fitToolRow, type ToolRowItem } from '../../web/src/components/sessions/session-header-fit';

const OPTS = { chipGap: 6, windowGap: 3, groupGap: 6, moreWidth: 22 };

/** The probe's row (2026-11-23, Chromium, a 596 px column): four host chips, the pinned pill, six window keys. */
const row = (pill: Partial<ToolRowItem>): ToolRowItem[] => [
  { id: 'fork', kind: 'chip', priority: 2, width: 46 },
  { id: 'changed', kind: 'chip', priority: 3, width: 71 },
  { id: 'files', kind: 'chip', priority: 4, width: 47 },
  { id: 'terminal', kind: 'chip', priority: 6, width: 67 },
  { id: 'slot:walnut-time:session-time', kind: 'chip', priority: 6.5, width: 150, ...pill },
  { id: 'minimize', kind: 'window', priority: 8, width: 28 },
  ...['watch', 'locate', 'lock', 'expand', 'close'].map((id) => ({ id, kind: 'fixed' as const, priority: 0, width: 28 })),
];
const PILL = 'slot:walnut-time:session-time';

describe('a tool row item with a short form', () => {
  it('keeps its words where the row has room', () => {
    const fit = fitToolRow(row({ shortWidth: 70 }), 900, OPTS);
    expect(fit.short).toEqual([]);
    expect(fit.visible).toContain(PILL);
  });

  it('folds to its short form before anything goes into "..."', () => {
    const fit = fitToolRow(row({ shortWidth: 70 }), 567, OPTS);
    expect(fit.short).toEqual([PILL]);
    expect(fit.visible).toContain(PILL);
    expect(fit.inMore).toEqual([]);
  });

  it('without a short form, the same row puts the item into "..."', () => {
    const fit = fitToolRow(row({}), 567, OPTS);
    expect(fit.short).toEqual([]);
    expect(fit.inMore).toContain(PILL);
  });

  it('still leaves first, folded, where even the short form does not fit', () => {
    const fit = fitToolRow(row({ shortWidth: 70 }), 420, OPTS);
    expect(fit.inMore).toContain(PILL);
    expect(fit.short).toEqual([]);
  });

  it('answers the same for the same width', () => {
    const a = fitToolRow(row({ shortWidth: 70 }), 567, OPTS);
    for (let i = 0; i < 5; i++) expect(fitToolRow(row({ shortWidth: 70 }), 567, OPTS)).toEqual(a);
  });

  it('the hook reads the short form from [data-fit-label] and the CSS hides those words in it', () => {
    const hook = fs.readFileSync('web/src/components/sessions/useSessionHeaderFit.ts', 'utf8');
    expect(hook).toContain("querySelectorAll<HTMLElement>('[data-fit-label]')");
    expect(hook).toContain('el.dataset.headerForm');
    const css = fs.readFileSync('web/src/styles/session-header-fit.css', 'utf8');
    expect(css).toMatch(/\[data-header-form="short"\] \[data-fit-label\] \{ display: none/);
    // The Time pill's names are its fit labels.
    const pill = fs.readFileSync('examples/plugins/walnut-time/src/web/task-slots.tsx', 'utf8');
    expect(pill.match(/data-fit-label=""/g)?.length).toBe(3);
  });
});
