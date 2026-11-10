/**
 * A full-screen sheet moves its left edge past the notice corner while the corner holds a notice
 * (`--corner-sheet-inset`, web/src/components/common/corner-stack.tsx). A layout MODE picked from a
 * pane's width must not follow that inset: 2026-11-07, main CI (board-kanban-round3 N1), a card
 * dropped on the wide board's Resolved rail showed its own "The task is still open" toast, the toast
 * moved the 1280px sheet 126px, the board pane fell under 600px and the kanban switched to its
 * narrow sections, so the rail the user had just dropped on was gone.
 *
 * The rule (modeBesideCorner): while an inset is held the mode stays as it was; with none yet it is
 * picked for the width without the inset. The guard reads web/src and fails on a new file that picks
 * a wide/narrow layout from a ResizeObserver without going through it.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CORNER_SHEET_INSET_VAR, cornerSheetInsetOf, modeBesideCorner, movedSheet, type SheetSeen } from '../../web/src/components/common/corner-sheet-inset';
import { modeFor } from '../../web/src/components/board/kanban/useKanbanLayout';

/** An element inside a sheet whose inline style holds `inset` (or no sheet at all). */
function inSheet(inset: number | null): Element {
  const sheet = inset === null ? null : {
    style: { getPropertyValue: (name: string) => (name === CORNER_SHEET_INSET_VAR && inset ? `${inset}px` : '') },
  };
  return { closest: (sel: string) => (sel === '.open-walnut-fullscreen' ? sheet : null) } as unknown as Element;
}

describe('modeBesideCorner', () => {
  it('reads the inset of the sheet holding the element, 0 outside a sheet or with none', () => {
    expect(cornerSheetInsetOf(inSheet(126))).toBe(126);
    expect(cornerSheetInsetOf(inSheet(0))).toBe(0);
    expect(cornerSheetInsetOf(inSheet(null))).toBe(0);
    expect(cornerSheetInsetOf(null)).toBe(0);
  });

  it('the N1 case: a wide board narrowed to 573px by a toast stays wide', () => {
    expect(modeFor(573, 'wide')).toBe('narrow');
    expect(modeBesideCorner(inSheet(126), 573, 'wide', modeFor)).toBe('wide');
  });

  it('a narrow board stays narrow while a notice shows, however the width moves', () => {
    expect(modeBesideCorner(inSheet(126), 700, 'narrow', modeFor)).toBe('narrow');
  });

  it('with no inset the width alone decides, the hysteresis included', () => {
    expect(modeBesideCorner(inSheet(0), 573, 'wide', modeFor)).toBe('narrow');
    expect(modeBesideCorner(inSheet(null), 610, 'narrow', modeFor)).toBe('narrow');
    expect(modeBesideCorner(inSheet(null), 624, 'narrow', modeFor)).toBe('wide');
  });

  it('a first measure under an inset is made for the width without it', () => {
    expect(modeBesideCorner(inSheet(126), 573, null, modeFor)).toBe('wide');
    expect(modeBesideCorner(inSheet(126), 400, null, modeFor)).toBe('narrow');
  });

  /** A pane that goes full screen when the test says so, in a sheet whose inset is 126px. */
  function movingPane() {
    const sheet = { style: { getPropertyValue: (name: string) => (name === CORNER_SHEET_INSET_VAR ? '126px' : '') } };
    const state = { inFullscreen: false };
    const pane = { closest: (sel: string) => (sel === '.open-walnut-fullscreen' && state.inFullscreen ? sheet : null) } as unknown as Element;
    return { pane, state };
  }

  it('a pane that just went into the sheet under an inset keeps nothing of where it was', () => {
    // 2026-11-09: a narrow column went full screen while a notice held the corner, and kept its mode.
    const { pane, state } = movingPane();
    const seen: SheetSeen = { current: undefined };
    expect(movedSheet(seen, pane)).toBe(false);
    expect(modeBesideCorner(pane, 560, null, modeFor)).toBe('narrow');
    state.inFullscreen = true;
    expect(movedSheet(seen, pane)).toBe(true);
    expect(modeBesideCorner(pane, 573, null, modeFor)).toBe('wide');
    // Inside the sheet the hold is back: a width the inset moved keeps the mode it has.
    expect(movedSheet(seen, pane)).toBe(false);
    expect(modeBesideCorner(pane, 520, 'wide', modeFor)).toBe('wide');
  });

  it('is pure: a state updater React runs twice (StrictMode, a replayed render) gets the same mode', () => {
    // The pick runs inside setState updaters (useTreeSplit, useThreadStack, ThreadTreeDrawer).
    const { pane, state } = movingPane();
    modeBesideCorner(pane, 560, null, modeFor);
    state.inFullscreen = true;
    const first = modeBesideCorner(pane, 573, 'narrow', modeFor);
    expect(modeBesideCorner(pane, 573, 'narrow', modeFor)).toBe(first);
  });
});

const ROOT = path.resolve(__dirname, '../../web/src');
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(d.name) ? [p] : [];
  });
}
const files = walk(ROOT).map((p) => ({ rel: path.relative(ROOT, p), code: fs.readFileSync(p, 'utf8') }));

describe('every width-picked layout mode leaves the corner inset out', () => {
  // A file that watches a size and switches between named wide/narrow layouts, or picks a
  // width tier (widthTier): 2026-11-09, main CI, Tree Mode in the 1440px sheet fell from three
  // pages to two while another spec's notice held the corner, which narrowed the chat under
  // its 1040px tier.
  const pickers = files.filter((f) => /new ResizeObserver\b/.test(f.code)
    && (/['"](wide|narrow)['"]/.test(f.code) || /\bwidthTier\(/.test(f.code)));

  it('finds the ones it knows of (the matcher still matches)', () => {
    const found = pickers.map((f) => f.rel);
    for (const known of ['components/board/kanban/useKanbanLayout.ts', 'hooks/useTreeSplit.ts', 'hooks/useThreadStack.ts', 'components/sessions/ThreadTreeDrawer.tsx']) {
      expect(found).toContain(known);
    }
  });

  it('each one picks through modeBesideCorner', () => {
    const missing = pickers.filter((f) => !/\bmodeBesideCorner\(/.test(f.code)).map((f) => f.rel);
    expect(missing, 'pick the mode with modeBesideCorner(el, width, prev, pick) from components/common/corner-sheet-inset').toEqual([]);
  });

  it('each one tells a move into or out of a sheet with movedSheet, outside its state updater', () => {
    // A record kept inside the pick (or the updater) is spent by React's second run of it.
    const missing = pickers.filter((f) => !/\bmovedSheet\(/.test(f.code)).map((f) => f.rel);
    expect(missing, 'read movedSheet(seenRef.current, el) in the measure, then pass prev null when it says moved').toEqual([]);
    const inUpdater = pickers.filter((f) => /set\w+\(\(\w*\)\s*=>[^;]*\bmovedSheet\(/.test(f.code)).map((f) => f.rel);
    expect(inUpdater).toEqual([]);
  });

  it('the inset is named in one place', () => {
    const literal = files.filter((f) => f.rel !== 'components/common/corner-sheet-inset.ts' && /['"]--corner-sheet-inset['"]/.test(f.code)).map((f) => f.rel);
    expect(literal, 'use CORNER_SHEET_INSET_VAR').toEqual([]);
  });
});
