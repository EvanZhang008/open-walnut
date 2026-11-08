/**
 * The Files tab's question rail sits at the left edge of the file on show (left 4px, 20px wide).
 * Where a surface starts its line numbers or its text at that edge, the rail hid them
 * (2026-11-08, Mac WebKit: lines 10 to 13 of a Markdown file in Source, and the first letters of
 * the same file in Preview). Every surface the thread layer knows (FileThreadSurface) is found
 * from the source and must be one this test knows how the rail clears; a new one fails until it
 * is decided.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../web/src');
const LAYER = fs.readFileSync(path.join(WEB, 'components/common/FileThreadLayer.tsx'), 'utf8');
const CSS = fs.readFileSync(path.join(WEB, 'styles/file-thread.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** How each surface keeps its first column clear of the rail. `step` surfaces are marked while
 *  the layer is on them (the rail may show) and must step the named element right of the rail. */
const CLEARED: Record<string, { step: string } | { reason: string }> = {
  source: { step: '.cm-gutters' },
  preview: { step: '.fv-md-preview' },
  wysiwyg: { step: '.fv-wysiwyg-editor' },
  pre: { reason: 'the read-only code view numbers sit right-aligned in a 48px column, clear of the rail' },
  diff: { reason: 'the diff numbers sit right-aligned in a wide cell, clear of the rail' },
  html: { reason: 'the page is its own document in a frame; the rail floats over its body margin' },
  none: { reason: 'nothing is shown, so no rail' },
};

function surfaces(): string[] {
  const union = /export type FileThreadSurface\s*=([^;]+);/.exec(LAYER)?.[1] ?? '';
  return [...union.matchAll(/'(\w+)'/g)].map((m) => m[1]);
}

function px(value: string | undefined): number {
  return Number(/(\d+(?:\.\d+)?)px/.exec(value ?? '')?.[1] ?? NaN);
}

describe('the file question rail never hides a first column', () => {
  it('knows how the rail clears every surface', () => {
    const all = surfaces();
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (const s of all) expect(CLEARED[s], `surface "${s}"`).toBeTruthy();
  });

  it('marks exactly the stepping surfaces while the rail shows', () => {
    const marked = /RAIL_CLEARED_SURFACES[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(LAYER)?.[1] ?? '';
    const listed = [...marked.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    const stepping = Object.entries(CLEARED).filter(([, v]) => 'step' in v).map(([k]) => k).sort();
    expect(listed).toEqual(stepping);
    expect(LAYER).toMatch(/const railClears = RAIL_CLEARED_SURFACES\.has\(surface\);/);
  });

  it('the room for the rail never depends on a question or a card, so opening one never moves the text', () => {
    // 2026-11-10 review (WebKit): opening the first card brought the rail chip and its gutter,
    // and the text shifted 12px right under the reader.
    const decl = /const railClears = ([^;]+);/.exec(LAYER)?.[1] ?? '';
    expect(decl).not.toMatch(/railRows|openCardKey|cardKey|mine|threads\./);
    // Nothing else in the layer marks the view on a card or a question.
    expect(LAYER.match(/holdRailGutter\(/g)?.length).toBe(1);
  });

  it('steps each marked surface right of the rail', () => {
    const attr = /RAIL_SHOWN_ATTR = '([^']+)'/.exec(LAYER)?.[1];
    expect(attr).toBeTruthy();
    const rail = /\.fv-file-rail\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    const railRight = px(/left:\s*([^;]+);/.exec(rail)?.[1]) + px(/width:\s*([^;]+);/.exec(rail)?.[1]);
    expect(railRight).toBeGreaterThan(0);
    for (const v of Object.values(CLEARED)) {
      if (!('step' in v)) continue;
      const rules = [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .filter((m) => m[1].split(',').some((sel) => sel.trim() === `[${attr}] ${v.step}`));
      expect(rules.length, `a rule for [${attr}] ${v.step}`).toBe(1);
      expect(px(/padding-left:\s*([^;]+);/.exec(rules[0][2])?.[1])).toBeGreaterThanOrEqual(railRight);
    }
  });
});
