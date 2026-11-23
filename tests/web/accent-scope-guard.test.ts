/**
 * The button family's primary key has one colour across Walnut: it is filled from `--accent`, so a
 * page that redefines `--accent` for itself gives its main key a second colour. 2026-11-23: the same
 * "Add from Chrome Web Store" key was brown on the extension's connect page and blue in Settings.
 *
 * Only these places set `--accent`, each for a reason the family accepts:
 * - the theme roots (light, dark, and the system's dark) in globals.css;
 * - a session's chat colour, which the person picks per session (chat-palette.css, draft-v6.css);
 * - the browser extension's own panel, a surface of the extension and not a Walnut page
 *   (popout/ext-panel.css).
 * A new file that sets it fails here; give its keys the family's colour instead.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB_SRC = path.join(__dirname, '../../web/src');
const PLUGIN_SRC = path.join(__dirname, '../../plugin-store');

const ALLOWED: Record<string, string> = {
  'web/src/styles/globals.css': 'the theme roots',
  'web/src/styles/chat-palette.css': "a session's chat colour, picked per session",
  'web/src/styles/draft-v6.css': "a draft session's chat colour, picked per session",
  'web/src/popout/ext-panel.css': "the browser extension's own panel",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(css|ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Files that declare `--accent:` (the variable itself, not --accent-hover and the like). */
export function accentSetters(): string[] {
  const root = path.join(__dirname, '../..');
  const files = [...walk(WEB_SRC), ...(fs.existsSync(PLUGIN_SRC) ? walk(PLUGIN_SRC) : [])];
  return files
    .filter((f) => /(^|[\s;{'"`])--accent\s*:/m.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .sort();
}

describe("the primary key's one colour", () => {
  it('only the theme roots, a chat colour and the extension panel set --accent', () => {
    const extra = accentSetters().filter((f) => !ALLOWED[f]);
    expect(extra, 'a page sets its own --accent, so its primary key takes a second colour').toEqual([]);
  });
  it('every allowed place still sets it (a stale entry is removed)', () => {
    const found = new Set(accentSetters());
    expect(Object.keys(ALLOWED).filter((f) => !found.has(f))).toEqual([]);
  });
});
