/**
 * A focused field shows only its own edge, a shade darker: no ring, no glow, no accent colour.
 *
 * 2026-11-04: the passage Comment box drew a blue border AND a 3 px blue glow (a global
 * `input:focus` glow). 2026-11-22: a 2 px accent ring was added for keyboard focus on every field.
 * 2026-11-23, the user, of that ring round the quick bar's box on open: "don't do this ... that
 * highlight after it is selected, so gross!" (skill walnut-ui-requirements, rule 19). So every rule
 * that styles a focused field (`input:focus`, `.x-search:focus-within`, `.wn-field:has(input:focus)`)
 * may only set its edge to a grey (`--input-focus-edge`, `--border-strong`): never an outline, a
 * box-shadow, or an edge in the accent or primary colour. The engine's own controls (a box to tick,
 * a slider) have no edge to darken, so their keyboard ring stays, and buttons keep theirs.
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

/** A declaration that draws a ring or glow: a box-shadow or outline that is not `none`/`0`. */
const RING = /(?:^|[;\s])(box-shadow|outline(?:-(?:width|style|color))?|outline)\s*:(?!\s*(?:none|0|transparent)\s*(?:!important\s*)?(?:;|$))\s*[^;\s][^;]*/;
/** An edge in a colour that highlights: the accent, the primary, or a raw blue. */
const LOUD_EDGE = /(?:^|[;\s])border(?:-(?:top|right|bottom|left))?(?:-color)?\s*:[^;]*(?:accent|primary|#4a7dff|#0a84ff|#007aff)/i;

/** Native controls with no edge of their own: their keyboard ring stays. */
const NATIVE_CONTROL = /\[type=['"]?(checkbox|radio|range|color|file)['"]?\]/;
/** A class that names a text field: the last word is input, field, search, textarea, box, editor... */
const FIELD_CLASS = /\.[\w-]*(?:-input|-field|-search|-textarea|-editor|-box|search-bar|^\.wn-field|^\.wn-input)(?![\w-])|^\.wn-(?:field|input)(?![\w-])/;
/** Classes that end like a field but are a button or a piece of one. */
const NOT_A_FIELD = /-(?:btn|button|key|clear|open|close|remove|cancel|icon|ic|toggle)(?![\w-])|clear-search|field-key/;

/** True when `sel` styles a focused text field (by element, by field class, or by its box holding one). */
function isFocusedField(sel: string): boolean {
  if (!/:focus(?:-visible|-within)?/.test(sel)) return false;
  if (NATIVE_CONTROL.test(sel) && !/textarea|select/.test(sel.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, ''))) return false;
  // The part that is focused (or holds the focus): the last compound before its :focus.
  const subject = sel.replace(/\s*[>+~]\s*/g, ' ').split(/\s+(?![^()]*\))/).filter(Boolean).pop() ?? '';
  if (NOT_A_FIELD.test(subject)) return false;
  if (/^(?::(?:is|where)\()?\s*(?:input|textarea|select)\b/.test(subject)) return true;
  if (/:has\([^)]*(?:input|textarea|select)[^)]*:focus/.test(subject)) return true;
  return FIELD_CLASS.test(subject.split(':')[0]) || FIELD_CLASS.test(subject);
}

function loudFocusedFields(): string[] {
  const found: string[] = [];
  for (const file of cssFiles(ROOT)) {
    const css = strip(fs.readFileSync(file, 'utf8'));
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, selectors, body] = m;
      if (!RING.test(body) && !LOUD_EDGE.test(body)) continue;
      for (const sel of splitSelectors(selectors)) {
        if (isFocusedField(sel)) found.push(`${path.relative(ROOT, file)}: ${sel} { ${body.trim().replace(/\s+/g, ' ')} }`);
      }
    }
  }
  return found;
}

describe('a focused field shows only its edge, a shade darker', () => {
  it('the scan finds what it is meant to (each shape once shipped)', () => {
    expect(isFocusedField('input:focus')).toBe(true);
    expect(isFocusedField(":where(input:not([type='checkbox'], [type='radio']), textarea, select):not(.wn-field > *, .wn-input *):focus-visible")).toBe(true);
    expect(isFocusedField('.wn-field:has(> :is(input, textarea):focus-visible)')).toBe(true);
    expect(isFocusedField('.search-bar:focus-within')).toBe(true);
    expect(isFocusedField('.pw-search:focus-within')).toBe(true);
    expect(isFocusedField('.plan-popup-input-field:focus')).toBe(true);
    expect(isFocusedField('.routine-instructions-box:focus-within')).toBe(true);
    expect(isFocusedField('.memory-edit-textarea:focus')).toBe(true);
    expect(isFocusedField('.qb-bar .qb-text:focus')).toBe(false); // the bar draws no edge at all
    // Buttons and native controls keep their keyboard ring.
    expect(isFocusedField(".settings-container .settings-nav-clear-search:focus-visible")).toBe(false);
    expect(isFocusedField('.wn-field-key:focus-visible')).toBe(false);
    expect(isFocusedField(":where(input:is([type='checkbox'], [type='radio'], [type='range'])):focus-visible")).toBe(false);
    expect(RING.test(' box-shadow: 0 0 0 3px var(--accent-subtle)')).toBe(true);
    expect(RING.test(' outline: 2px solid var(--accent)')).toBe(true);
    expect(RING.test(' outline: none')).toBe(false);
    expect(LOUD_EDGE.test(' border-color: var(--accent)')).toBe(true);
    expect(LOUD_EDGE.test(' border-color: var(--color-primary, #4a7dff)')).toBe(true);
    expect(LOUD_EDGE.test(' border-color: var(--input-focus-edge, var(--border-strong))')).toBe(false);
  });

  it('no focused field draws a ring, a glow or an accent edge anywhere in the web app', () => {
    expect(loudFocusedFields(), 'set the edge to var(--input-focus-edge) and nothing else (styles/input-box.css, "Fields")').toEqual([]);
  });

  const css = () => strip(fs.readFileSync(path.join(ROOT, 'styles/input-box.css'), 'utf8'));
  const rulesOf = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sels: splitSelectors(m[1]), body: m[2].trim() }));

  it('the field and message box focus rules set only the grey edge', () => {
    const rules = rulesOf(css());
    const field = rules.find((r) => r.sels.some((x) => /^:where\(input:not\(/.test(x) && x.endsWith(':focus')));
    expect(field?.body).toBe('border-color: var(--input-focus-edge);');
    expect(rules.find((r) => r.sels.includes('.wn-input:focus-within'))?.body).toBe('border-color: var(--input-focus-edge);');
    expect(rules.find((r) => r.sels.includes('.wn-field:focus-within'))?.body).toBe('border-color: var(--input-focus-edge);');
    expect(/--input-focus-edge:\s*var\(--border-strong\)/.test(css()), 'the edge is a grey').toBe(true);
  });

  it('the engine\'s own controls keep a keyboard ring (they have no edge to darken)', () => {
    const sels = rulesOf(css()).filter((r) => /outline:\s*2px solid var\(--accent\)/.test(r.body)).flatMap((r) => r.sels);
    expect(sels.some((x) => /type='checkbox'.*type='radio'.*type='range'.*:focus-visible$/.test(x))).toBe(true);
  });
});
