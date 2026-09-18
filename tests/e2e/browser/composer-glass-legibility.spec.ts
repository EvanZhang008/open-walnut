/**
 * The session composer card keeps its G4 milky-glass recipe at the readability
 * floor, in both themes.
 *
 * Origin: "need more fuzzy for the background, the text should be super clear
 * even if there is text in the background". Back then the composer was an
 * overlay the transcript scrolled UNDER, so the card AND a masked wash on the
 * wrapper (for the notes bar / recap tip / send-error rows riding above the
 * card) had to be opaque and blurred enough to keep chrome text crisp over
 * message text.
 *
 * The composer is in flow now (2026-09-18, composer-in-flow-helpers.ts): the
 * scroller ends where it starts and nothing scrolls under those rows, so the
 * wrapper's wash is gone by design and is deliberately NOT asserted here any
 * more. What remains is the card's own material (the recipe the user tuned),
 * and the wrapper must still not carry a blur of its own (a backdrop-filter on
 * the element itself would make it the containing block for every popover it
 * anchors: command palette, file mention, btw).
 *
 * SURFACE NOTE (P1 of "remove the main agent"): the home page's own
 * `.chat-composer-overlay` is GONE — the chat spot is an Ask Walnut session view,
 * so its composer IS a `.session-panel-input`.
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

test('session composer card keeps its glass at the readability floor', async ({ page }) => {
  await openSeededSession(page)

  const wrapper = composer(page)
  await expect(wrapper).toBeVisible({ timeout: 15_000 })

  // ── 1. The wrapper element itself must NOT carry a blur (containing-block trap) ──
  const wrapperSelf = await wrapper.evaluate(el => {
    const s = getComputedStyle(el)
    return { blur: s.backdropFilter || s.webkitBackdropFilter, border: s.borderTopWidth, position: s.position }
  })
  expect(wrapperSelf.blur === 'none' || wrapperSelf.blur === '').toBe(true)
  expect(wrapperSelf.border, 'no border-top, the card carries the edge').toBe('0px')
  // In flow, positioned so ChatInput's popovers can anchor to it, never absolute.
  expect(wrapperSelf.position).toBe('relative')

  // ── 2. The composer card's own glass is at the readability floor ──
  const card = wrapper.locator('.chat-input-box')
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

  const card = composer(page).locator('.chat-input-box')
  await expect(card).toBeVisible({ timeout: 15_000 })

  // color-mix(... 88%, transparent) must resolve to a real alpha at/above the
  // floor — the dark tokens are a separate code path from the light ones and were
  // the half of the recipe most likely to be left at the old 68%.
  const background = await card.evaluate(el => getComputedStyle(el).backgroundColor)
  expect(parseColor(background)[3], background).toBeGreaterThanOrEqual(MIN_ALPHA)
})
