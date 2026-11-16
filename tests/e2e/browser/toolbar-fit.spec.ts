/**
 * E2E: the Home task panel's toolbar keeps the search readable (2026-11-16, Evan: "the new
 * and display occupy too much, when I type I can't even see the text, if the space is not
 * enough use the icon please"). New task and Display fold to icons, Display first, while
 * the search field would drop under its readable width; their labels come back with room.
 * Driven by the toolbar's own width (hooks/useToolbarFit.ts), so the panel width is set
 * here, not the window's. Stubbed board (filter-bar-fixtures.ts).
 *
 * Class guard: every button in the row that spells a word opts into the same rule
 * (data-fit-button + data-fit-label), so a new labeled button cannot squeeze the field.
 */
import { expect, test, type Page } from '@playwright/test'
import { openHome, ownerSeeds, stubBoard } from './filter-bar-fixtures'

test.describe.configure({ timeout: 120_000 })

const MIN_INPUT_PX = 112 // TOOLBAR_FIT_MIN_INPUT_PX
const QUERY = 'hello world'
const toolbar = (page: Page) => page.locator('#home-task-navigation .todo-panel-toolbar')
const input = (page: Page) => toolbar(page).locator('.todo-search-input')

async function setPanel(page: Page, px: number): Promise<void> {
  await page.locator('#home-task-navigation').evaluate((el, w) => { (el as HTMLElement).style.width = `${w}px` }, px)
  await expect.poll(() => toolbar(page).evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBeLessThanOrEqual(px)
  // Two frames: the observer's pass lands before the next paint.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

const read = (page: Page) => toolbar(page).evaluate((bar) => {
  const field = bar.querySelector<HTMLInputElement>('.todo-search-input')!
  const btn = (sel: string) => {
    const b = bar.querySelector<HTMLElement>(sel)!
    const label = b.querySelector<HTMLElement>('[data-fit-label]')
    return { w: Math.round(b.getBoundingClientRect().width), label: !!label && label.getClientRects().length > 0, aria: b.getAttribute('aria-label'), title: b.getAttribute('title') }
  }
  return {
    fold: bar.getAttribute('data-toolbar-fold'),
    inputPx: Math.round(field.getBoundingClientRect().width),
    // The typed text is whole in the field: nothing scrolled out of sight.
    textFits: field.scrollWidth <= field.clientWidth + 1,
    newTask: btn('.new-launcher-btn'),
    display: btn('.dm-display-btn'),
  }
})

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  await stubBoard(page, ownerSeeds(), [])
  await openHome(page)
})

test('narrow panel: the buttons fold to icons and the typed text stays readable; wide: the labels show', async ({ page }) => {
  // Narrow to wide and back: the field is readable whenever a label shows, and at every
  // width where folding can still give it room.
  for (const px of [620, 560, 500, 470, 440, 400, 360, 330, 300, 330, 400, 470, 560, 620]) {
    await setPanel(page, px)
    await input(page).fill('')
    await input(page).click()
    await page.keyboard.type(QUERY)
    await expect(input(page)).toHaveValue(QUERY)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const m = await read(page)
    const at = `panel ${px}px: ${JSON.stringify(m)}`
    if (m.newTask.label || m.display.label) expect(m.inputPx, at).toBeGreaterThanOrEqual(MIN_INPUT_PX)
    if (px >= 330) expect(m.textFits, at).toBe(true)
    // Display folds first: while Display spells its label, New task does too.
    if (m.display.label) expect(m.newTask.label, at).toBe(true)
    for (const b of [m.newTask, m.display]) {
      if (!b.label) expect(b.w, at).toBeLessThanOrEqual(30)
      expect(b.aria, at).toBeTruthy()
      expect(b.title, at).toBeTruthy()
    }
    if (px >= 560) { expect(m.newTask.label, at).toBe(true); expect(m.display.label, at).toBe(true); expect(m.fold, at).toBe('0') }
    if (px <= 360) { expect(m.newTask.label, at).toBe(false); expect(m.display.label, at).toBe(false); expect(m.fold, at).toBe('2') }
  }
})

test('typing never flips the labels: the field counts the room the clear button and the count take', async ({ page }) => {
  for (let px = 420; px <= 560; px += 10) {
    await setPanel(page, px)
    await input(page).fill('')
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const before = (await read(page)).fold
    await input(page).click()
    await page.keyboard.type('h')
    await expect(toolbar(page).locator('.todo-search-clear')).toBeVisible()
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    expect((await read(page)).fold, `panel ${px}px`).toBe(before)
  }
})

test('class guard: every button in the row that spells a word folds with the same rule', async ({ page }) => {
  await setPanel(page, 900)
  const offenders = await toolbar(page).evaluate((bar) => [...bar.querySelectorAll<HTMLElement>(':scope > button, :scope > * > button')]
    .filter((b) => !b.closest('.todo-search-bar'))
    .filter((b) => [...b.childNodes].some((n) => (n.nodeType === Node.TEXT_NODE ? n.textContent : (n as HTMLElement).matches?.('kbd') ? '' : (n as HTMLElement).innerText)?.trim()))
    .filter((b) => !b.hasAttribute('data-fit-button') || !b.querySelector('[data-fit-label]') || !b.getAttribute('aria-label'))
    .map((b) => b.className))
  expect(offenders).toEqual([])
})
