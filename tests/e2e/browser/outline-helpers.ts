/**
 * Opening the session outline (`SessionPinnedToc`) the way a person does: point at its
 * rail, then act on the panel once it is there.
 *
 * The panel slides in (`session-toc-in`: 100 ms, a 2 px translate). A click that
 * lands inside that slide finds its target "not stable", and Playwright's retry
 * policy then scrolls the target into view with forced alignments (end, then
 * CENTER, then start: `_retryPointerAction` in playwright-core's dom.js) before it
 * clicks, even when the target is fully on screen. The outline is sticky inside the
 * timeline's scroller, so that forced scroll moves the TIMELINE: on 2026-11-04 it
 * moved it 211 px up between the click's pointerdown and its handler, the jump
 * recorded that moved spot as "where the reader was", and Back returned there
 * (session-outline-rewind.spec.ts, deterministic on Linux Chromium and in CI).
 *
 * No person's click scrolls anything, so the product was right; the click was not
 * a person's. Every spec opens the outline through `openOutline`, which waits for the
 * panel's own animations to finish, and the ratchet in
 * tests/web/outline-open-settled.test.ts fails on a spec that hovers or clicks the rail
 * itself.
 */
import { expect, type Locator } from '@playwright/test'

/**
 * Point at the outline's rail and resolve once its panel is open and its entrance
 * animation has finished. Returns the panel.
 *
 * The pointer moves with raw mouse moves, never `locator.hover()`: the open panel
 * covers the rail, so a hover aimed at the rail can find another element on top, and
 * Playwright retries that with the same forced scrolls. The pointer first leaves the
 * outline (the panel opens on entering it, and a pointer already inside would not
 * enter again), then comes to the rail's middle.
 */
export async function openOutline(toc: Locator): Promise<Locator> {
  const page = toc.page()
  const box = await toc.locator('.session-toc-rail').boundingBox()
  if (!box) throw new Error('the outline rail is not on screen')
  // Past the open panel's widest (max-width 420px), so the pointer is outside the outline.
  await page.mouse.move(box.x + 480, box.y + box.height / 2)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const panel = toc.locator('.session-toc-panel')
  await expect(panel).toBeVisible()
  await panel.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined))).then(() => undefined))
  return panel
}
