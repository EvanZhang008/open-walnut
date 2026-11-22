/**
 * A badge that can be cut shows an ellipsis (2026-11-21: a notification's context label was cut
 * mid-letter with no ellipsis). `.badge` is display:inline-flex (styles/badge.css), so its bare text
 * is an anonymous flex item that `text-overflow` never reaches; only `.badge > *` ellipsizes. Every
 * badge may shrink (`:where(.badge) { flex: 0 1 auto; min-width: 0 }`), so this fails on an element
 * whose className carries the badge (the word `badge` or a `badge(` call) and that has, beside its
 * elements or alone, a bare `{...}` that holds no element (text that changes, so it can be long), or
 * bare words while its own class sets a max-width. Counts (`badge-count`) are exempt. The fix: wrap
 * the text in a `<span>`.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { walk, scanCss } from './css-scan';
import { BADGE_FAMILY, WEB_SRC } from './ui-standard-scan';

/** The `>` ending the JSX opening tag that starts at `from`, skipping `{...}` and quotes; -1 when self-closing. */
function openEnd(src: string, from: number): number {
  let depth = 0;
  let quote = '';
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    // A comment between attributes or in a handler ("the pill's alone") is not a quote.
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; if (i <= 0) return -1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && c === '>') return src[i - 1] === '/' ? -1 : i;
  }
  return -1;
}

/** The source of the className attribute in one opening tag (a string or a `{...}`), or ''. */
function classAttr(tag: string): string {
  const m = /\bclassName=/.exec(tag);
  if (!m) return '';
  const i = m.index + m[0].length;
  if (tag[i] === '"' || tag[i] === "'") return tag.slice(i, tag.indexOf(tag[i], i + 1) + 1);
  let depth = 0;
  let quote = '';
  for (let j = i; j < tag.length; j++) {
    const c = tag[j];
    if (quote) { if (c === '\\') j++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return tag.slice(i, j + 1);
  }
  return '';
}

/** The index of the `</name>` that closes the element whose opening tag ends at `from` (same-name nesting counted). */
function matchClose(src: string, name: string, from: number): number {
  let depth = 1;
  const re = new RegExp(`<(/?)${name.replace('.', '\\.')}(?=[\\s>/])`, 'g');
  re.lastIndex = from + 1;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[1]) { if (--depth === 0) return m.index; continue; }
    if (openEnd(src, m.index) >= 0) depth++;
  }
  return -1;
}

/** The top-level pieces of a JSX body: bare words, `{...}` expressions and elements. */
function pieces(body: string): { words: boolean; exprs: string[] } {
  let words = false;
  const exprs: string[] = [];
  for (let i = 0; i < body.length;) {
    const c = body[i];
    if (c === '{') {
      let depth = 0;
      let j = i;
      for (; j < body.length; j++) { if (body[j] === '{') depth++; else if (body[j] === '}' && --depth === 0) break; }
      exprs.push(body.slice(i + 1, j));
      i = j + 1;
    } else if (c === '<') {
      // Skip one element with its children (same-name nesting is rare in a badge's body).
      const name = /^<([A-Za-z][\w.]*)/.exec(body.slice(i))?.[1];
      const end = openEnd(body, i);
      if (!name || end < 0) { const k = body.indexOf('>', i); i = k < 0 ? body.length : k + 1; continue; }
      const close = matchClose(body, name, end);
      i = close < 0 ? body.length : close + name.length + 3;
    } else {
      if (!/\s/.test(c)) words = true;
      i++;
    }
  }
  return { words, exprs };
}

/** Badges in one file with text no element holds: `dynamic` when a bare `{...}` holds no element. */
function bareBadges(src: string): { line: number; classes: string[]; dynamic: boolean }[] {
  const out: { line: number; classes: string[]; dynamic: boolean }[] = [];
  for (const m of src.matchAll(/<([a-z]\w*)\s/g)) {
    const end = openEnd(src, m.index!);
    if (end < 0) continue;
    const attr = classAttr(src.slice(m.index!, end + 1));
    if (!/(?<![\w-])badge(?![\w-])/.test(attr) || /badge-count|count: true/.test(attr)) continue;
    const close = matchClose(src, m[1], end);
    const body = close < 0 ? '' : src.slice(end + 1, close);
    const { words, exprs } = pieces(body);
    const dynamic = exprs.some((e) => e.trim() && !/^\s*\/\*/.test(e) && !/<[A-Za-z>]/.test(e));
    if (!words && !dynamic) continue;
    const classes = [...new Set(attr.match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/gi) ?? [])].filter((c) => !BADGE_FAMILY.has(c));
    out.push({ line: src.slice(0, m.index).split('\n').length, classes, dynamic });
  }
  return out;
}

/** Classes that some rule gives a max-width (the class sits in the selector's last compound). */
function cappedClasses(): Set<string> {
  const out = new Set<string>();
  for (const file of walk(WEB_SRC, ['.css'])) {
    for (const d of scanCss(file, fs.readFileSync(file, 'utf8'))) {
      if (d.prop !== 'max-width' || d.value === 'none') continue;
      for (const sel of d.selectors) {
        const parts = sel.replace(/::?[A-Za-z-]+(\((?:[^()]|\([^()]*\))*\))?/g, '').replace(/\[[^\]]*\]/g, '').split(/\s*[>+~]\s*|\s+/).filter(Boolean);
        for (const c of (parts[parts.length - 1] ?? '').match(/\.[\w-]+/g) ?? []) if (!BADGE_FAMILY.has(c.slice(1))) out.add(c.slice(1));
      }
    }
  }
  return out;
}

describe('a badge that can be cut shows an ellipsis', () => {
  it('the scan finds bare text in a badge and passes wrapped text', () => {
    expect(bareBadges('<span className="badge x-chip">{label}</span>')).toEqual([{ line: 1, classes: ['x-chip'], dynamic: true }]);
    expect(bareBadges('<a className={`${badge(\'accent\')} x-pill`} title={a > b ? 1 : 2}>\n  {t}\n</a>')).toHaveLength(1);
    expect(bareBadges('<span className="badge x-chip"><span>{label}</span></span>')).toEqual([]);
    expect(bareBadges('<span className="badge-count x-chip">{n}</span>')).toEqual([]);
    expect(bareBadges('<span className="badge x-chip">{a && <i />}{label}</span>')).toHaveLength(1);
    expect(bareBadges('<span className="badge x-chip">{a && <i />}<span>{label}</span></span>')).toEqual([]);
    expect(bareBadges('<span className="badge x-chip"><span><b>{a}</b></span><span>{label}</span></span>')).toEqual([]);
    expect(bareBadges("<button className=\"badge x\"\n  // the pill's own click\n  onClick={() => f(a => !a)}\n>\n  <span>Worker</span>\n</button>")).toEqual([]);
    expect(bareBadges('<span className="badge x-chip"><Icon /> Beta</span>')).toEqual([{ line: 1, classes: ['x-chip'], dynamic: false }]);
  });

  it('no badge shows changing text, or words under a max-width, outside an element', () => {
    const capped = cappedClasses();
    const offenders: string[] = [];
    for (const file of walk(WEB_SRC, ['.tsx'])) {
      const rel = path.relative(WEB_SRC, file);
      for (const hit of bareBadges(fs.readFileSync(file, 'utf8'))) {
        const why = hit.classes.filter((c) => capped.has(c));
        if (hit.dynamic) offenders.push(`web/src/${rel}:${hit.line} (a bare {...} of text): wrap it in a <span>`);
        else if (why.length) offenders.push(`web/src/${rel}:${hit.line} (${why.join(', ')} sets max-width): wrap its text in a <span>`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
