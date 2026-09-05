/**
 * Composer chrome must stay legible when transcript text scrolls UNDER it.
 *
 * Reported bug: "need more fuzzy for the background, the text should be super
 * clear even if there is text in the background". The G4 liquid-glass pass left
 * the composer's wrapper fully transparent so only the `.chat-input-box` card
 * carried glass — but the rows that ride ABOVE that card inside the same absolute
 * wrapper (notes bar, recap tip, send-error line, queue indicator) had NO material
 * at all and their labels collided pixel-for-pixel with the message text scrolling
 * beneath. The G4 recipe itself was also too clear (0.68 alpha / 30px blur) to
 * keep chrome text crisp.
 *
 * SURFACE NOTE (P1 of "remove the main agent"): the home page's own
 * `.chat-composer-overlay` is GONE — the chat spot is an Ask Walnut session view,
 * so its composer IS a `.session-panel-input`. The two overlays always shared one
 * recipe (`--glass-g4-bg` / `--glass-g4-blur` / `--glass-g4-fade`, a masked
 * ::before inset upward by the fade), so everything below now measures the
 * surviving surface. Two assertions from the old chat half are deliberately NOT
 * carried over, because the rules they pinned were scoped to the deleted overlay
 * and no longer exist anywhere: the `--fg-secondary` bump on
 * `.quick-access-pill` / `.mode-toggle-pill`, and the Quick Start bar's own
 * opaque surface.
 *
 * Guards, on the real rendered page:
 *  1. the composer wrapper paints a masked wash behind the bare rows above the card,
 *     with a blur AND an alpha at/above the readability floor,
 *  2. the wrapper itself does NOT carry the blur (that would make it the containing
 *     block for every popover it anchors),
 *  3. the card's own glass is at the same floor,
 *  4. the dark tokens — a separate code path — hold the same floor.
 */

import { test, expect } from '@playwright/test'

/** Parse a computed color into [r,g,b,a]; alpha defaults to 1 when opaque. */
function parseColor(css: string): [number, number, number, number] {
  const nums = css.match(/[\d.]+/g)?.map(Number) ?? []
  const [r = 0, g = 0, b = 0, a = 1] = nums
  return [r, g, b, a]
}

/** Readability floor from globals.css: never clearer than 0.84, blur >= 36px. */
const MIN_ALPHA = 0.84
const MIN_BLUR = 36

/** The seeded fixture session, restored as a column the way the session specs do. */
async function openSeededSession(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    sessionStorage.setItem('open-walnut-home-session-columns',
      JSON.stringify([{ id: 'pw-normal-session', locked: false }]))
  })
  await page.goto('/')
}

const composer = (page: import('@playwright/test').Page) =>
  page.locator('.session-panel[data-session-id="pw-normal-session"] .session-panel-input').first()

test('session composer glass keeps chrome text readable over scrolling content', async ({ page }) => {
  await openSeededSession(page)

  const overlay = composer(page)
  await expect(overlay).toBeVisible({ timeout: 15_000 })

  // ── 1. The wrapper paints a masked glass wash behind the bare rows ──
  // It lives on ::before (backdrop-filter on the element itself would make the
  // wrapper the containing block for the fixed/absolute popovers it anchors).
  const wash = await overlay.evaluate(el => {
    const s = getComputedStyle(el, '::before')
    return {
      content: s.content,
      background: s.backgroundColor,
      blur: s.backdropFilter || s.webkitBackdropFilter,
      mask: s.maskImage || s.webkitMaskImage,
      zIndex: s.zIndex,
      top: s.top,
    }
  })
  expect(wash.content, 'composer ::before must render (the glass wash)').not.toBe('none')
  expect(wash.blur, 'wash must blur what scrolls under it').toMatch(/blur\(/)
  expect(Number(/blur\(([\d.]+)px\)/.exec(wash.blur)?.[1] ?? 0)).toBeGreaterThanOrEqual(MIN_BLUR)
  expect(parseColor(wash.background)[3]).toBeGreaterThanOrEqual(MIN_ALPHA)
  // Soft edge, not a bordered slab — the earlier "border shadow, square" fix.
  expect(wash.mask, 'wash must dissolve into content via a mask').toMatch(/gradient/)
  expect(Number(wash.zIndex)).toBeLessThan(0)
  // The gradient ramp must live ABOVE the wrapper's content box — with inset:0 the
  // first chrome row sits halfway up the ramp and stays see-through, which is
  // precisely the row the user reported as unreadable.
  expect(wash.top, 'wash bleeds upward by the fade distance').toMatch(/^-\d/)

  // ── 2. The wrapper element itself must NOT carry the blur (containing-block trap) ──
  const overlaySelf = await overlay.evaluate(el => {
    const s = getComputedStyle(el)
    return { blur: s.backdropFilter || s.webkitBackdropFilter, border: s.borderTopWidth }
  })
  expect(overlaySelf.blur === 'none' || overlaySelf.blur === '').toBe(true)
  expect(overlaySelf.border, 'no border-top — the wash is edgeless').toBe('0px')

  // ── 3. The composer card's own glass is at the readability floor ──
  const card = overlay.locator('.chat-input-box')
  await expect(card).toBeVisible()
  const cardGlass = await card.evaluate(el => {
    const s = getComputedStyle(el)
    const before = getComputedStyle(el, '::before')
    return {
      background: s.backgroundColor,
      blur: before.backdropFilter || before.webkitBackdropFilter,
    }
  })
  expect(parseColor(cardGlass.background)[3]).toBeGreaterThanOrEqual(MIN_ALPHA)
  expect(Number(/blur\(([\d.]+)px\)/.exec(cardGlass.blur)?.[1] ?? 0)).toBeGreaterThanOrEqual(MIN_BLUR)
})

test('dark theme keeps the same opacity floor', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-theme', 'dark') } catch { /* storage disabled */ }
    document.documentElement.setAttribute('data-theme', 'dark')
  })
  await openSeededSession(page)

  const overlay = composer(page)
  await expect(overlay).toBeVisible({ timeout: 15_000 })

  // color-mix(... 88%, transparent) must resolve to a real alpha at/above the
  // floor — the dark tokens are a separate code path from the light ones and were
  // the half of the recipe most likely to be left at the old 68%.
  const alpha = await overlay.evaluate(el =>
    Number(/[\d.]+(?=\)$)/.exec(getComputedStyle(el, '::before').backgroundColor)?.[0] ?? '1'))
  expect(alpha).toBeGreaterThanOrEqual(MIN_ALPHA)
})
