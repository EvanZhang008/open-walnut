/**
 * E2E: the Filter bar fix round (nitpicks F04, F05, F06, F09, F11 to F13, F22,
 * F26, F34, F36), on the one panel menu under Display. One selected signal on
 * Status values, Collapse all only where it folds something, one number for a
 * search, focus kept inside the open menu, the menu on the task panel and page
 * two (a property or the View page) replacing page one in place, a date pick
 * selected at once, a menu as tall as its content, and the active view always named.
 * Stubbed boards (filter-bar-fixtures.ts); prefs isolated per test.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  chooseDisplayOption, closeFilterMenu, displayMenu, filterChip, filterDimRow, filterMenu, filterPage, filterRow, filterValue,
  openDisplayMenu, openFilterMenu, openFilterPage, openViewsPage, settled, viewRow, viewsPage,
} from './filter-bar-helpers'
import { MIA, MIA_PINS, box, openHome, ownerSeeds, row, stubBoard } from './filter-bar-fixtures'

test.describe.configure({ timeout: 120_000 })

const panelLeft = (page: Page) => page.locator('.todo-panel').first().evaluate((el) => el.getBoundingClientRect().left)
const activeLabel = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null
  return el?.getAttribute('aria-label') || el?.getAttribute('placeholder') || el?.innerText?.trim() || ''
})
const insideOf = (page: Page, sel: string) => page.evaluate((s) => !!document.activeElement?.closest(s), sel)
const labelX = async (l: Locator) => (await box(l.locator('.fb-opt-label'))).x

test('F04 + F15: Status rows carry one selected signal; single-select rows keep the tick slot, so names line up', async ({ page }) => {
  await stubBoard(page, MIA, MIA_PINS)
  await openHome(page)
  await openFilterPage(page, 'status')
  const status = filterPage(page, 'status')
  // No phase icons in the rows: the square is the one selected signal.
  await expect(status.locator('.fb-val-icon, .fb-item-icon')).toHaveCount(0)
  const complete = filterValue(page, 'status', 'Complete')
  await expect(complete).toHaveAttribute('aria-pressed', 'false')
  await expect(complete.locator('svg')).toHaveCount(0)
  await expect(complete.locator('.fb-check.fb-check-box')).toHaveCount(1)
  const todo = filterValue(page, 'status', 'To Do')
  await expect(todo).toHaveAttribute('aria-pressed', 'true')
  await expect(todo.locator('.fb-check svg')).toHaveCount(1)
  await expect(todo.locator('svg')).toHaveCount(1)
  // Width and the label's place stay the same when the tick appears (C47).
  const w0 = (await box(complete)).width
  const x0 = await labelX(complete)
  await complete.click()
  await expect(complete).toHaveAttribute('aria-pressed', 'true')
  expect(Math.abs((await box(complete)).width - w0)).toBeLessThanOrEqual(1)
  expect(Math.abs((await labelX(complete)) - x0)).toBeLessThanOrEqual(1)
  // Date rows are single-select: a bare tick slot the same width as the square, symmetric padding.
  await openFilterPage(page, 'date')
  const anyDate = filterValue(page, 'date', 'Any date')
  await expect(anyDate.locator('.fb-check')).toHaveCount(1)
  await expect(anyDate.locator('.fb-check-box')).toHaveCount(0)
  await expect(anyDate.locator('svg')).toHaveCount(0)
  const pad = await anyDate.evaluate((el) => { const cs = getComputedStyle(el); return [cs.paddingLeft, cs.paddingRight] })
  expect(pad[0]).toBe(pad[1])
  expect(Math.abs((await labelX(anyDate)) - x0)).toBeLessThanOrEqual(1)
  expect(Math.abs((await labelX(filterValue(page, 'date', 'Available now'))) - x0)).toBeLessThanOrEqual(1)
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
  // A view pick on the View page closes the menu; the next open shows that view's rows.
  await chooseDisplayOption(page, 'pinned')
  await expect(displayMenu(page)).toHaveCount(0)
  await openDisplayMenu(page)
  await expect(collapse).toHaveCount(0)
  // Sort keeps its place and says why it is quiet here (C29b, F41).
  await expect(displayMenu(page).locator('[data-view-option="sort"]')).toContainText('Only in All and Projects')
  expect(Math.abs((await sortY()) - y0)).toBeLessThanOrEqual(1)
  await chooseDisplayOption(page, 'recent')
  await openDisplayMenu(page)
  await expect(collapse).toHaveCount(0)
  await chooseDisplayOption(page, 'all')
  await openDisplayMenu(page)
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

test('F09 + F38: Tab and Shift+Tab stay inside the open menu (page one, a property page, the View page); one Tab stop per value', async ({ page }) => {
  await stubBoard(page, MIA, MIA_PINS)
  await openHome(page)
  await openFilterMenu(page)
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab')
    expect(await insideOf(page, '.fb-menu'), `Tab ${i + 1}: ${await activeLabel(page)}`).toBe(true)
  }
  await page.keyboard.press('Shift+Tab')
  expect(await insideOf(page, '.fb-menu')).toBe(true)
  // Page two traps Tab too.
  await openFilterPage(page, 'project')
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab')
    expect(await insideOf(page, '.fb-menu'), `page two, Tab ${i + 1}: ${await activeLabel(page)}`).toBe(true)
  }
  // F38: Only is for the pointer; the row itself is the one Tab stop per value.
  await expect(filterPage(page, 'project').locator('.fb-only').first()).toHaveAttribute('tabindex', '-1')
  await expect(filterPage(page, 'project').locator('[role="checkbox"], .fb-val-add')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(filterMenu(page)).toHaveCount(0)
  // The View page traps Tab too.
  await openViewsPage(page)
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    expect(await insideOf(page, '.fb-menu'), `View page, Tab ${i + 1}: ${await activeLabel(page)}`).toBe(true)
  }
})

test('F10 + F11 + F12 + F13: the search keeps room; the menu stays on the panel; a property page and the View page open in place', async ({ page }) => {
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
  // A property's values replace page one in the same box: same place, same width, nothing beside it.
  await openFilterPage(page, 'project')
  await settled(filterMenu(page))
  const fp = await box(filterMenu(page))
  expect(Math.abs(fp.x - fm.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(fp.y - fm.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(fp.width - fm.width)).toBeLessThanOrEqual(1)
  await expect(page.locator('.fb-values-flyout')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(filterMenu(page)).toHaveCount(0)
  await openDisplayMenu(page)
  const dm = await box(displayMenu(page))
  expect(dm.x).toBeGreaterThanOrEqual(left - 1)
  // The View row opens the views in the same box, like a property: no flyout beside it.
  await viewRow(page).click()
  await expect(viewsPage(page)).toBeVisible()
  await settled(displayMenu(page))
  const vp = await box(displayMenu(page))
  expect(Math.abs(vp.x - dm.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(vp.y - dm.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(vp.width - dm.width)).toBeLessThanOrEqual(1)
  await expect(displayMenu(page)).toHaveAttribute('data-page', 'view')
  await expect(page.locator('.dm-views-flyout')).toHaveCount(0)
  // The tabs kept on the bar above a hairline, every other view below it, Projects last.
  const kinds = await viewsPage(page).locator('.dm-view, .dm-flyout-sep')
    .evaluateAll((els) => els.map((e) => e.classList.contains('dm-flyout-sep') ? '|' : e.getAttribute('data-view-option')))
  expect(kinds).toEqual(['all', 'pinned', '|', 'focus', 'satellite', 'wait', 'recent', 'tasks'])
})

test('F22 + F36: a date pick is selected at once and closes the menu; the Projects view is named in the row', async ({ page }) => {
  await stubBoard(page, MIA, MIA_PINS, { tabBar: true })
  await openHome(page)
  await openFilterPage(page, 'date')
  await filterValue(page, 'date', 'Overdue').click()
  await expect(filterMenu(page)).toHaveCount(0)
  await expect(filterChip(page, 'date')).toContainText('Date: Overdue')
  await openFilterPage(page, 'date')
  await expect(filterValue(page, 'date', 'Overdue')).toHaveAttribute('aria-pressed', 'true')
  await expect(filterValue(page, 'date', 'Available now')).toHaveAttribute('aria-pressed', 'false')
  await closeFilterMenu(page)
  await expect(filterMenu(page)).toHaveCount(0)
  await chooseDisplayOption(page, 'tasks')
  await expect(filterMenu(page)).toHaveCount(0)
  // No tab shows Projects, so the row names it.
  await expect(filterRow(page).locator('.fb-view-item')).toHaveText(/View:\s*Projects/)
})

test('F34: a menu opened while tasks load grows to its loaded content, has no measured height, and the board makes no empty verdict', async ({ page }) => {
  await stubBoard(page, ownerSeeds())
  // Later routes win: hold the task list back for 4s.
  await page.route('**/api/tasks?*', async (r) => {
    if (new URL(r.request().url()).pathname !== '/api/tasks') return r.fallback()
    await new Promise((res) => setTimeout(res, 4000))
    await r.fallback()
  })
  await openHome(page)
  await openFilterMenu(page)
  await expect(filterDimRow(page, 'project').locator('.fb-prop-summary')).toHaveText('Loading')
  await expect(page.getByTestId('todo-pinned-empty')).toHaveCount(0)
  const loadingH = (await box(filterMenu(page))).height
  await expect(filterDimRow(page, 'project').locator('.fb-prop-summary')).toHaveText('Any', { timeout: 20_000 })
  // The page is listed again once the tasks arrive: two sources bring the Source row.
  await expect(filterDimRow(page, 'source')).toBeVisible()
  await expect.poll(async () => (await box(filterMenu(page))).height).toBeGreaterThan(loadingH)
  // No fixed height from any frame: the box is its content, under a cap.
  const shape = await filterMenu(page).evaluate((el) => ({
    height: (el as HTMLElement).style.height,
    max: parseFloat((el as HTMLElement).style.maxHeight),
    measuring: el.hasAttribute('data-measuring'),
    fits: el.scrollHeight <= el.clientHeight + 1,
  }))
  expect(shape).toMatchObject({ height: '', measuring: false, fits: true })
  expect(shape.max).toBeLessThanOrEqual(520)
  // Thirty projects reach the cap: the box stops there and its body scrolls.
  await openFilterPage(page, 'project')
  await settled(filterMenu(page))
  const capped = await filterMenu(page).evaluate((el) => {
    const body = el.querySelector('.fb-menu-body') as HTMLElement
    return { h: (el as HTMLElement).offsetHeight, max: parseFloat((el as HTMLElement).style.maxHeight), scrolls: body.scrollHeight > body.clientHeight + 1 }
  })
  expect(capped.h).toBeLessThanOrEqual(capped.max + 1)
  expect(capped.scrolls).toBe(true)
})
