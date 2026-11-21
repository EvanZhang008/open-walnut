/**
 * The dark theme is written twice in globals.css: `:root[data-theme="dark"]` (the user picked
 * Dark) and `:root:not([data-theme])` inside `prefers-color-scheme: dark` (the user follows the
 * system). 2026-11-21, the UI audit: the system mirror lacked `--session-ref*` and
 * `--tier-satellite`, so session pills and the satellite tier kept their light colours in dark
 * mode for anyone on "Match system". Both blocks must set the same tokens to the same values.
 *
 * The same holds for every component rule: useTheme removes `data-theme` for "Match system", so a
 * `[data-theme="dark"] .x` rule never applies there unless its twin
 * `:root:not([data-theme]) .x` sits in a `prefers-color-scheme: dark` block. On 2026-11-21, 59
 * such rules had none (the STT menus, tag chips, code tokens, find highlights, ...).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { walk } from './css-scan';

const GLOBALS = path.join(__dirname, '../../web/src/styles/globals.css');

export function tokensOf(css: string, opener: string): Map<string, string> {
  const at = css.indexOf(opener);
  if (at < 0) throw new Error(`no ${opener} block`);
  const body = css.slice(at + opener.length, css.indexOf('}', at));
  const text = body.replace(/\/\*[\s\S]*?\*\//g, '');
  return new Map([...text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].replace(/\s+/g, ' ').trim()]));
}

const DARK = /(:root|html)?\[data-theme=["']?dark["']?\]/;
const SYSTEM = /(:root|html)?:not\(\[data-theme(=["']?light["']?)?\]\)/;
const squash = (x: string) => x.replace(/\s+/g, ' ').trim();

/** `[data-theme="dark"] X` selectors of a stylesheet that have no `:root:not([data-theme]) X` twin. */
export function unmirroredDark(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...text.matchAll(/([^{};]+)\{/g)].flatMap((m) => m[1].split(',').map(squash));
  const mirrored = new Set(selectors.filter((s) => SYSTEM.test(s)).map((s) => squash(s.replace(SYSTEM, ''))));
  return selectors.filter((s) => {
    const m = DARK.exec(s);
    if (!m) return false;
    const before = s.slice(0, m.index);
    if (before.split('(').length !== before.split(')').length) return false; // inside :not(...)
    const rest = squash(s.replace(DARK, ''));
    return rest !== '' && !mirrored.has(rest);
  });
}

describe('theme tokens', () => {
  const css = fs.readFileSync(GLOBALS, 'utf8');

  it('the system dark mirror sets every dark token, to the same value', () => {
    const picked = tokensOf(css, ':root[data-theme="dark"] {\n');
    const system = tokensOf(css, ':root:not([data-theme]) {');
    const diff: string[] = [];
    for (const [name, value] of picked) {
      if (!system.has(name)) diff.push(`${name}: missing in the prefers-color-scheme mirror`);
      else if (system.get(name) !== value) diff.push(`${name}: ${value} vs ${system.get(name)}`);
    }
    for (const name of system.keys()) if (!picked.has(name)) diff.push(`${name}: only in the prefers-color-scheme mirror`);
    expect(diff).toEqual([]);
  });

  it('every dark rule has its "Match system" twin', () => {
    const missing: string[] = [];
    const src = path.join(__dirname, '../../web/src');
    for (const file of walk(src, ['.css'])) {
      for (const sel of unmirroredDark(fs.readFileSync(file, 'utf8'))) missing.push(`web/src/${path.relative(src, file)}: ${sel}`);
    }
    expect(missing, 'Add @media (prefers-color-scheme: dark) { :root:not([data-theme]) X { ... } } beside each').toEqual([]);
  });

  it('finds a dark rule with no twin', () => {
    expect(unmirroredDark('[data-theme="dark"] .a { color: red; }')).toEqual(['[data-theme="dark"] .a']);
    expect(unmirroredDark('[data-theme="dark"] .a { color: red; } @media (prefers-color-scheme: dark) { :root:not([data-theme]) .a { color: red; } }')).toEqual([]);
    expect(unmirroredDark(":root:not([data-theme='dark']) .a { color: red; }")).toEqual([]);
  });
});
