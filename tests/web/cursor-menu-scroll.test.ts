/**
 * A menu opened at the cursor on a row closes on a scroll only once the row moved away from under
 * it (web/src/utils/cursor-menu-scroll.ts). The kebab menus closed on the first scroll anywhere on
 * the page, and the scroll that brought the row into view fires its event on the next frame, after
 * the menu opened: 2026-11-04, the Tasks page's project menu opened and closed 10 ms later whenever
 * the project sat below the fold of the rail (org-main-and-chart.spec.ts on a dense CI fixture).
 *
 * The scan finds every component under web/src that keeps a cursor anchor of its own
 * (`setCursorAnchor`) and listens to scrolls: each one must judge a scroll with scrollMovedRow.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { rowAnchorOf, scrollMovedRow } from '../../web/src/utils/cursor-menu-scroll';

const ROOT = path.resolve(import.meta.dirname, '../../web/src');

function fakeRow(rect: { top: number; left: number }) {
  return {
    isConnected: true,
    getBoundingClientRect: () => ({ top: rect.top, left: rect.left }),
  } as unknown as HTMLElement & { isConnected: boolean };
}
const pane = (holds: boolean) => ({ contains: () => holds }) as unknown as EventTarget;

describe('scrollMovedRow', () => {
  it('keeps the menu for the late event of the scroll that brought the row into view', () => {
    const rect = { top: 400, left: 64 };
    const anchor = rowAnchorOf(fakeRow(rect));
    expect(scrollMovedRow(anchor, pane(true))).toBe(false);
  });

  it('keeps the menu when the scrolled pane does not hold the row', () => {
    const rect = { top: 400, left: 64 };
    const row = fakeRow(rect);
    const anchor = rowAnchorOf(row);
    rect.top = 120;
    expect(scrollMovedRow(anchor, pane(false))).toBe(false);
  });

  it('closes once a scroll of its pane moved the row', () => {
    const rect = { top: 400, left: 64 };
    const anchor = rowAnchorOf(fakeRow(rect));
    rect.top = 380;
    expect(scrollMovedRow(anchor, pane(true))).toBe(true);
    rect.top = 400;
    rect.left = 20;
    expect(scrollMovedRow(anchor, pane(true))).toBe(true);
  });

  it('closes on any scroll with no row known, or a row that left the page', () => {
    expect(scrollMovedRow(null, pane(false))).toBe(true);
    const row = fakeRow({ top: 0, left: 0 });
    const anchor = rowAnchorOf(row);
    (row as { isConnected: boolean }).isConnected = false;
    expect(scrollMovedRow(anchor, pane(false))).toBe(true);
  });
});

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('every cursor-anchored menu judges a scroll by its row', () => {
  const menus = sources(ROOT)
    .map((file) => ({ rel: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') }))
    .filter(({ text }) => /setCursorAnchor\(\{/.test(text) && /addEventListener\('scroll'/.test(text));

  it('finds the menus', () => {
    expect(menus.map((m) => m.rel)).toEqual(expect.arrayContaining([
      'components/tasks/ProjectHeaderMenus.tsx', 'components/tasks/TaskKebabMenu.tsx', 'components/sessions/TaskQuickActions.tsx',
    ]));
  });

  it.each(menus.map((m) => [m.rel, m.text]))('%s closes on scroll only when the row moved', (_rel, text) => {
    expect(text).toMatch(/scrollMovedRow\(/);
    expect(text).toMatch(/rowAnchorOf\(/);
    expect(text).not.toMatch(/if \(cursorAnchor\) \{ close\w*\(\); return; \}/);
  });
});
