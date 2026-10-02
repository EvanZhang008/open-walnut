/**
 * E2E: the Filter bar fix round (nitpicks F04, F05, F06, F09, F11 to F13, F22,
 * F26, F36). One selected signal on Status values, Collapse all only where it
 * folds something, one number for a search, focus kept inside open popovers,
 * popovers on the task panel and flyouts beside their parent, a date picked in
 * More dates selected at once, and the active view always named.
 * Stubbed boards (filter-bar-fixtures.ts); prefs isolated per test.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  closeFilterMenu, displayMenu, filterDimRow, filterMenu, filterRow, filterValue, moreViewsRow,
  openDisplayMenu, openFilterMenu, settled, valuesFlyout, viewsFlyout,
} from './filter-bar-helpers'
import { MIA, MIA_PINS, box, openHome, ownerSeeds, row, stubBoard } from './filter-bar-fixtures'

test.describe.configure({ timeout: 120_000 })

const panelLeft = (page: Page) => page.locator('.todo-panel').first().evaluate((el) => el.getBoundingClientRect().left)
const activeLabel = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null
  return el?.getAttribute('aria-label') || el?.getAttribute('placeholder') || el?.innerText?.trim() || ''
})
const insideOf = (page: Page, sel: string) => page.evaluate((s) => !!document.activeElement?.closest(s), sel)

test('F04: Status values carry one selected signal; unselected Complete draws no tick', async ({ page }) => {
  await stubBoard(page, MIA, MIA_PINS)
  await openHome(page)
  await openFilterMenu(page)
  const status = filterDimRow(page, 'status')
  // No phase icons in the values: Need Action's and Complete's own ticks read as selection.
  await expect(status.locator('.fb-val-icon')).toHaveCount(0)
  const complete = filterValue(page, 'status', 'Complete')
  await expect(complete).toHaveAttribute('aria-pressed', 'false')
  await expect(complete.locator('svg')).toHaveCount(0)
  const todo = filterValue(page, 'status', 'To Do')
  await expect(todo).toHaveAttribute('aria-pressed', 'true')
  await expect(todo.locator('.fb-check svg')).toHaveCount(1)
  // Width stays the same when the tick appears (C47).
  const w0 = (await box(complete)).width
  await complete.click()
  await expect(complete).toHaveAttribute('aria-pressed', 'true')
  expect(Math.abs((await box(complete)).width - w0)).toBeLessThanOrEqual(1)
  // Unselected single-select values have no empty slot (F15): symmetric padding.
  const pad = await filterValue(page, 'date', 'Any date').evaluate((el) => {
    const cs = getComputedStyle(el); return [cs.paddingLeft, cs.paddingRight]
  })
  expect(pad[0]).toBe(pad[1])
})

test('F05: Collapse all projects only where the view draws project groups', async ({ page }) => {
  await stubBoard(page, ownerSeeds(), [], { tabBar: true })
  await openHome(page)
  await expect(row(page, 'fb-own-1')).toBeAttached({ timeout: 30_000 })
  await openDisplayMenu(page)
  const collapse = displayMenu(page).locator('[data-view-option="collapse"]')
  await expect(collapse).toHaveCount(1)
  // Inside the menu: the menu may follow its anchor, the row may not move within it.
  const sortY = async () => Math.round((await box(displayMenu(page).locator('[data-view-option="sort"]'))).y - (await box(displayMenu(page))).y)
  const y0 = await sortY()
  await displayMenu(page).locator('[data-view-option="pinned"]').click()
  await expect(collapse).toHaveCount(0)
  // Sort keeps its place and says why it is quiet here (C29b, F41).
  await expect(displayMenu(page).locator('[data-view-option="sort"]')).toContainText('Only in All and Projects')
  expect(Math.abs((await sortY()) - y0)).toBeLessThanOrEqual(1)
  await moreViewsRow(page).click()
  await viewsFlyout(page).locator('[data-view-option="recent"]').click()
  await expect(collapse).toHaveCount(0)
  await displayMenu(page).locator('[data-view-option="all"]').click()
  // All draws about 200 rows again; on a loaded machine that takes longer than 5s.
  await expect(collapse).toHaveCount(1, { timeout: 20_000 })
  // Order: Sort, Group, then Collapse (spec 3.3).
  const order = await displayMenu(page).locator('[data-view-option="sort"], [data-view-option="group"], [data-view-option="collapse"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-view-option')))
  expect(order).toEqual(['sort', 'group', 'collapse'])
})

test('F05: an empty board offers no Collapse all projects', async ({ page }) => {
  await stubBoard(page, [])
  await openHome(page)
  await openDisplayMenu(page)
  await expect(displayMenu(page).locator('[data-view-option="collapse"]')).toHaveCount(0)
})

test('F06 + C56: a search has one number for its rows: count = All badge = drawn hits; Include Complete brings every finished hit', async ({ page }) => {
  const seeds = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `fx-open-${i}`, title: `Lamp task ${i}`, project: 'Home' })),
    ...Array.from({ length: 7 }, (_, i) => ({ id: `fx-done-${i}`, title: `Lamp task done ${i}`, project: 'Home', phase: 'COMPLETE' })),
  ]
  await stubBoard(page, seeds, [], { tabBar: true })
  await openHome(page)
  await page.locator('.todo-panel-toolbar .todo-search-input').fill('Lamp task')
  const hits = page.locator('.todo-search-results .todo-panel-item[data-task-id]')
  await expect(hits.first()).toBeVisible({ timeout: 15_000 })
  const allBadge = page.locator('.todo-section-tabs [role="tab"]', { hasText: 'All' }).first().locator('.todo-section-tab-count')
  const count = page.getByTestId('filter-count')
  const agree = async () => {
    const n = await hits.count()
    await expect(count).toHaveText(`${n} ${n === 1 ? 'task' : 'tasks'}`)
    await expect(allBadge).toHaveText(String(n))
    return n
  }
  const before = await agree()
  expect(before).toBeLessThan(11)
  // F26: no chip, so the row does not claim filters it does not have.
  await expect(filterRow(page)).toContainText('Searching all tasks')
  const include = filterRow(page).getByRole('button', { name: /^Include Complete \(7\)/ })
  await expect(include).toBeVisible()
  await include.click()
  await expect(include).toHaveAttribute('aria-pressed', 'true')
  await expect(hits).toHaveCount(11)
  expect(await agree()).toBe(11)
})

test('F09: Tab and Shift+Tab stay inside an open Filter or Display popover', async ({ page }) => {
  await stubBoard(page, MIA, MIA_PINS)
  await openHome(page)
  await openFilterMenu(page)
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab')
    expect(await insideOf(page, '.fb-menu'), `Tab ${i + 1}: ${await activeLabel(page)}`).toBe(true)
  }
  await page.keyboard.press('Shift+Tab')
  expect(await insideOf(page, '.fb-menu')).toBe(true)
  await page.keyboard.press('Escape')
  await expect(filterMenu(page)).toHaveCount(0)
  await openDisplayMenu(page)
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    expect(await insideOf(page, '.dm-menu'), `Tab ${i + 1}: ${await activeLabel(page)}`).toBe(true)
  }
  // One Tab stop per Project value (F38): the add square is for the pointer.
  await page.keyboard.press('Escape')
  await openFilterMenu(page)
  await expect(filterDimRow(page, 'project').locator('.fb-val-add').first()).toHaveAttribute('tabindex', '-1')
})

test('F10 + F11 + F12 + F13: the search keeps room; popovers stay on the panel; flyouts sit beside their parent and never cover it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await stubBoard(page, ownerSeeds(), [], { tabBar: true })
  await openHome(page)
  await expect(row(page, 'fb-own-1')).toBeAttached({ timeout: 30_000 })
  const left = await panelLeft(page)
  // F10: at the default panel width the search field keeps room to read (it was 39px).
  expect((await box(page.locator('.todo-panel-toolbar .todo-search-input'))).width).toBeGreaterThanOrEqual(55)
  await openFilterMenu(page)
  const fm = await box(filterMenu(page))
  expect(fm.x).toBeGreaterThanOrEqual(left - 1)
  // `22 more` opens to the right of the popover, level with its chip.
  const more = filterDimRow(page, 'project').getByRole('button', { name: /^\d+ more$/ })
  const mb = await box(more)
  await more.click()
  await settled(valuesFlyout(page))
  const fly = await box(valuesFlyout(page))
  expect(fly.x).toBeGreaterThanOrEqual(fm.x + fm.width)
  expect(Math.abs(fly.y - mb.y)).toBeLessThanOrEqual(2)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await openDisplayMenu(page)
  const dm = await box(displayMenu(page))
  expect(dm.x).toBeGreaterThanOrEqual(left - 1)
  const rowBox = await box(moreViewsRow(page))
  await moreViewsRow(page).click()
  await settled(viewsFlyout(page))
  const vf = await box(viewsFlyout(page))
  expect(vf.x).toBeGreaterThanOrEqual(dm.x + dm.width)
  // The flyout's first row is level with More views (it used to sit about 48px lower).
  const firstItem = await box(viewsFlyout(page).locator('.dm-flyout-item').first())
  expect(Math.abs(firstItem.y - rowBox.y)).toBeLessThanOrEqual(4)
  // Tier views above a divider, Recent and Projects below it.
  const kinds = await viewsFlyout(page).locator('.dm-flyout-item, .dm-flyout-sep')
    .evaluateAll((els) => els.map((e) => e.classList.contains('dm-flyout-sep') ? '|' : e.getAttribute('data-view-option')))
  expect(kinds.indexOf('|')).toBe(kinds.indexOf('recent') - 1)
})

test('F22 + F36: a date from More dates is selected at once; the Projects view is named in the row', async ({ page }) => {
  await stubBoard(page, MIA, MIA_PINS, { tabBar: true })
  await openHome(page)
  await openFilterMenu(page)
  await filterDimRow(page, 'date').getByRole('button', { name: 'More dates' }).click()
  await valuesFlyout(page).locator('[data-filter-value="Overdue"]').click()
  await expect(filterValue(page, 'date', 'Overdue')).toHaveAttribute('aria-pressed', 'true')
  await closeFilterMenu(page)
  await expect(filterMenu(page)).toHaveCount(0)
  await openDisplayMenu(page)
  await moreViewsRow(page).click()
  await viewsFlyout(page).locator('[data-view-option="tasks"]').click()
  await page.keyboard.press('Escape')
  // No tab shows Projects, so the row names it.
  await expect(filterRow(page).locator('.fb-view-item')).toHaveText(/View:\s*Projects/)
})

test('F34: a popover opened while tasks load grows to its loaded height, and the board makes no empty verdict', async ({ page }) => {
  await stubBoard(page, ownerSeeds())
  // Later routes win: hold the task list back for 4s.
  await page.route('**/api/tasks?*', async (r) => {
    if (new URL(r.request().url()).pathname !== '/api/tasks') return r.fallback()
    await new Promise((res) => setTimeout(res, 4000))
    await r.fallback()
  })
  await openHome(page)
  await openFilterMenu(page)
  await expect(filterDimRow(page, 'project')).toContainText('Loading projects')
  await expect(page.getByTestId('todo-pinned-empty')).toHaveCount(0)
  const loadingH = (await box(filterMenu(page))).height
  await expect(filterDimRow(page, 'project').locator('.fb-val[data-filter-value]').first()).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await box(filterMenu(page))).height).toBeGreaterThan(loadingH)
  // The measured height is the drawn height: no stale cap from the loading frame.
  const [styleH, drawn] = await filterMenu(page).evaluate((el) => [parseFloat((el as HTMLElement).style.height), (el as HTMLElement).offsetHeight])
  expect(Math.abs(styleH - drawn)).toBeLessThanOrEqual(1)
})
