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
import { readFileSync } from 'node:fs';
import { walk, scanCss } from './css-scan';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const CSS_ROOTS = ['web/src', 'examples/plugins'];
/** The one @supports condition that keeps a standard value to Firefox. Exact, so `or` / `not (not ...)` fail. */
const FIREFOX_ONLY = '@supports not selector(::-webkit-scrollbar)';

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

  // The chat's code blocks (the reported surface) are a grey panel since 2026-11-17
  // (chat-palette.css), so no light-theme block is dark today; the scan still reads them.
  it('reads the chat code blocks\' backgrounds (the reported surface), so the scan cannot silently go empty', () => {
    const chatPre = decls.filter((d) => /^background(-color)?$/.test(d.prop) && d.selectors.includes('.session-msg-assistant .markdown-body pre'));
    expect(chatPre.length).toBeGreaterThan(0);
    expect(isDarkLiteral('#16191f')).toBe(true);
    expect(isDarkLiteral('var(--chat-panel)')).toBe(false);
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
