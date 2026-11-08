import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// 2026-11-12, the user after a demo where a colleague's new board showed every pin in one
// block: "All it si in Pinned, there is no focus satellight". The old rule (spec 5.10) kept
// tier names off a board until the user picked a tier once, and kept a flag for it.
const root = resolve(import.meta.dirname, '../..');
const webFiles = (readdirSync(resolve(root, 'web/src'), { recursive: true }) as string[])
  .map((f) => `web/src/${f.split(sep).join('/')}`)
  .filter((f) => /\.tsx?$/.test(f));

describe('tier headings show on every board', () => {
  it('no web file gates tier names on a "tier used" flag', () => {
    const gated = webFiles.filter((f) => /tier-used|TierUsed|headlessTiers|headless=\{/.test(readFileSync(resolve(root, f), 'utf8')));
    expect(gated).toEqual([]);
  });

  it('a tier heading in All draws for every tier the panel draws', () => {
    const panel = readFileSync(resolve(root, 'web/src/components/tasks/TodoPanel.tsx'), 'utf8');
    const group = panel.slice(panel.indexOf('function TierNavigationGroup('));
    const body = group.slice(0, group.indexOf('\n});') > 0 ? group.indexOf('\n});') : 4000);
    // The heading's only condition is the All view (a tier view is its own heading).
    expect(body).toMatch(/\{isAll && \(\s*<div ref=\{setNodeRef\} className=\{`todo-pinned-subgroup-heading/);
  });
});
