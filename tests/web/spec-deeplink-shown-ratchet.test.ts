/**
 * A browser spec that opens a deep link and reads what the user sees must first
 * wait until it is shown.
 *
 * `/sessions?id=…` and `/tasks/<id>` mount their column under Home while Home is
 * still hidden (`.main-page-wrapper-hidden`, `visibility: hidden` off its route)
 * until the route change to `/` commits, which took about 6 s on a busy CI runner
 * (2026-11-04). In that window the column's text is in the DOM, so a textContent
 * wait (`toContainText` by default) passes, while `innerText()` reads an empty
 * column. history-keeps-shown.spec.ts sampled innerText right after such a wait
 * and recorded "not-shown" for a column that was only not on screen yet: two of
 * its cases failed in CI and never locally.
 *
 * The rule, per spec file: one that navigates to a session or task deep link and
 * calls `innerText()` also waits for something shown (`toBeVisible`, a
 * `waitForSelector`/`waitFor` with its default or `visible` state, or a
 * `useInnerText: true` text wait).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SPECS = path.resolve(__dirname, '../e2e/browser');

function specFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...specFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/[^\n]*/g, '$1');

const DEEP_LINK = /goto\(\s*[`'"]\/(?:sessions\?id=|tasks\/)/;
const READS_SHOWN_TEXT = /\.innerText\(\)/;
// `waitForSelector` and `waitFor` wait for a shown element unless told another state.
const NOT_SHOWN_STATE = String.raw`[^)]*state:\s*['"](?:attached|detached|hidden)['"]`;
const WAITS_FOR_SHOWN = new RegExp([
  String.raw`toBeVisible\(`,
  String.raw`useInnerText:\s*true`,
  String.raw`waitForSelector\((?!${NOT_SHOWN_STATE})`,
  String.raw`\.waitFor\((?!${NOT_SHOWN_STATE})`,
].join('|'));

/** Why a spec breaks the rule, or null. */
function deepLinkShownViolation(source: string): string | null {
  const text = code(source);
  if (!DEEP_LINK.test(text) || !READS_SHOWN_TEXT.test(text)) return null;
  if (WAITS_FOR_SHOWN.test(text)) return null;
  return 'opens a session or task deep link and reads innerText() without waiting for anything shown';
}

describe('deep-link specs wait for what is shown before reading it', () => {
  it('the rule tells the old history-keeps-shown pattern from the fixed one', () => {
    const old = [
      "const history = page.locator('.session-history').first();",
      'const text = await history.innerText().catch(() => \'\');',
      'await page.goto(`/sessions?id=${sid}`);',
      "await expect(history).toContainText('Answer', { timeout: 30_000 });",
    ].join('\n');
    expect(deepLinkShownViolation(old)).not.toBeNull();
    expect(deepLinkShownViolation(old.replace('{ timeout', '{ useInnerText: true, timeout'))).toBeNull();
    expect(deepLinkShownViolation(`${old}\nawait expect(history).toBeVisible();`)).toBeNull();
    // A wait for the element in the DOM only is not a wait for it shown.
    expect(deepLinkShownViolation(`${old}\nawait row.waitFor({ state: 'attached' });`)).not.toBeNull();
    // No deep link: Home is on its own route from the start.
    expect(deepLinkShownViolation(old.replace('/sessions?id=${sid}', '/'))).toBeNull();
  });

  it('every browser spec keeps it', () => {
    const files = specFiles(SPECS);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .map((f) => ({ file: path.relative(SPECS, f), why: deepLinkShownViolation(fs.readFileSync(f, 'utf8')) }))
      .filter((o) => o.why !== null)
      .map((o) => `${o.file}: ${o.why}`);
    expect(offenders).toEqual([]);
  });

  it('history-keeps-shown reads only what the user sees', () => {
    const spec = code(fs.readFileSync(path.join(SPECS, 'history-keeps-shown.spec.ts'), 'utf8'));
    // Every text wait for a presence reads innerText, and the watch waits for the column to show.
    const waits = [...spec.matchAll(/(?<!not)\.toContainText\('[^']*'([^)]*)\)/g)];
    expect(waits.length).toBeGreaterThan(0);
    for (const w of waits) expect(w[1], w[0]).toMatch(/SHOWN/);
    expect(spec).toMatch(/toBeVisible\(/);
    // The column's own history, never the Ask Walnut slot's.
    expect(spec).not.toMatch(/locator\('\.session-history'\)\.first\(\)/);
  });
});
