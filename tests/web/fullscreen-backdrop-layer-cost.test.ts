/**
 * Fullscreen split (Files / Changed / Code / Terminal): compositor-cost ratchet.
 *
 * Measured in the system WKWebView (the Mac app) by opening the Files split in
 * a fresh process and counting the WebContent process's IOSurfaces
 * (scripts/local/wk-harness.swift, 2026-09-02). Three findings this file pins:
 *
 *   1. `backdrop-filter: blur(4px)` on the full-viewport backdrop re-blurred
 *      everything underneath (streaming session columns) on every frame, to
 *      decorate the 2.5% rim the 95vw×95vh panel leaves uncovered.
 *   2. Centering the panel with `transform: translate(-50%, -50%)` made it its
 *      own tiled layer: opening Files cost +37 tiles vs +23 with inset
 *      centering (left/right: 0 + margin auto).
 *   3. A viewport-sized spread box-shadow as the dim is the WORST option
 *      (+56 tiles: the shadow extent becomes the layer's bounds), so the plain
 *      colour backdrop stays — it is one surface, the honest price of the dim.
 *
 * Context: the Mac app reached 2.7GB of layer memory and 17s main-thread
 * freezes when opening Files. Chromium tiers cannot see compositor memory,
 * hence a CSS ratchet.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CSS_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/styles/globals.css'),
  'utf8'
);

function ruleBody(selectorLine: string): string {
  const idx = CSS_SRC.indexOf(selectorLine);
  expect(idx, `missing CSS rule: ${selectorLine}`).toBeGreaterThan(-1);
  return CSS_SRC.slice(idx, CSS_SRC.indexOf('}', idx) + 1);
}

describe('fullscreen split compositor cost', () => {
  it('backdrop: a plain full-viewport dim, no blur, no animation', () => {
    const body = ruleBody('.open-walnut-fullscreen-backdrop {');
    expect(body).toContain('position: fixed');
    expect(body).toContain('inset: 0');
    expect(body).toContain('background: var(--overlay-bg)');
    expect(body).not.toMatch(/backdrop-filter/);
    expect(body).not.toMatch(/animation:/);
    expect(body).not.toMatch(/will-change|transform/);
  });

  it('panel: inset centering, never a transform (a transform = its own tiled layer)', () => {
    // Line-anchored: `.wf-card.open-walnut-fullscreen {` appears earlier in the file.
    const body = ruleBody('\n.open-walnut-fullscreen {');
    expect(body).toContain('left: 0');
    expect(body).toContain('right: 0');
    expect(body).toContain('margin: 0 auto');
    expect(body).not.toMatch(/\btransform:/);
    // The dim must not come back as a spread shadow either.
    expect(body).not.toMatch(/box-shadow:[^;]*vmax/);
  });

  it('enter animation is opacity-only', () => {
    const body = ruleBody('@keyframes fullscreen-enter {');
    expect(body).not.toMatch(/transform/);
  });

  it('consumers that override margin keep the auto centering', () => {
    expect(ruleBody('.wf-card.open-walnut-fullscreen {')).toContain('margin: 0 auto');
  });
});
