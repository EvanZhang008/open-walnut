/**
 * One focus ring per field (2026-11-04, the user's screenshot of the passage
 * Comment box: a blue border around the box AND a 3px blue glow around the field
 * inside it). The glow came from a global `input:focus, textarea:focus` rule; a
 * box that draws its own ring with `:focus-within` had to be listed in a
 * "focus-ring-owners" rule so the field inside drew none.
 *
 * Since 2026-11-21 every field is drawn as the message box (styles/input-box.css,
 * "Fields"): any focus turns its 1 px edge --input-focus-edge, and keyboard focus
 * (`:focus-visible`) draws one 2 px accent ring, on the field, or on the field box
 * or message box that holds the words, never on the words inside one (2026-11-22
 * review: the edge alone is 1.4:1, under the 3:1 a focus indicator needs, and the
 * checkboxes had no focus at all). This test holds that: no rule that names every
 * field (`input:focus`, `:where(input, textarea):focus`, with no class) draws a glow
 * (a box-shadow) anywhere in the web app's CSS, nor an outline on a plain `:focus`;
 * the field focus rule sets only the edge; and the keyboard ring exists for fields,
 * field boxes, message boxes and the engine's own controls.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../web/src');
function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...cssFiles(full));
    else if (e.name.endsWith('.css')) out.push(full);
  }
  return out;
}

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Split a selector list on its top-level commas (not those inside `:is(...)`). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  return [...out, cur].map((x) => x.trim()).filter(Boolean);
}

/** A declaration that draws a ring: a box-shadow or outline that is not `none`/`0`. */
const RING = /(?:^|[;\s])(box-shadow|outline(?:-[a-z]+)?)\s*:(?!\s*(?:none|0|transparent)\s*(?:!important\s*)?(?:;|$))\s*[^;\s][^;]*/;
const GLOW = /(?:^|[;\s])box-shadow\s*:(?!\s*(?:none|0|transparent)\s*(?:!important\s*)?(?:;|$))\s*[^;\s][^;]*/;
/** A selector that names a focused field by its element only: every field on every page. */
const BARE_FIELD_FOCUS = /^(?::(?:is|where)\()?\s*(input|textarea|select)(\s*,\s*(input|textarea|select))*\s*\)?(?::not\([^)]*\))*:focus(-visible)?$/;
/** The same, with what a `:not()` leaves out taken away first (`:where(input:not([type=x]), textarea)`). */
const bareFieldFocus = (sel: string) => BARE_FIELD_FOCUS.test(sel.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, ''));

function globalFieldRings(): string[] {
  const found: string[] = [];
  for (const file of cssFiles(ROOT)) {
    const css = strip(fs.readFileSync(file, 'utf8'));
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, selectors, body] = m;
      if (!RING.test(body)) continue;
      for (const sel of splitSelectors(selectors)) {
        if (!bareFieldFocus(sel)) continue;
        // Keyboard focus may draw its ring; nothing draws a glow, and a plain :focus draws no ring.
        if (GLOW.test(body) || !sel.endsWith(':focus-visible')) found.push(`${path.relative(ROOT, file)}: ${sel}`);
      }
    }
  }
  return found;
}

describe('a focused field draws one ring: its edge, and a keyboard ring', () => {
  it('finds a global ring when there is one (the scan still works)', () => {
    expect(bareFieldFocus('input:focus')).toBe(true);
    expect(bareFieldFocus(':is(input, textarea):focus')).toBe(true);
    expect(bareFieldFocus(":where(input:not([type='checkbox'], [type='radio']), textarea, select):focus")).toBe(true);
    expect(bareFieldFocus('.my-box input:focus')).toBe(false);
    expect(RING.test(' box-shadow: 0 0 0 3px var(--accent-subtle)')).toBe(true);
    expect(GLOW.test(' outline: 2px solid var(--accent)')).toBe(false);
    expect(RING.test(' box-shadow: none')).toBe(false);
    expect(RING.test(' outline: 0;')).toBe(false);
  });

  it('no rule draws a glow around every focused field, or a ring on every plain focus', () => {
    expect(globalFieldRings(), 'a focused field shows its edge, and a ring only for keyboard focus (styles/input-box.css, "Fields")').toEqual([]);
  });

  const css = () => strip(fs.readFileSync(path.join(ROOT, 'styles/input-box.css'), 'utf8'));
  const rulesOf = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sels: splitSelectors(m[1]), body: m[2].trim() }));

  it('the field focus rule sets only the edge', () => {
    const rule = rulesOf(css()).find((r) => r.sels.some((x) => bareFieldFocus(x) && x.endsWith(':focus')));
    expect(rule, 'input-box.css has the fields\' `:focus { border-color: ... }`').toBeTruthy();
    expect(rule!.body).toBe('border-color: var(--input-focus-edge);');
  });

  it('keyboard focus is a 2 px accent ring on fields, field boxes, message boxes and native controls', () => {
    const ring = (r: { body: string }) => /outline:\s*2px solid var\(--accent\)/.test(r.body);
    const rules = rulesOf(css()).filter(ring);
    const sels = rules.flatMap((r) => r.sels);
    expect(sels.some((x) => /^:where\(input:not\(.*\), textarea, select\):not\(\.wn-field > \*, \.wn-input \*\):focus-visible$/.test(x)), 'fields').toBe(true);
    expect(sels.some((x) => x.startsWith('.wn-field:has(') && x.includes(':focus-visible')), 'field boxes').toBe(true);
    expect(sels.some((x) => x.startsWith('.wn-input') && x.includes(':focus-visible')), 'message boxes').toBe(true);
    expect(sels.some((x) => /type='checkbox'.*type='radio'.*type='range'.*:focus-visible$/.test(x)), 'checkboxes, radios and ranges').toBe(true);
  });
});
