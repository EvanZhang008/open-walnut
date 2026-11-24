/**
 * Where a session history's content starts is said once, by the scroller: its scroll-padding-top
 * (chat-reading.css, "Nothing lands under a header"). An element inside it that also set a
 * scroll-margin-top of the header's height counted the header twice when scrolled into view: a grown
 * question card (thread-card.css) got 97 px less room than its height, and its foot sat on the
 * jump-to-bottom key (2026-11-24, session-thread-card-choices.spec.ts). This fails when any rule sets
 * a scroll-margin to the header's height again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const STYLES = path.resolve(__dirname, '../../web/src');

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : cssFiles(p);
    return e.name.endsWith('.css') ? [p] : [];
  });
}

describe('session history scroll inset', () => {
  it('no rule gives an element a scroll-margin of the panel header height', () => {
    const hits: string[] = [];
    for (const file of cssFiles(STYLES)) {
      const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of text.matchAll(/scroll-margin(?:-top|-block(?:-start)?)?\s*:[^;}]*var\(--sp-(?:header-h|cover)\b[^;}]*/g)) {
        hits.push(`${path.relative(STYLES, file)}: ${m[0].trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the history itself still says where its content starts', () => {
    const css = fs.readFileSync(path.join(STYLES, 'styles/chat-reading.css'), 'utf8');
    expect(css).toMatch(/\.session-panel-body \.session-history \{\s*scroll-padding-top: calc\(var\(--sp-cover, var\(--sp-header-h/);
  });
});
