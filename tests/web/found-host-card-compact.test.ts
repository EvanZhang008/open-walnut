/**
 * The "Your other computers" card stays small and every stuck row can be put aside
 * (FoundHostPrompts.tsx; 2026-11-11 review F8: at 1280x560 a failed and a reconnecting host took
 * half the task list, and the failed row had no way out). Source guards: the card has no DOM test
 * harness here, and the browser check is done in WebKit.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const web = (rel: string) => fs.readFileSync(path.join(__dirname, '../../web/src', rel), 'utf8');

describe('the found-host card', () => {
  const card = web('components/common/FoundHostPrompts.tsx');

  it('folds the connect steps once it holds several rows, and caps its height', () => {
    expect(card).toMatch(/const compact = items\.length > 1;/);
    expect(card).toMatch(/<HostConnectSteps hostKey=\{h\.host\} label=\{h\.label\} compact=\{compact\} \/>/);
    expect(web('components/sessions/path-selector/HostConnectSteps.tsx')).toMatch(/\{!compact && <ol className="sps-host-step-list">/);
    expect(web('styles/first-use.css')).toMatch(/\.found-host-prompts ul \{[^}]*max-height: min\(180px, 28vh\)/);
  });

  it('offers Not now on a failed or failing row, the same answer a found host gets', () => {
    expect(card).toMatch(/const stuck = failed \|\| \(active && !status\?\.connected && !!reconnectReasonOf\(status\)\);/);
    expect(card).toMatch(/\{\(!active \|\| stuck\) && <button[^>]*onClick=\{\(\) => void answer\(h, 'not_now'\)\}>Not now<\/button>\}/);
  });
});

describe('section headings say how much they hold', () => {
  it('Pinned and Projects pass a count, and the heading draws it', () => {
    const panel = web('components/tasks/TodoPanel.tsx');
    for (const id of ['pinned', 'tasks']) {
      const at = panel.indexOf(`<NavigationHeading id="${id}"`);
      expect(at, id).toBeGreaterThan(0);
      expect(panel.slice(at, at + 400), id).toMatch(/\n\s+count=\{/);
    }
    expect(web('components/tasks/NavigationSections.tsx')).toMatch(/\(divider \? divider\.count : count\) !== undefined && <span className="navigation-heading-count">/);
  });

  it('guard: every NavigationHeading carries a count or a divider count', () => {
    const root = path.join(__dirname, '../../web/src');
    const missing: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith('.tsx') || e.name === 'NavigationSections.tsx') continue;
        const src = fs.readFileSync(full, 'utf8');
        let at = src.indexOf('<NavigationHeading');
        while (at >= 0) {
          const tag = src.slice(at, src.indexOf('/>', at));
          if (!/\bcount=\{|divider=\{\{ count:/.test(tag)) missing.push(`${path.relative(root, full)}: ${tag.slice(0, 80)}`);
          at = src.indexOf('<NavigationHeading', at + 1);
        }
      }
    };
    walk(root);
    expect(missing).toEqual([]);
  });
});
