/**
 * A colour or size the CSS reads from a custom property nobody defines.
 *
 * `var(--x)` with no fallback, where no stylesheet and no inline style in the
 * app ever sets `--x`, is not an error to the browser: the declaration falls
 * back to the inherited value. So a rule meant to grey a control kept the
 * text colour instead: 2026-11-11, the mic's "starting" look read
 * `var(--text-muted)` (the app's muted grey is `--fg-muted`) and drew a black
 * ring in light mode and a white one in dark, which a reviewer caught by eye.
 *
 * Every such use is either named here with its current count (older rules,
 * counts may only go down) or fails. Use a defined variable, or give the
 * `var()` a fallback.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB_SRC = path.join(__dirname, '../../web/src');

/** Undefined variables already in the CSS, with how many bare uses each has. */
const KNOWN: Record<string, number> = {
  '--bg-primary': 5,
  '--color-bg': 4,
  '--color-border': 8,
  '--fg-primary': 49,
  '--fg-tertiary': 4,
  '--radius': 3,
  '--secondary-text': 1,
  '--text': 4,
  '--text-muted': 21,
  '--text-primary': 4,
  '--text-quaternary': 4,
  '--text-secondary': 20,
  '--text-tertiary': 1,
};

function files(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

function definedVars(): Set<string> {
  const defs = new Set<string>();
  for (const file of files(WEB_SRC, ['.css', '.ts', '.tsx'])) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) defs.add(m[1]);
    for (const m of text.matchAll(/setProperty\(\s*['"`](--[A-Za-z0-9_-]+)/g)) defs.add(m[1]);
    for (const m of text.matchAll(/['"`](--[A-Za-z0-9_-]+)['"`]\s*[:\]]/g)) defs.add(m[1]);
  }
  return defs;
}

function bareUses(): Map<string, string[]> {
  const uses = new Map<string, string[]>();
  for (const file of files(WEB_SRC, ['.css'])) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)) {
        const at = `${path.relative(WEB_SRC, file)}:${i + 1}`;
        uses.set(m[1], [...(uses.get(m[1]) ?? []), at]);
      }
    });
  }
  return uses;
}

describe('CSS reads only custom properties the app defines', () => {
  it('no new bare var() of an undefined property', () => {
    const defs = definedVars();
    const problems: string[] = [];
    for (const [name, at] of bareUses()) {
      if (defs.has(name)) continue;
      const allowed = KNOWN[name] ?? 0;
      if (at.length > allowed) {
        problems.push(`${name}: ${at.length} bare uses (allowed ${allowed}), defined nowhere. First at ${at[0]}`);
      }
    }
    expect(problems, 'use a defined variable (e.g. --fg-muted) or add a fallback').toEqual([]);
  });

  it('catches the case it was written for', () => {
    // The scanner must see a bare use of an undefined property in real CSS.
    const defs = definedVars();
    expect(defs.has('--fg-muted')).toBe(true);
    expect(defs.has('--text-muted')).toBe(false);
    expect(bareUses().get('--fg-muted')?.length ?? 0).toBeGreaterThan(0);
  });
});
