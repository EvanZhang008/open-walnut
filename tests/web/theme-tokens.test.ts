/**
 * The dark theme is written twice in globals.css: `:root[data-theme="dark"]` (the user picked
 * Dark) and `:root:not([data-theme])` inside `prefers-color-scheme: dark` (the user follows the
 * system). 2026-11-21, the UI audit: the system mirror lacked `--session-ref*` and
 * `--tier-satellite`, so session pills and the satellite tier kept their light colours in dark
 * mode for anyone on "Match system". Both blocks must set the same tokens to the same values.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const GLOBALS = path.join(__dirname, '../../web/src/styles/globals.css');

export function tokensOf(css: string, opener: string): Map<string, string> {
  const at = css.indexOf(opener);
  if (at < 0) throw new Error(`no ${opener} block`);
  const body = css.slice(at + opener.length, css.indexOf('}', at));
  const text = body.replace(/\/\*[\s\S]*?\*\//g, '');
  return new Map([...text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].replace(/\s+/g, ' ').trim()]));
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
});
