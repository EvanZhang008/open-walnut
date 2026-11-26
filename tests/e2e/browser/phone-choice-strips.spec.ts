/**
 * Choice strips on a phone (390 px): a TabList or a SegmentedControl that is wider than its room
 * scrolls, and it must never hide that, nor draw its items over each other.
 * 2026-11-26 audit: the Home tab bar's names shrank under each other ("Satellite 10" over the
 * next tab's icon: a desktop give-way rule outranked the phone's whole-name rule), and Usage's
 * "Started by" and "Break down by" stopped at "Outside Walnut $0.0(" and "Toke" with nothing
 * saying the row went on.
 * `stripProblems` checks every `.wn-tabs` and `.wn-seg` on the page, so a new strip, a new page
 * or a narrower rule that brings either back fails here.
 */
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { PHONE } from './phone-helpers'
import { routeCosts } from './usage-costs-fixture'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})
test.setTimeout(120_000)

/** For every visible strip: items that overlap the next one, an item whose own content is cut,
 *  a strip that scrolls without its edge mark, and a picked item outside the strip's view. */
async function stripProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    for (const strip of Array.from(document.querySelectorAll<HTMLElement>('.wn-tabs, .wn-seg'))) {
      const box = strip.getBoundingClientRect()
      if (box.width === 0 || box.height === 0 || getComputedStyle(strip).visibility === 'hidden') continue
      const name = strip.getAttribute('aria-label') || String(strip.className).split(' ').slice(-1)[0]
      const items = Array.from(strip.children).filter((c): c is HTMLElement => c instanceof HTMLElement && /^(tab|radio)$/.test(c.getAttribute('role') ?? ''))
      for (let i = 0; i + 1 < items.length; i++) {
        const a = items[i].getBoundingClientRect(), b = items[i + 1].getBoundingClientRect()
        if (Math.abs(a.top - b.top) < 4 && a.right > b.left + 1) out.push(`${name}: "${items[i].textContent?.trim()}" runs ${Math.round(a.right - b.left)} px over "${items[i + 1].textContent?.trim()}"`)
      }
      for (const it of items) {
        if (it.scrollWidth > it.clientWidth + 1) out.push(`${name}: "${it.textContent?.trim()}" is cut (${it.scrollWidth} in ${it.clientWidth})`)
      }
      const scrolls = strip.scrollWidth > strip.clientWidth + 1
      const more = strip.getAttribute('data-more') ?? ''
      if (scrolls && !more) out.push(`${name}: scrolls (${strip.scrollWidth} in ${strip.clientWidth}) with no edge mark`)
      if (!scrolls && more) out.push(`${name}: marks "${more}" but fits`)
      const cs = getComputedStyle(strip) as CSSStyleDeclaration & { webkitMaskImage?: string }
      if (more && (cs.maskImage || cs.webkitMaskImage || 'none') === 'none') out.push(`${name}: marks "${more}" but draws no fade`)
      const picked = items.find((it) => it.getAttribute('aria-selected') === 'true' || it.getAttribute('aria-checked') === 'true')
      if (scrolls && picked) {
        const p = picked.getBoundingClientRect()
        if (p.left < box.left - 1 || p.right > box.right + 1) out.push(`${name}: the pick "${picked.textContent?.trim()}" is outside the strip's view`)
        // Clear of the 36 px fade on a side that has more past it.
        else if ((more.includes('left') && p.left < box.left + 36) || (more.includes('right') && p.right > box.right - 36)) out.push(`${name}: the pick "${picked.textContent?.trim()}" sits under the edge fade`)
      }
    }
    return out
  })
}

test('Home: the tab bar keeps every name whole, side by side, and says it scrolls', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try {
      localStorage.setItem('open-walnut-home-chat-visible', 'false')
      localStorage.setItem('walnut-todo-quick-views-visible', 'true')
      // Every tab on the bar (the default hides Focus, Satellite and Recent).
      localStorage.setItem('walnut-todo-tab-bar-hidden-tabs', '[]')
    } catch { /* storage off */ }
  })
  await page.goto('/')
  const bar = page.locator('.todo-section-tabs-list')
  await expect(bar).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => bar.locator('[role="tab"]').count()).toBeGreaterThan(3)
  expect(await stripProblems(page)).toEqual([])
  // Scrolled to the end, the left edge says there is more before it.
  await bar.evaluate((el) => { el.scrollLeft = el.scrollWidth })
  if (await bar.evaluate((el) => el.scrollWidth > el.clientWidth + 1)) {
    await expect(bar).toHaveAttribute('data-more', /left/)
  }
})

test('Usage: Started by and Break down by say they scroll and keep the pick in view', async ({ page }) => {
  await routeCosts(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Menu', exact: true }).click({ timeout: 60_000 })
  await page.locator('#primary-sidebar').getByRole('link', { name: /settings/i }).first().click()
  await page.getByTestId('settings-nav-usage').click()
  await expect(page.getByTestId('usage-total-cost')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => page.locator('.settings-pane .wn-seg').count()).toBeGreaterThan(1)
  expect(await stripProblems(page)).toEqual([])
  // Picked while out of view, the strip itself brings it in (a script click, so neither
  // Playwright nor the focus scrolls it): the last choice, then one in the middle.
  const group = page.getByRole('radiogroup', { name: /break down by/i })
  for (const at of [-1, 2]) {
    await group.evaluate((el, i) => {
      el.scrollLeft = i < 0 ? 0 : el.scrollWidth
      const radios = Array.from(el.querySelectorAll<HTMLElement>('[role="radio"]'))
      radios.at(i)!.click()
    }, at)
    await expect.poll(() => stripProblems(page)).toEqual([])
  }
})
