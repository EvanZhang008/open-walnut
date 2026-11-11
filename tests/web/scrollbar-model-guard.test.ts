/**
 * One scrollbar model per engine, so no code block grows a white bar.
 *
 * The bug (2026-11-03, Mac app): every code block in the chat had a white strip
 * along its bottom edge. WebKit (macOS 26 WKWebView) learned the standard
 * `scrollbar-color`, and an element with a non-auto `scrollbar-color` or
 * `scrollbar-width` ignores every `::-webkit-scrollbar` rule. `<html>` set
 * `scrollbar-color` (it inherits), so every `<pre>` lost Walnut's 6px transparent
 * track and got the native macOS one, which ignores the colours: 17px of white,
 * drawn even on a block that fits because `overflow-x: scroll` reserves the track.
 *
 * The class: ANY non-`none` standard scrollbar property that reaches a box in an
 * engine that also has `::-webkit-scrollbar` (a sidebar's `scrollbar-width: thin`
 * drew a 13px native track the same way). The rule pinned here: those properties
 * live only inside `@supports not selector(::-webkit-scrollbar)` (Firefox), in
 * every stylesheet and every inline style. And every code block that is dark in
 * both themes gives its own scrollbar a light thumb, or the page's dark thumb
 * vanishes on it. Both lists are read from the source, so a new stylesheet, a new
 * code-block rule or a new component that renders code blocks is checked too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const CSS_ROOTS = ['web/src', 'examples/plugins'];
/** The one @supports condition that keeps a standard value to Firefox. Exact, so `or` / `not (not ...)` fail. */
const FIREFOX_ONLY = '@supports not selector(::-webkit-scrollbar)';

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

interface Decl {
  file: string;
  line: number;
  prop: string;
  value: string;
  /** Selector list of the innermost style rule holding the declaration. */
  selectors: string[];
  /** Preludes of every enclosing at-rule, outermost first, whitespace-normalised. */
  atRules: string[];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Split on top-level commas (not the ones inside `:is(a, b)`). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) { out.push(norm(s.slice(from, i))); from = i + 1; }
  }
  out.push(norm(s.slice(from)));
  return out.filter(Boolean);
}

/**
 * A small CSS scanner, enough for these checks (no parser dependency): every
 * declaration with its enclosing style rule and at-rules. Comments are blanked
 * keeping their newlines; quotes and parentheses are respected, so a `;` inside
 * `url("data:...;...")` does not end a declaration.
 */
function scanCss(file: string, raw: string): Decl[] {
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const decls: Decl[] = [];
  const frames: string[] = [];
  let from = 0;
  let paren = 0;
  let quote = '';
  const lineAt = (i: number) => text.slice(0, i).split('\n').length;
  const flush = (to: number) => {
    const chunk = text.slice(from, to);
    const colon = chunk.indexOf(':');
    const rule = [...frames].reverse().find((f) => !f.startsWith('@'));
    if (rule !== undefined && colon > 0 && chunk.trim()) {
      const lead = chunk.length - chunk.trimStart().length;
      decls.push({
        file,
        line: lineAt(from + lead),
        prop: chunk.slice(0, colon).trim().toLowerCase(),
        value: norm(chunk.slice(colon + 1)),
        selectors: splitTopLevel(rule),
        atRules: frames.filter((f) => f.startsWith('@')),
      });
    }
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') { paren++; continue; }
    if (c === ')') { paren--; continue; }
    if (paren > 0) continue;
    if (c === '{') { frames.push(norm(text.slice(from, i))); from = i + 1; }
    else if (c === ';') { flush(i); from = i + 1; }
    else if (c === '}') { flush(i); frames.pop(); from = i + 1; }
  }
  return decls;
}

const cssFiles = CSS_ROOTS.flatMap((r) => walk(join(ROOT, r), ['.css']));
const decls = cssFiles.flatMap((f) => scanCss(relative(ROOT, f), readFileSync(f, 'utf8')));

describe('the CSS scanner', () => {
  it('reads selectors, at-rules and lines', () => {
    const d = scanCss('x.css', '/* a; b { */\n@media (x) {\n  .a pre, :is(.b, .c) pre { background: url("d:;"); color: red }\n}\n');
    expect(d.map((x) => [x.prop, x.value, x.line, x.selectors, x.atRules])).toEqual([
      ['background', 'url("d:;")', 3, ['.a pre', ':is(.b, .c) pre'], ['@media (x)']],
      ['color', 'red', 3, ['.a pre', ':is(.b, .c) pre'], ['@media (x)']],
    ]);
  });
});

describe('standard scrollbar properties stay Firefox-only', () => {
  it('found the stylesheets', () => {
    expect(cssFiles.length).toBeGreaterThan(50);
    expect(decls.length).toBeGreaterThan(10_000);
  });

  it('no stylesheet sets scrollbar-width or scrollbar-color outside @supports not selector(::-webkit-scrollbar)', () => {
    const offenders = decls
      .filter((d) => /^scrollbar-(width|color)$/.test(d.prop))
      .filter((d) => !/^(none|auto)$/.test(d.value)) // hiding is fine in every engine
      .filter((d) => !d.atRules.includes(FIREFOX_ONLY))
      .map((d) => `${d.file}:${d.line} ${d.prop}: ${d.value}`);
    expect(offenders, 'In WebKit and Chromium a standard scrollbar value switches off ::-webkit-scrollbar and '
      + 'draws the native track (white in the Mac app). Wrap it in @supports not selector(::-webkit-scrollbar).')
      .toEqual([]);
  });

  it('no inline style or CSS-in-TS sets them either', () => {
    const literalNoneOrAuto = String.raw`['"\x60](?:none|auto)['"\x60]`;
    const patterns = [
      // style={{ scrollbarWidth: ... }}, el.style.scrollbarColor = ...: anything but a literal 'none' / 'auto'
      new RegExp(String.raw`scrollbar(?:Width|Color)\s*[:=]\s*(?!${literalNoneOrAuto})`),
      // style.setProperty('scrollbar-width', ...)
      new RegExp(String.raw`['"\x60]scrollbar-(?:width|color)['"\x60]\s*,\s*(?!${literalNoneOrAuto})`),
      // CSS text inside a string or template
      /scrollbar-(?:width|color)\s*:\s*(?!(?:none|auto)\b)/,
    ];
    const offenders: string[] = [];
    for (const f of walk(join(ROOT, 'web/src'), ['.ts', '.tsx'])) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (patterns.some((p) => p.test(line))) offenders.push(`${relative(ROOT, f)}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

/** A literal colour dark enough that the page's light-theme thumb (15% black) vanishes on it. */
function isDarkLiteral(value: string): boolean {
  const hex = value.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
  let rgb: number[] | null = null;
  let alpha = 1;
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    const m = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i);
    if (m) { rgb = [m[1], m[2], m[3]].map(Number); alpha = m[4] === undefined ? 1 : Number(m[4]); }
  }
  if (!rgb) return false;
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return lum < 0.35 && alpha >= 0.2;
}

/** A rule that styles a code block: a `pre` element, or a class named `*-pre`. */
const isCodeBlockSelector = (sel: string) => /(^|[\s>+~])pre(?![\w-])/.test(sel) || /\.[\w-]+-pre(?![\w-])/.test(sel);

describe('dark code blocks get a light scrollbar thumb', () => {
  const thumbSelectors = new Set(decls.filter((d) => d.prop === '--wn-scrollbar-thumb').flatMap((d) => d.selectors));
  const darkBlocks = decls
    .filter((d) => /^background(-color)?$/.test(d.prop) && isDarkLiteral(d.value))
    // A dark-theme rule is already covered by the dark theme's light thumb.
    .filter((d) => !d.atRules.some((a) => /prefers-color-scheme:\s*dark/.test(a)))
    .flatMap((d) => d.selectors
      .filter((sel) => isCodeBlockSelector(sel) && !/data-theme=["']dark["']/.test(sel))
      .map((sel) => `${d.file}|${sel}`));

  it('found the chat code blocks (the reported surface)', () => {
    expect(darkBlocks.map((b) => b.split('|')[1])).toContain('.session-msg-assistant .markdown-body pre');
  });

  it('every code block dark in the light theme sets --wn-scrollbar-thumb', () => {
    const missing = darkBlocks.filter((b) => !thumbSelectors.has(b.split('|')[1]));
    expect(missing, 'Add the selector to the --wn-scrollbar-thumb rule beside .session-msg-assistant .markdown-body pre').toEqual([]);
  });
});

describe('every component that renders code blocks gets the base code-block rule', () => {
  // A component renders code blocks when it renders markdown (`markdown-body`) or a `<pre>`.
  const hosts = walk(join(ROOT, 'web/src'), ['.tsx'])
    .filter((f) => /markdown-body|<pre[\s>]/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f));

  it('finds the known hosts, so the scan cannot silently go empty', () => {
    for (const known of ['web/src/components/sessions/SessionMessage.tsx', 'web/src/components/inbox/LetterBody.tsx', 'web/src/components/common/AgentText.tsx', 'web/src/components/common/FileContentView.tsx']) {
      expect(hosts).toContain(known);
    }
    expect(hosts.length).toBeGreaterThan(15);
  });

  it('every class a component puts on a <pre> is styled in a scanned stylesheet, so the checks above cover it', () => {
    const selectorText = decls.map((d) => d.selectors.join(' ')).join(' ');
    const unstyled: string[] = [];
    for (const f of hosts) {
      for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/<pre\b[^>]*?className=["'`{]+([\w\s-]+)/g)) {
        for (const cls of m[1].split(/\s+/).filter(Boolean)) {
          if (!new RegExp(String.raw`\.${cls}(?![\w-])`).test(selectorText)) unstyled.push(`${f} <pre class="${cls}">`);
        }
      }
    }
    expect(unstyled).toEqual([]);
  });

  it('the base code-block rule reserves a track that the global ::-webkit-scrollbar draws transparent', () => {
    const g = decls.filter((d) => d.file === 'web/src/styles/globals.css' && d.atRules.length === 0);
    const overflowX = g.find((d) => d.selectors.includes('.markdown-body pre') && d.prop === 'overflow-x')?.value;
    const track = g.find((d) => d.selectors.includes('::-webkit-scrollbar-track') && d.prop === 'background')?.value;
    expect(overflowX).toBe('scroll');
    expect(track).toBe('transparent');
  });
});
