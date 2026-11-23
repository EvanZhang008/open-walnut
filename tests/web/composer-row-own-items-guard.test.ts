/**
 * The composer's controls row measures only its OWN items. 2026-11-18: the side-thread
 * drawer opens inside the controls bar with a composer of its own, and the bar's
 * `parentElement.querySelector('.chat-input-controls-spacer')` found THAT composer's
 * spacer first; the row's room then followed its own fold and condense, it flipped on
 * every render, and React stopped it with "Maximum update depth exceeded", taking the
 * whole session panel down (tests/e2e/browser/btw-open-thread-row.spec.ts).
 *
 * The members are found, not listed: every query in web/src for one of the row's item
 * selectors. Each must be scoped to direct children (`:scope >`, or ComposerControlsBar's
 * rowItems), so a nested composer can never be measured as this row.
 *
 * And a session window's crash stays in its part: components under sessions/ and chat/
 * use RegionErrorBoundary (with Retry), never a boundary of their own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const WEB = path.join(ROOT, 'web/src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const ROW_ITEMS = ['.chat-input-controls-spacer', '.chat-recall-hint', '.composer-direct-control', '[data-control-id', 'DIRECT_BUTTON', 'OWN_CONTROL', 'ownControl('];
const QUERY = /\.(querySelector|querySelectorAll|closest)\s*(?:<[^>]*>)?\(\s*([^)]*)\)/g;

describe('the composer row measures only its own items', () => {
  it('every query for a row item is scoped to direct children', () => {
    const offenders: string[] = [];
    let members = 0;
    for (const file of sources(WEB)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(QUERY)) {
        const [, method, arg] = m;
        if (method === 'closest') continue; // walks up, never into a nested composer
        if (!ROW_ITEMS.some((item) => arg.includes(item))) continue;
        members += 1;
        if (/:scope\s*>/.test(arg) || /\bOWN_CONTROL\b|\bownControl\(/.test(arg)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        offenders.push(`${path.relative(ROOT, file)}:${line} ${m[0]}`);
      }
    }
    expect(members, 'found no row queries: the scan is broken').toBeGreaterThan(0);
    expect(offenders, 'use rowItems(row, selector) or a `:scope >` selector').toEqual([]);
  });

  it('ComposerControlsBar finds the spacer, recall line and direct buttons among the row\'s children', () => {
    const bar = fs.readFileSync(path.join(WEB, 'components/chat/ComposerControlsBar.tsx'), 'utf8');
    // No descendant query from the row (bar.parentElement / controlsRow) at all.
    expect(bar).not.toMatch(/(parentElement|controlsRow)\??\.querySelector/);
    expect(bar).toMatch(/function rowItems\(/);
  });
});

describe('a session window keeps a crash in its part', () => {
  it('components under sessions/ and chat/ use RegionErrorBoundary, not a boundary of their own', () => {
    const own = [...sources(path.join(WEB, 'components/sessions')), ...sources(path.join(WEB, 'components/chat'))]
      .filter((file) => /getDerivedStateFromError|componentDidCatch/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));
    expect(own).toEqual([]);
  });

  it('the panel, the composer, its controls row and the side-thread drawer each sit in their region', () => {
    const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8');
    expect(read('components/sessions/SessionPanel.tsx')).toMatch(/<RegionErrorBoundary\s+region="session-panel"/);
    expect(read('components/chat/ChatInput.tsx')).toMatch(/<RegionErrorBoundary region="composer"/);
    expect(read('components/sessions/SideQuestionDrawer.tsx')).toMatch(/<RegionErrorBoundary region="side-threads"/);
    expect(read('components/chat/ComposerControlsBar.tsx')).toMatch(/<RegionErrorBoundary region="composer-controls"/);
  });
});
