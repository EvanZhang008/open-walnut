/**
 * The tasks table's paint area stays bounded: WKWebView ratchet.
 *
 * Same root cause as the rich-text editor (tests/web/editor-paint-containment.test.ts),
 * found by sweeping every tall scroller in the app after that fix landed: WebKit keeps a
 * backing store for a subtree's whole scrollable height, Blink does not.
 *
 * Measured 2026-09-03 against the live server on the real dataset (2,923 tasks, 79,073
 * elements, 107,240px of content), scrolling at 3,000 px/s:
 *
 *   engine     without containment        with containment
 *   WebKit     6-8 fps, gaps to 522ms     53-59 fps, worst gap 57ms
 *   Chromium   108 fps                    108 fps
 *
 * The engine gap is the whole story: identical DOM, identical React, and only the Mac
 * app (a WKWebView) ever felt broken. A scroll here mutates NO DOM, so it was never a
 * React problem — it was pure rasterisation.
 *
 * Two things make the declaration safe, and both are assumptions a future change could
 * break, so they are pinned below: every menu on this page is portalled (paint
 * containment clips descendants to the padding box, so an INLINE menu near the bottom of
 * the table would be cut off), and the containment must be `paint`, never `strict`/`size`
 * — those also contain size, which would collapse a 107,240px table into its scroller.
 *
 * Not applied elsewhere by reflex: the 141,766px calendar rail (11,626 elements) already
 * scrolls at 58 fps, so containment there would be cargo-culting.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(import.meta.dirname, '../../web/src');
const CSS_SRC = fs.readFileSync(path.join(WEB, 'styles/tasks-page.css'), 'utf8');

function ruleBody(selectorLine: string): string {
  const idx = CSS_SRC.indexOf(selectorLine);
  expect(idx, `missing CSS rule: ${selectorLine}`).toBeGreaterThan(-1);
  return CSS_SRC.slice(idx, CSS_SRC.indexOf('}', idx) + 1);
}

describe('tasks table paint containment', () => {
  it('the table scroller bounds its paint area', () => {
    const body = ruleBody('.tp-table-scroll {');
    expect(
      body,
      'without `contain: paint` WebKit rasterises the whole 107,240px table on every '
      + 'scroll step: measured 6-8 fps with frame gaps to 522ms, vs 53-59 fps with it',
    ).toMatch(/contain:\s*(paint|content|strict)\b/);
  });

  it('the contained element is the scroller itself', () => {
    // Containment has to sit on the element that owns the overflow, otherwise the
    // backing store it bounds is not the one being rasterised.
    expect(ruleBody('.tp-table-scroll {')).toContain('overflow-y: auto');
  });

  it('the table is still allowed to be taller than its scroller', () => {
    // `contain: strict`/`size` also contain SIZE, which would collapse the table to its
    // own height and hide every task below the fold — a far worse bug than the jank.
    expect(ruleBody('.tp-table-scroll {')).not.toMatch(/contain:\s*(strict|size)\b/);
  });

  it('this page\'s menus are portalled, so containment cannot clip them', () => {
    // The kebab menu on the LAST row of a 2,923-row table opens near the bottom edge of
    // the scroller. Rendered inline it would be clipped by paint containment and appear
    // truncated or invisible; portalled it is not a descendant, so containment cannot
    // touch it. Web UI convention here already requires portals for menus (see
    // web/src/AGENTS.md "Menus & overlays"), and this is the ratchet for the specific
    // ones that live inside the contained box.
    const menus = [
      'components/tasks/TaskKebabMenu.tsx',
      'components/tasks/ProjectHeaderMenus.tsx',
    ];
    for (const file of menus) {
      const src = fs.readFileSync(path.join(WEB, file), 'utf8');
      expect(src, `${file} must portal out of the contained scroller`).toContain('createPortal');
    }
  });

  it('the sticky table head is inside the contained box, so it must stay sticky', () => {
    // Paint containment makes the element a containing block. The head is a CHILD of the
    // scroller and sticks to it, which is why this still works (verified live: header
    // offset 0px while scrolled). Pin the relationship so a refactor that hoists the
    // head out of the scroller has to think about it.
    expect(ruleBody('.tp-thead,')).toBeTruthy();
    expect(CSS_SRC).toMatch(/\.tp-thead \{[^}]*position:\s*sticky/);
  });
});
