/**
 * Choice strips on a phone (390 px): a TabList or a SegmentedControl that is wider than its room
 * scrolls, and it must never hide that, nor draw its items over each other.
 * 2026-11-26 audit: the Home tab bar's names shrank under each other ("Satellite 10" over the
 * next tab's icon: a desktop give-way rule outranked the phone's whole-name rule), and Usage's
 * "Started by" and "Break down by" stopped at "Outside Walnut $0.0(" and "Toke" with nothing
 * saying the row went on.
 * `stripProblems` checks every `.wn-tabs` and `.wn-seg` on the page and every other row of choices
 * that scrolls sideways (the bell panel's sections were one: their first entry was cut to "u" with
 * no sign of more), so a new strip, a new page or a narrower rule that brings it back fails here.
 */
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { PHONE } from './phone-helpers'
import { routeCosts } from './usage-costs-fixture'
import { cutLargeText, usageFigureProblems } from './figure-fit-helpers'

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
    const isItem = (c: Element): c is HTMLElement => c instanceof HTMLElement && (/^(tab|radio)$/.test(c.getAttribute('role') ?? '') || c.matches('button, a'))
    const strips = new Set(Array.from(document.querySelectorAll<HTMLElement>('.wn-tabs, .wn-seg')))
    // Any other short row of two or more choices that scrolls sideways is a strip too.
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const ox = getComputedStyle(el).overflowX
      if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1 && el.getBoundingClientRect().height <= 80
        && Array.from(el.children).filter(isItem).length >= 2) strips.add(el)
    }
    for (const strip of strips) {
      const box = strip.getBoundingClientRect()
      if (box.width === 0 || box.height === 0 || getComputedStyle(strip).visibility === 'hidden') continue
      const name = strip.getAttribute('aria-label') || String(strip.className).split(' ')[0]
      const items = Array.from(strip.children).filter(isItem)
      for (let i = 0; i + 1 < items.length; i++) {
        const a = items[i].getBoundingClientRect(), b = items[i + 1].getBoundingClientRect()
        if (Math.abs(a.top - b.top) < 4 && a.right > b.left + 1) out.push(`${name}: "${items[i].textContent?.trim()}" runs ${Math.round(a.right - b.left)} px over "${items[i + 1].textContent?.trim()}"`)
      }
      for (const it of items) {
        if (it.scrollWidth > it.clientWidth + 1) out.push(`${name}: "${it.textContent?.trim()}" is cut (${it.scrollWidth} in ${it.clientWidth})`)
      }
      const scrolls = strip.scrollWidth > strip.clientWidth + 1
      const more = strip.getAttribute('data-strip-more') ?? ''
      if (scrolls && !more) out.push(`${name}: scrolls (${strip.scrollWidth} in ${strip.clientWidth}) with no edge mark`)
      if (!scrolls && more) out.push(`${name}: marks "${more}" but fits`)
      const cs = getComputedStyle(strip) as CSSStyleDeclaration & { webkitMaskImage?: string }
      if (more && (cs.maskImage || cs.webkitMaskImage || 'none') === 'none') out.push(`${name}: marks "${more}" but draws no fade`)
      const picked = items.find((it) => it.getAttribute('aria-selected') === 'true' || it.getAttribute('aria-checked') === 'true'
        || it.getAttribute('aria-current') === 'page' || it.getAttribute('aria-pressed') === 'true')
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
    await expect(bar).toHaveAttribute('data-strip-more', /left/)
  }
})

test('Bell: the panel sections say they scroll and keep the picked one whole', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.goto('/')
  await page.locator('[aria-label^="Notifications"]:visible').first().click({ timeout: 60_000 })
  const rail = page.locator('.nfc-rail')
  await expect(rail).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => stripProblems(page)).toEqual([])
  // Each section, picked by a script click while it is out of view (so neither Playwright nor the
  // focus scrolls the rail): one in the middle, the first, then the last (All, where the first entry
  // was cut to "u"). Each must be a new pick: a click on the section already picked changes nothing,
  // so nothing brings it back. The panel lands on Needs you (the first) when something needs him and
  // on All (the last) otherwise, so the middle goes first (CI 45816478315: six open permission asks
  // left on the shared fixture landed it on Needs you, and a first pick of Needs you stayed
  // scrolled away).
  const sections = rail.locator('.nfc-rail-btn')
  expect(await sections.count(), 'a middle section that is neither end').toBeGreaterThanOrEqual(4)
  for (const at of [2, 0, -1]) {
    const target = at < 0 ? sections.last() : sections.nth(at)
    await expect(target, 'each pick is a new one').not.toHaveAttribute('aria-current', 'page')
    await rail.evaluate((el, i) => {
      el.scrollLeft = i === -1 ? 0 : el.scrollWidth
      Array.from(el.querySelectorAll<HTMLElement>('.nfc-rail-btn')).at(i)!.click()
    }, at)
    await expect(target).toHaveAttribute('aria-current', 'page')
    await expect.poll(() => stripProblems(page)).toEqual([])
  }
  // The rail scrolls on a phone: its edge says so.
  if (await rail.evaluate((el) => el.scrollWidth > el.clientWidth + 1)) await expect(rail).toHaveAttribute('data-strip-more', /./)
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
  // The headline figures sit two to a row here and each shows whole ("$15,..." on all four before).
  await expect(page.locator('.settings-addons-stat')).toHaveCount(4)
  expect(await usageFigureProblems(page)).toEqual([])
  expect(await cutLargeText(page)).toEqual([])
  const tops = await page.locator('.settings-addons-stat').evaluateAll((cards) => cards.map((c) => Math.round(c.getBoundingClientRect().top)))
  expect(new Set(tops).size, 'two rows of two').toBe(2)
  // Picked while out of view, the strip itself brings it in (a script click, so neither
  // Playwright nor the focus scrolls it): the last choice, then one in the middle.
  const group = page.getByRole('radiogroup', { name: /break down by/i })
  // Each a new pick, as the bell's: a click on the choice already picked brings nothing back.
  const radios = group.getByRole('radio')
  for (const at of [-1, 2]) {
    const target = at < 0 ? radios.last() : radios.nth(at)
    await expect(target, 'each pick is a new one').not.toHaveAttribute('aria-checked', 'true')
    await group.evaluate((el, i) => {
      el.scrollLeft = i < 0 ? 0 : el.scrollWidth
      const radios = Array.from(el.querySelectorAll<HTMLElement>('[role="radio"]'))
      radios.at(i)!.click()
    }, at)
    await expect(target).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => stripProblems(page)).toEqual([])
  }
})
