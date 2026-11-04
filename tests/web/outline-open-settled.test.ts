/**
 * Browser specs open the session outline only through `openOutline`
 * (tests/e2e/browser/outline-helpers.ts), which waits for the panel's slide-in to end.
 *
 * A click inside that slide is retried by Playwright with a forced centring scroll of
 * its target, and the outline is sticky inside the timeline's scroller, so the scroll
 * moves the timeline under the test before the click lands (2026-11-04: 211 px, and
 * the outline's Back then returned to the moved spot; session-outline-rewind.spec.ts,
 * every run on Linux Chromium and in CI). A spec that hovers or clicks the rail itself
 * brings that back, so this fails on any such call outside the helper, found from the
 * source: a direct `.session-toc-rail` locator, or a variable bound to one.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '../e2e/browser');
const HELPER = 'outline-helpers.ts';

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/[^\n]*/g, '$1');

/** Every `.hover(` / `.click(` aimed at the outline rail, with the line it is on. */
export function railActions(source: string): string[] {
  const text = stripComments(source);
  const hits: string[] = [];
  const lineOf = (i: number) => text.slice(text.lastIndexOf('\n', i) + 1, text.indexOf('\n', i) === -1 ? undefined : text.indexOf('\n', i)).trim();
  // A locator chain naming the rail, then (after any .first()/.nth(n)) hover or click.
  for (const m of text.matchAll(/session-toc-rail['"`]\s*\)(?:\s*\.\s*\w+\([^()]*\))*?\s*\.\s*(?:hover|click)\s*\(/g)) hits.push(lineOf(m.index!));
  // A variable bound to the rail, then hovered or clicked.
  for (const m of text.matchAll(/(?:const|let|var)\s+(\w+)\s*=[^\n;]*session-toc-rail[^\n;]*/g)) {
    const name = m[1];
    for (const use of text.matchAll(new RegExp(`\\b${name}\\s*\\.\\s*(?:hover|click)\\s*\\(`, 'g'))) hits.push(lineOf(use.index!));
  }
  return hits;
}

describe('the session outline is opened only once it has settled', () => {
  it('catches both shapes of a bare rail hover (the rule itself)', () => {
    expect(railActions(`await toc.locator('.session-toc-rail').hover()`)).toHaveLength(1);
    expect(railActions(`await panel.locator(".session-toc-rail").first().click()`)).toHaveLength(1);
    expect(railActions(`const rail = toc.locator('.session-toc-rail')\nawait rail.hover()\nawait rail.click()`)).toHaveLength(2);
    // Reading the rail is fine; so is a comment that names the old form.
    expect(railActions(`await expect(panel.locator('.session-toc-rail')).toBeVisible()`)).toHaveLength(0);
    expect(railActions(`// await toc.locator('.session-toc-rail').hover()`)).toHaveLength(0);
  });

  it('no browser spec or helper hovers or clicks the rail outside openOutline', () => {
    const offenders: string[] = [];
    for (const name of fs.readdirSync(DIR)) {
      if (!/\.ts$/.test(name) || name === HELPER) continue;
      for (const line of railActions(fs.readFileSync(path.join(DIR, name), 'utf8'))) offenders.push(`${name}: ${line}`);
    }
    expect(offenders, 'open the outline with openOutline(toc) from outline-helpers.ts').toEqual([]);
  });

  it('openOutline waits for the panel animations before it returns', () => {
    const helper = stripComments(fs.readFileSync(path.join(DIR, HELPER), 'utf8'));
    expect(helper).toMatch(/export async function openOutline/);
    expect(helper).toMatch(/getAnimations\(\)[\s\S]*\.finished/);
  });
});
