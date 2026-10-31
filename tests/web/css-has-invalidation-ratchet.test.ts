/**
 * No selector puts `:has()` before a last compound that names no element.
 *
 * `.a:has(> .b) > .c > :not(.d)` and `.p:has(> .q) .body > :first-child:not(.x)`:
 * a `:has()` in a compound that is not the last, followed by a last compound with
 * no tag, class, id or attribute of its own. With one of these in the app's CSS
 * (alongside the many `:has()` rules whose argument reads a state such as
 * `[data-menu-open]` or `:focus-visible`), Chrome restyled the WHOLE page for
 * every element inserted anywhere: a page of "Load earlier turns" on a long
 * session spent 1 to 4 s in one style recalc (2026-10-30, measured on the built
 * app: one inserted row cost 850 to 1130 ms with both such rules, 5 ms without
 * them, 1 ms with no `:has()` at all). Name the element in the last compound,
 * or move the `:has()` to the subject and pass the change down a custom property.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const STYLES_ROOT = path.join(__dirname, '../../web/src');

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cssFiles(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

/** Split at `sep` characters outside parentheses and brackets. */
function splitTop(text: string, isSep: (c: string) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of text) {
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (depth === 0 && isSep(c)) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** Every style rule's selector list, with its line. */
function selectorsOf(css: string): Array<{ selector: string; line: number }> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out: Array<{ selector: string; line: number }> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      const prelude = text.slice(start, i).trim();
      if (prelude && !prelude.startsWith('@') && !/^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$/.test(prelude)) {
        const line = text.slice(0, start + (text.slice(start, i).length - text.slice(start, i).trimStart().length)).split('\n').length;
        for (const sel of splitTop(prelude, (ch) => ch === ',')) out.push({ selector: sel.trim(), line });
      }
      start = i + 1;
    } else if (c === '}' || c === ';') start = i + 1;
  }
  return out;
}

/** The compounds of one complex selector (combinators dropped). */
function compounds(selector: string): string[] {
  const spaced = selector.replace(/\s*([>+~])\s*/g, ' $1 ');
  return splitTop(spaced, (c) => /\s/.test(c)).map((p) => p.trim()).filter((p) => p && !/^[>+~]$/.test(p));
}

/** Does a compound name an element: a tag, class, id or attribute outside its pseudo-classes? */
function namesElement(compound: string): boolean {
  let bare = '';
  let depth = 0;
  for (let i = 0; i < compound.length; i++) {
    const c = compound[i];
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth--; continue; }
    if (depth === 0) bare += c;
  }
  // Drop pseudo-classes and pseudo-elements (their arguments are gone already).
  bare = bare.replace(/::?[a-zA-Z-]+/g, '');
  return /[.#[]|^[a-zA-Z]/.test(bare);
}

function unnamedAfterHas(selector: string): boolean {
  const parts = compounds(selector);
  if (parts.length < 2) return false;
  const last = parts[parts.length - 1];
  return parts.slice(0, -1).some((p) => p.includes(':has(')) && !namesElement(last);
}

describe('no :has() before a last compound that names no element', () => {
  it('reads the selectors of the app CSS', () => {
    const all = cssFiles(STYLES_ROOT).flatMap((f) => selectorsOf(fs.readFileSync(f, 'utf8')));
    expect(all.length).toBeGreaterThan(1000);
    expect(all.filter((s) => s.selector.includes(':has(')).length).toBeGreaterThan(20);
  });

  it('flags the two shapes that restyled the whole page, and not their fixed forms', () => {
    expect(unnamedAfterHas('.home-navigation-scroll .todo-search-results .todo-item-content:has(> .todo-search-meta-row) > .todo-item-title-row > :not(.todo-item-title, .task-kebab-wrapper)')).toBe(true);
    expect(unnamedAfterHas('.session-panel:not(.pending-session-panel):has(> .session-error-banner, > .session-action-panel) .session-panel-body > :first-child:not(.session-history, :where(.thread-stack[data-thread-bare]))')).toBe(true);
    expect(unnamedAfterHas('.home-navigation-scroll .todo-search-results .todo-item-content[data-search-meta] > .todo-item-title-row > :not(.todo-item-title)')).toBe(false);
    expect(unnamedAfterHas('.session-panel:not(.pending-session-panel):has(> .session-error-banner)')).toBe(false);
    expect(unnamedAfterHas('.session-panel-body > :first-child:not(.session-history)')).toBe(false);
    expect(unnamedAfterHas('.a:has(.b) .c')).toBe(false);
    expect(unnamedAfterHas('.a:has(.b) > div')).toBe(false);
    expect(unnamedAfterHas('.a:has(.b) [data-x]')).toBe(false);
    expect(unnamedAfterHas('.a:has(.b) > *')).toBe(true);
    expect(unnamedAfterHas('.a:has(.b) ::selection')).toBe(true);
    // A descendant combinator written as a newline or a tab is still one.
    expect(unnamedAfterHas('.a:has(.b)\n> :not(.c)')).toBe(true);
    expect(unnamedAfterHas('.a:has(.b)\t:first-child')).toBe(true);
  });

  it('the app CSS has none', () => {
    const found: string[] = [];
    for (const file of cssFiles(STYLES_ROOT)) {
      for (const { selector, line } of selectorsOf(fs.readFileSync(file, 'utf8'))) {
        if (unnamedAfterHas(selector)) found.push(`${path.relative(STYLES_ROOT, file)}:${line}  ${selector}`);
      }
    }
    expect(found, 'name the element in the last compound, or set a custom property on the :has() subject (see this file\'s header)').toEqual([]);
  });
});
