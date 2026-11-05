/**
 * One focus ring per field (2026-11-04, the user's screenshot of the passage
 * Comment box: a blue border around the box AND a 3px blue glow around the field
 * inside it). The global `input:focus, textarea:focus` ring in globals.css draws
 * the glow; a box that draws its own ring with `:focus-within` must stop the
 * field inside from drawing one too. globals.css keeps the list of such boxes in
 * its "focus-ring-owners" rule. This test finds every box in the web app's CSS
 * that draws a ring (border-color, box-shadow or outline on `:focus-within`) and
 * fails when one is missing from that list, so the next composer-like box can
 * not bring the double ring back.
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

/** Boxes with a :focus-within ring that hold no text field, with why. */
const NOT_FIELD_BOXES: Record<string, string> = {
  'apps-card': 'a plugin card: buttons only, no text field inside',
};

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

/** A declaration that draws something: a border, shadow or outline that is not `none`/`0`. */
const DRAWS = /(?:^|[;\s])(border(?:-[a-z]+)*|box-shadow|outline(?:-[a-z]+)?)\s*:\s*(?!none\b|0\b|transparent\b)[^;]+/;

function ringBoxes(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of cssFiles(ROOT)) {
    const css = strip(fs.readFileSync(file, 'utf8'));
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, selectors, body] = m;
      if (!DRAWS.test(body)) continue;
      for (const sel of splitSelectors(selectors)) {
        // The box itself is styled: the LAST compound holds `:focus-within`
        // (`.box:focus-within`, `.box.compact:focus-within:not(.x)`); its first class names the box.
        const last = sel.split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
        if (!last.includes(':focus-within')) continue;
        const cls = last.match(/^\.([\w-]+)/);
        if (cls) found.set(cls[1], path.relative(ROOT, file));
      }
    }
  }
  return found;
}

function owners(): Set<string> {
  const css = fs.readFileSync(path.join(ROOT, 'styles/globals.css'), 'utf8');
  const at = css.indexOf('focus-ring-owners');
  expect(at, 'the focus-ring-owners rule is in globals.css').toBeGreaterThan(-1);
  // From the end of the comment that names it: the rule is the next one.
  const rule = strip(css.slice(css.indexOf('*/', at) + 2)).match(/:is\(([^)]*)\)\s*:is\(input, textarea, select\):focus\s*\{([^}]*)\}/);
  expect(rule, 'the rule reads `:is(.a, .b) :is(input, textarea, select):focus { box-shadow: none; }`').toBeTruthy();
  expect(rule![2]).toMatch(/box-shadow:\s*none/);
  return new Set(rule![1].split(',').map((s) => s.trim().replace(/^\./, '')));
}

describe('a box with its own focus ring owns focus', () => {
  it('finds the boxes it is meant to find (the scan still works)', () => {
    const boxes = ringBoxes();
    for (const known of ['answer-box', 'search-bar', 'chat-input-box', 'pw-search']) expect(boxes.has(known), known).toBe(true);
  });

  it('every such box is in the focus-ring-owners rule, so its field draws no second ring', () => {
    const list = owners();
    const missing = [...ringBoxes()]
      .filter(([cls]) => !list.has(cls) && !(cls in NOT_FIELD_BOXES))
      .map(([cls, file]) => `.${cls} (${file})`);
    expect(missing, 'add these to the focus-ring-owners rule in globals.css (or to NOT_FIELD_BOXES with why)').toEqual([]);
  });

  it('the list names no box that has no ring any more', () => {
    const boxes = ringBoxes();
    expect([...owners()].filter((c) => !boxes.has(c))).toEqual([]);
  });
});
