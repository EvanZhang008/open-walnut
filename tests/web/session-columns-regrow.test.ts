/**
 * A resize never closes what the person opened (2026-11-09 review: a window made narrow, into
 * the phone layout, then wide again kept only one of three panels). The capacity trim records
 * what it closed and the regrow puts it back (regrowColumns, MainPage's trim effect).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pendingRegrow, regrowColumns, trimUnlockedToMax, type SessionSlot } from '../../web/src/pages/sessionColumns';

const slot = (id: string, locked = false): SessionSlot => ({ id, locked });
const ids = (cols: SessionSlot[]) => cols.map(c => c.id);

describe('regrowColumns', () => {
  it('a shrink to one panel and back to three brings both closed panels back, in order', () => {
    const open = [slot('ceo', true), slot('remote'), slot('local')];
    const narrow = trimUnlockedToMax(open, 1);
    expect(ids(narrow)).toEqual(['ceo']);
    const closed = open.filter(c => !narrow.includes(c));
    expect(ids(regrowColumns(narrow, closed, 3))).toEqual(['ceo', 'remote', 'local']);
  });

  it('brings back only as many as the new room holds', () => {
    const narrow = [slot('a')];
    expect(ids(regrowColumns(narrow, [slot('b'), slot('c')], 2))).toEqual(['a', 'b']);
  });

  it('a panel the person opened again meanwhile is not added twice; no room leaves the strip as is', () => {
    const now = [slot('a'), slot('b')];
    expect(ids(regrowColumns(now, [slot('b'), slot('c')], 3))).toEqual(['a', 'b', 'c']);
    expect(regrowColumns(now, [slot('c')], 2)).toBe(now);
  });

  it('placeholders do not take the room of a closed panel', () => {
    const now = [slot('a'), slot('draft:1')];
    expect(ids(regrowColumns(now, [slot('b')], 2))).toEqual(['a', 'draft:1', 'b']);
  });
});

describe('pendingRegrow: a widen never reopens a column the user closed', () => {
  const pending = [slot('remote'), slot('local')];
  it('the reported case: a shrink closed two, the user closed one of them since, a widen brings back only the other', () => {
    const left = pendingRegrow(pending, [slot('ceo')], new Set(['remote']));
    expect(ids(left)).toEqual(['local']);
    expect(ids(regrowColumns([slot('ceo')], left, 3))).toEqual(['ceo', 'local']);
  });
  it('one back on the strip by a click or a chip is the user\'s again: a later close or minimize keeps it out', () => {
    expect(ids(pendingRegrow(pending, [slot('ceo'), slot('local')], new Set()))).toEqual(['remote']);
  });
  it('nothing closed or shown keeps the same list', () => {
    expect(pendingRegrow(pending, [slot('ceo')], new Set(['other']))).toBe(pending);
  });
});

describe('MainPage capacity trim', () => {
  const page = readFileSync(new URL('../../web/src/pages/MainPage.tsx', import.meta.url), 'utf8');

  it('every capacity trim records what it closed and the regrow reads it', () => {
    // The trim effect keyed on effectiveMaxPanels is the one place a resize closes columns.
    const effect = page.slice(page.indexOf('const resizeClosedRef'), page.indexOf('}, [effectiveMaxPanels, panelModeLoaded, placeholderCount]);'));
    expect(effect).toMatch(/resizeClosedRef\.current = \[\.\.\.gone/);
    expect(effect).toMatch(/regrowColumns\(trimmed, back, max\)/);
    // No other trim on a capacity value elsewhere in the page, which would close one-way again.
    const capacityTrims = page.match(/trimUnlockedToMax\([^)]*effectiveMaxPanels/g) ?? [];
    expect(capacityTrims).toEqual([]);
  });
});

describe('guard: every close path leaves the regrow list', () => {
  const page = readFileSync(new URL('../../web/src/pages/MainPage.tsx', import.meta.url), 'utf8');

  it('the strip effect drops every id closed in a change, before the phone layout returns', () => {
    const effect = page.slice(page.indexOf('const stripBeforeRef = useRef(sessionColumns);'), page.indexOf('}, [sessionColumns, phoneLayout]);'));
    // A Minimize counts as the user's too: the column went to the chips, never back by a widen.
    const prune = effect.indexOf('resizeClosedRef.current = pendingRegrow(resizeClosedRef.current, sessionColumns, new Set([...closed, ...minimized]));');
    expect(prune).toBeGreaterThan(-1);
    expect(prune).toBeLessThan(effect.indexOf('if (before === sessionColumns || phoneLayout) return;'));
  });

  it('the regrow reads closes the strip effect has not seen yet', () => {
    expect(page).toMatch(/pendingRegrow\(resizeClosedRef\.current, sessionColumns, closedColumnIdsRef\.current\)/);
  });

  it('every close to the background goes through closedColumnIdsRef or forgets the chip\'s regrow', () => {
    // A close is a column sent to the background: it lands in closedColumnIdsRef (read by the
    // prune above), or it removes a chip from the app's taskbar (pages/sessionTaskbarStore.ts),
    // whose every removing writer tells Home, which forgets the id.
    const store = readFileSync(new URL('../../web/src/pages/sessionTaskbarStore.ts', import.meta.url), 'utf8');
    const writers = [...store.matchAll(/export function (\w+)\([^)]*\): void \{\n([\s\S]*?)\n\}/g)]
      .filter((m) => /removeChip\(/.test(m[2]));
    expect(writers.map((m) => m[1]).sort()).toEqual(['closeChip', 'closeRecent', 'takeFromTaskbar']);
    // takeFromTaskbar opens the session (it leaves the bar for a panel), which is no close.
    for (const m of writers.filter((w) => w[1] !== 'takeFromTaskbar')) expect(m[2], `${m[1]} must tell Home`).toMatch(/noteClosed\(sessionId\)/);
    const heard = [...page.matchAll(/onTaskbarClose\(/g)].map(m => m.index!);
    expect(heard.length).toBe(1);
    expect(page.slice(heard[0], heard[0] + 200)).toMatch(/pendingRegrow\(resizeClosedRef\.current, \[\], new Set\(\[sessionId\]\)\)/);
    // Every other way off the strip without a close is a chip (Minimize, an eviction), which a widen may bring back.
    const closes = [...page.matchAll(/closedColumnIdsRef\.current\.add\(/g)];
    expect(closes.length).toBeGreaterThanOrEqual(2);
  });
});
