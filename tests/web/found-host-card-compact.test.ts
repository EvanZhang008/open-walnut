/**
 * The "Your other computers" card stays small and holds only real choices (FoundHostPrompts.tsx).
 * 2026-11-11 review F8: at 1280x560 a failed and a reconnecting host took half the task list.
 * 2026-11-13, the user, of a Mac that read "Could not connect" there after every reload: "I don't
 * want it keep showing ... Just show it inside notification is fine". A connect in progress is the
 * background connect card's, and a host that cannot connect is one Notifications entry
 * (src/core/hosts/found-host-alert.ts). Source guards: the card has no DOM test harness here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const web = (rel: string) => fs.readFileSync(path.join(__dirname, '../../web/src', rel), 'utf8');

describe('the found-host card', () => {
  const card = web('components/common/FoundHostPrompts.tsx');

  it('stays a few lines tall when it holds several rows', () => {
    expect(card).toMatch(/const compact = items\.length > 1;/);
    expect(web('styles/first-use.css')).toMatch(/\.found-host-prompts ul \{[^}]*max-height: min\(180px, 28vh\)/);
  });

  it('shows no connect in progress and no failure: those live in the connect card and Notifications', () => {
    expect(card).not.toMatch(/HostConnectSteps/);
    // (Its readiness part keeps its own "Try again" for a failed Claude Code fix.)
    expect(card).not.toMatch(/Could not connect|Connecting to|\bconnectHost\b/);
    expect(card).not.toMatch(/isHostFailed|isHostConnecting|reconnectReasonOf/);
  });

  it('asks only about hosts Walnut can add, through the one rule the server reads', () => {
    expect(card).toMatch(/setFound\(foundHostsToAsk\(config\.hosts, config\.net\)\)/);
    expect(card).toMatch(/setConsented\(consentedFoundHosts\(config\.hosts, config\.net\)\)/);
    expect(web('utils/first-use.ts')).toMatch(/export \{ foundHostsToAsk, consentedFoundHosts \} from '@open-walnut\/found-host-offer'/);
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
