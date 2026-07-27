/**
 * Composer chrome must stay legible when transcript text scrolls UNDER it.
 *
 * Reported bug: "need more fuzzy for the background, the text should be super
 * clear even if there is text in the background". The G4 liquid-glass pass made
 * `.chat-composer-overlay` fully transparent so only the `.chat-input-box` card
 * carried glass — but the QuickAccessBar pills, the Quick Start bar and the
 * queue indicator all ride ABOVE that card inside the same absolute overlay, so
 * those rows had NO material at all and their labels collided pixel-for-pixel
 * with the message text scrolling beneath. The G4 recipe itself was also too
 * clear (0.68 alpha / 30px blur) to keep chrome text crisp.
 *
 * Guards both halves of the fix, on the real rendered page:
 *  1. every scroll-under glass surface has a blur AND an alpha at/above the
 *     readability floor,
 *  2. the overlay paints a masked wash behind the bare rows above the card,
 *  3. the chrome labels are no longer the weakest-contrast --fg-muted.
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

test('composer glass keeps chrome text readable over scrolling content', async ({ page }) => {
  await page.goto('/')

  const overlay = page.locator('.chat-composer-overlay')
  await expect(overlay).toBeVisible({ timeout: 15_000 })

  // ── 1. The overlay paints a masked glass wash behind the bare rows ──
  // It lives on ::before (backdrop-filter on the element itself would make the
  // overlay the containing block for the fixed/absolute popovers it anchors).
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
  expect(wash.content, 'overlay ::before must render (the glass wash)').not.toBe('none')
  expect(wash.blur, 'wash must blur what scrolls under it').toMatch(/blur\(/)
  expect(Number(/blur\(([\d.]+)px\)/.exec(wash.blur)?.[1] ?? 0)).toBeGreaterThanOrEqual(MIN_BLUR)
  expect(parseColor(wash.background)[3]).toBeGreaterThanOrEqual(MIN_ALPHA)
  // Soft edge, not a bordered slab — the earlier "border shadow, square" fix.
  expect(wash.mask, 'wash must dissolve into content via a mask').toMatch(/gradient/)
  expect(Number(wash.zIndex)).toBeLessThan(0)
  // The gradient ramp must live ABOVE the overlay's content box — with inset:0 the
  // first chrome row (the pills) sits halfway up the ramp and stays see-through,
  // which is precisely the row the user reported as unreadable.
  expect(wash.top, 'wash bleeds upward by the fade distance').toMatch(/^-\d/)

  // The overlay element itself must NOT carry the blur (popover containing-block trap).
  const overlaySelf = await overlay.evaluate(el => {
    const s = getComputedStyle(el)
    return { blur: s.backdropFilter || s.webkitBackdropFilter, border: s.borderTopWidth }
  })
  expect(overlaySelf.blur === 'none' || overlaySelf.blur === '').toBe(true)
  expect(overlaySelf.border, 'no border-top — the wash is edgeless').toBe('0px')

  // ── 2. The composer card's own glass is at the readability floor ──
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

  // ── 3. Chrome labels stepped off the weakest-contrast muted grey ──
  // --fg-muted (#86868B light / #8E8E93 dark) was unreadable over content; the
  // pills now use --fg-secondary. Compare against the muted token at runtime so
  // this holds in either theme.
  const muted = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--fg-muted').trim())
  const mutedRgb = await page.evaluate((hex) => {
    const probe = document.createElement('span')
    probe.style.color = hex
    document.body.appendChild(probe)
    const c = getComputedStyle(probe).color
    probe.remove()
    return c
  }, muted)

  const pill = overlay.locator('.quick-access-pill').first()
  await expect(pill).toBeVisible()
  const pillColor = await pill.evaluate(el => getComputedStyle(el).color)
  expect(pillColor, 'pill labels must not stay at --fg-muted').not.toBe(mutedRgb)

  // Luminance sanity: the label must be DARKER than muted on a light theme
  // (higher contrast against the milky wash), lighter on dark.
  const lum = (c: string) => { const [r, g, b] = parseColor(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
  const bgLum = lum(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))
  if (bgLum > 128) expect(lum(pillColor)).toBeLessThan(lum(mutedRgb))
  else expect(lum(pillColor)).toBeGreaterThan(lum(mutedRgb))

  // ── 4. Quick Start bar gets its own readable surface (was 8%-alpha tint) ──
  // Open it through the real UI: the "fix walnut" pill sets the intent directly.
  const fixPill = page.getByRole('button', { name: /fix walnut/i })
  if (await fixPill.count()) {
    await fixPill.click()
    const bar = overlay.locator('.quick-start-bar')
    await expect(bar).toBeVisible({ timeout: 10_000 })
    const barBg = await bar.evaluate(el => getComputedStyle(el).backgroundColor)
    // Near-opaque so the monospace path can't blend into message text beneath.
    expect(parseColor(barBg)[3]).toBeGreaterThanOrEqual(MIN_ALPHA)
    const pathColor = await bar.locator('.qsb-path').evaluate(el => getComputedStyle(el).color)
    expect(pathColor).not.toBe(mutedRgb)
  }
})

test('session composer overlay carries the same wash', async ({ page }) => {
  // The session composer only exists once a session column is open — restore one
  // from the seeded fixture the same way the session specs do.
  await page.addInitScript(() => {
    sessionStorage.setItem('open-walnut-home-session-columns',
      JSON.stringify([{ id: 'pw-normal-session', locked: false }]))
  })
  await page.goto('/')

  const sessionInput = page.locator(
    '.session-panel[data-session-id="pw-normal-session"] .session-panel-input')
  await expect(sessionInput.first()).toBeVisible({ timeout: 15_000 })
  const wash = await sessionInput.first().evaluate(el => {
    const s = getComputedStyle(el, '::before')
    return {
      content: s.content,
      background: s.backgroundColor,
      blur: s.backdropFilter || s.webkitBackdropFilter,
      mask: s.maskImage || s.webkitMaskImage,
      top: s.top,
    }
  })
  expect(wash.content).not.toBe('none')
  expect(Number(/blur\(([\d.]+)px\)/.exec(wash.blur)?.[1] ?? 0)).toBeGreaterThanOrEqual(MIN_BLUR)
  expect(parseColor(wash.background)[3]).toBeGreaterThanOrEqual(MIN_ALPHA)
  expect(wash.mask).toMatch(/gradient/)
  // The fade must sit ABOVE the content box, otherwise the notes bar / recap tip
  // land mid-ramp where the wash is still see-through.
  expect(wash.top, 'wash bleeds upward by the fade distance').toMatch(/^-\d/)
})

test('dark theme keeps the same opacity floor', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-theme', 'dark') } catch { /* storage disabled */ }
    document.documentElement.setAttribute('data-theme', 'dark')
  })
  await page.goto('/')

  const overlay = page.locator('.chat-composer-overlay')
  await expect(overlay).toBeVisible({ timeout: 15_000 })

  // color-mix(... 88%, transparent) must resolve to a real alpha at/above the
  // floor — the dark tokens are a separate code path from the light ones and were
  // the half of the recipe most likely to be left at the old 68%.
  const alpha = await overlay.evaluate(el =>
    Number(/[\d.]+(?=\)$)/.exec(getComputedStyle(el, '::before').backgroundColor)?.[0] ?? '1'))
  expect(alpha).toBeGreaterThanOrEqual(MIN_ALPHA)
})
