/**
 * The selection bar draws more than one layer: the bar and the menu it opens, each
 * portalled to <body> on its own. Code that asks "was this press on the bar?" (an
 * outside-press check of a question card, a drawer, a popover) has to name every
 * layer, so it goes through SELECTION_BAR_LAYERS (web/src/components/sessions/
 * selection-bar-layers.ts). 2026-11-06: when the Ask choice and the Comment box
 * moved into a popover of their own, three such checks still named only
 * `.quote-pin-pill`, and a press on the menu closed an open question card. This test
 * fails on the next selector that names one layer by itself.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../web/src');
/** The bar itself, which owns its classes, and the module that lists them. */
const OWNERS = new Set(['components/sessions/QuotePinSelectionBar.tsx', 'components/sessions/selection-bar-layers.ts']);
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe('a press on the selection bar names all of its layers', () => {
  it('no selector outside the bar names .quote-pin-pill or .quote-pin-menu alone', () => {
    const alone: string[] = [];
    for (const file of sources(ROOT)) {
      const rel = path.relative(ROOT, file);
      if (OWNERS.has(rel)) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/\.quote-pin-(pill|menu)\b/.test(line)) alone.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(alone).toEqual([]);
  });

  it('the list holds the bar and its menu', async () => {
    const { SELECTION_BAR_LAYERS } = await import('../../web/src/components/sessions/selection-bar-layers');
    expect(SELECTION_BAR_LAYERS.split(',').map((s) => s.trim()).sort()).toEqual(['.quote-pin-menu', '.quote-pin-pill']);
  });
});
