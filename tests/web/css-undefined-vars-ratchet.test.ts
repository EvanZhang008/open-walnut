/**
 * A colour or size the CSS reads from a custom property nobody defines.
 *
 * `var(--x)` with no fallback, where no stylesheet and no script ever sets `--x`, is not an error
 * to the browser: the declaration falls back to the inherited value (or the property's initial
 * value). 2026-11-11, the mic's "starting" look read `var(--text-muted)` (the app's muted grey is
 * `--fg-muted`) and drew a black ring in light mode and a white one in dark.
 *
 * A fallback does not make it right either. 2026-11-21, the UI audit: `var(--radius)` left three
 * cards square (`.notification-card`, `.setup-banner`, `.repo-card`), `var(--text, #e6e6e6)` drew
 * notes text near-white on the light theme, and `--danger` alone had nine different fallback reds.
 * This test once allowed 13 such names by count and every use that had a fallback, so 91 names
 * got in. Now every `var(--x)`, fallback or not, in every stylesheet and every inline style, must
 * name a property something defines: a stylesheet declaration (`--x: ...`), or a script that names
 * it (`'--x'` in a style object or a `setProperty`, or `` `--x-${side}` `` for a family).
 * No baseline: there are none today.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { walk } from './css-scan';

const WEB_SRC = path.join(__dirname, '../../web/src');

/**
 * Files whose CSS runs in another document, where the variables are that document's inputs.
 * board-runtime.css.ts is injected into a Board's own frame (it cannot load the app's CSS); its
 * `--wn-*` variables are the palette a Board's author sets in one `:root` rule (see its header).
 */
const OTHER_DOCUMENT = new Set(['components/board/board-runtime.css.ts']);

/** Comments out (keeping newlines), so a `var(--x)` in prose is neither a use nor a definition. */
export function stripComments(text: string, css: boolean): string {
  const blank = (c: string) => c.replace(/[^\n]/g, ' ');
  const out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  return css ? out : out.replace(/^\s*\/\/.*$/gm, blank);
}

export interface Definitions { names: Set<string>; prefixes: string[] }

export function definitionsIn(text: string, css: boolean, into: Definitions = { names: new Set(), prefixes: [] }): Definitions {
  for (const m of text.matchAll(/(?<![\w-])(--[A-Za-z0-9_-]+)\s*:/g)) into.names.add(m[1]);
  if (!css) {
    for (const m of text.matchAll(/['"`](--[A-Za-z0-9_-]+)['"`]/g)) into.names.add(m[1]);
    for (const m of text.matchAll(/`(--[A-Za-z0-9_-]+)\$\{/g)) into.prefixes.push(m[1]);
  }
  return into;
}

export function usesIn(text: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  for (const m of text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*[,)]/g)) {
    out.push({ name: m[1], line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

const isDefined = (defs: Definitions, name: string) => defs.names.has(name) || defs.prefixes.some((p) => name.startsWith(p));

function scan() {
  const defs: Definitions = { names: new Set(), prefixes: [] };
  const texts: Array<{ rel: string; text: string }> = [];
  for (const file of walk(WEB_SRC, ['.css', '.ts', '.tsx']).sort()) {
    const rel = path.relative(WEB_SRC, file);
    if (OTHER_DOCUMENT.has(rel)) continue;
    const css = file.endsWith('.css');
    const text = stripComments(fs.readFileSync(file, 'utf8'), css);
    definitionsIn(text, css, defs);
    texts.push({ rel, text });
  }
  return { defs, texts };
}

describe('CSS reads only custom properties the app defines', () => {
  it('every var(--x), with a fallback or without, names a defined property', () => {
    const { defs, texts } = scan();
    const problems: string[] = [];
    for (const { rel, text } of texts) {
      for (const use of usesIn(text)) {
        if (!isDefined(defs, use.name)) problems.push(`web/src/${rel}:${use.line} reads ${use.name}, which nothing defines`);
      }
    }
    expect(problems, 'Use the token in globals.css :root (--fg, --fg-muted, --error, --radius-md ...), or define the new one there once').toEqual([]);
  });

  it('catches each shape it was written for', () => {
    const css = stripComments('.a { border-radius: var(--radius); color: var(--text, #e6e6e6); }\n/* var(--in-a-comment) */', true);
    expect(usesIn(css).map((u) => u.name)).toEqual(['--radius', '--text']);
    const defs = definitionsIn(stripComments(":root { --fg: #000; }", true), true);
    definitionsIn("el.style.setProperty(`--plugin-box-${side}`, v); const s = { ['--menu-max-height' as string]: h };", false, defs);
    expect(isDefined(defs, '--fg')).toBe(true);
    expect(isDefined(defs, '--plugin-box-top')).toBe(true);
    expect(isDefined(defs, '--menu-max-height')).toBe(true);
    expect(isDefined(defs, '--radius')).toBe(false);
    expect(isDefined(defs, '--text')).toBe(false);
    // The real tree: the app's muted grey is defined, the old wrong name is not.
    const real = scan().defs;
    expect(isDefined(real, '--fg-muted')).toBe(true);
    expect(isDefined(real, '--text-muted')).toBe(false);
  });
});
