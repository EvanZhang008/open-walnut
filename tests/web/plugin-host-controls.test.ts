/**
 * A plugin draws its tabs, pick-ones, checkboxes, radios, switches and chips with Walnut's own
 * choice controls, handed to it through `walnut.ui.views` (standard.md, "Choice controls"). Each
 * plugin that does keeps the same small adapter, `src/web/host-controls.tsx`: it feature-detects
 * the views and falls back to the family's keys or native inputs on an older host.
 *
 * 2026-11-27 UI audit: the Time, Rhythm, notes import and demo pages each had a tab bar, a
 * segmented control or a checkbox of their own. Plugins build alone (no shared package among
 * them), so the adapter is copied; this test keeps every copy the same as the Time plugin's, and
 * checks that each plugin that imports it also hands it the host's views in `activate`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '../..');
const CANONICAL = 'examples/plugins/walnut-time/src/web/host-controls.tsx';
const PLUGIN_DIRS = ['examples/plugins', 'plugin-store'];

const plugins = (): string[] =>
  PLUGIN_DIRS.flatMap((dir) =>
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, dir, e.name, 'src')))
      .map((e) => `${dir}/${e.name}`));

const filesOf = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesOf(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });

describe('plugin host controls adapter', () => {
  const canonical = fs.readFileSync(path.join(ROOT, CANONICAL), 'utf8');

  it('every copy is the same as the Time plugin\'s', () => {
    const differ = plugins()
      .map((p) => `${p}/src/web/host-controls.tsx`)
      .filter((f) => f !== CANONICAL && fs.existsSync(path.join(ROOT, f)))
      .filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8') !== canonical);
    expect(differ, `Copy ${CANONICAL} over these (change the adapter there, then copy it):`).toEqual([]);
  });

  it('a plugin that imports it hands it the host views in activate', () => {
    const missing: string[] = [];
    for (const p of plugins()) {
      const src = filesOf(path.join(ROOT, p, 'src'));
      const uses = src.some((f) => !f.endsWith('host-controls.tsx') && /from '\.\/(web\/)?host-controls'/.test(fs.readFileSync(f, 'utf8')));
      if (!uses) continue;
      const entry = path.join(ROOT, p, 'src/web.tsx');
      const text = fs.existsSync(entry) ? fs.readFileSync(entry, 'utf8') : '';
      if (!/setHostControls\(walnut\.ui\.views\)/.test(text)) missing.push(`${p}/src/web.tsx`);
    }
    expect(missing, 'Call setHostControls(walnut.ui.views) first in activate, or the page draws only the fallbacks:').toEqual([]);
  });

  it('finds the plugins that use it', () => {
    const using = plugins().filter((p) => fs.existsSync(path.join(ROOT, p, 'src/web/host-controls.tsx')));
    expect(using).toEqual(expect.arrayContaining(['examples/plugins/walnut-time', 'examples/plugins/walnut-demo', 'plugin-store/walnut-rhythm', 'plugin-store/notes-import']));
  });
});
