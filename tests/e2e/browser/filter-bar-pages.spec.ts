/**
 * The Filter menu's two pages on Mia's board (spec 6.2, 6.3): page one lists
 * the properties (and the picks made most), page two one property's values.
 * Moving between them by pointer and keys (ArrowDown/Up, ArrowRight, Enter,
 * Backspace, Back, Escape), the search box filtering page two, what a pick
 * does to the menu (a multi-select pick keeps it, a single-select pick closes
 * it), the footer, the `Most used` ranking, and the chip menus that share the
 * same rows. Stubbed board (filter-bar-fixtures.ts); prefs isolated per test.
 */
import { expect, test, type Locator } from '@playwright/test'
import {
  addFilter, closeFilterMenu, filterButton, filterChip, filterDimRow, filterMenu, filterPage, filterRow, filterSearch,
  filterValue, openFilterMenu, openFilterPage, removeFilterChip, setStatus,
} from './filter-bar-helpers'
import { MIA, MIA_PINS, box, openHome, row, stubBoard } from './filter-bar-fixtures'

test.describe.configure({ timeout: 120_000 })

const attrs = (l: Locator, name: string) => l.evaluateAll((els, n) => els.map((e) => e.getAttribute(n)), name)
const storedRecent = (page: Parameters<typeof filterMenu>[0]) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('walnut-todo-filter-recent') ?? '[]') as { dim: string; value: unknown; uses?: number }[])

test.beforeEach(async ({ page }) => {
  await stubBoard(page, MIA, MIA_PINS)
  await openHome(page)
  await expect(row(page, 'fb-mia-h2')).toBeVisible({ timeout: 20_000 })
})

test('keys: ArrowDown/Up walk the rows, ArrowRight and Enter open a page, Backspace and Back return, Escape clears then closes', async ({ page }) => {
  await openFilterMenu(page)
  const search = filterSearch(page)
  await expect(search).toBeFocused()
  // ArrowDown from the search box reaches the first row; ArrowUp off the first row goes back up.
  await search.press('ArrowDown')
  await expect(filterDimRow(page, 'status')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(filterDimRow(page, 'project')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(filterDimRow(page, 'status')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(search).toBeFocused()
  // ArrowRight on a property row opens its page, titled with the property, the search box renamed.
  await search.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowRight')
  await expect(filterMenu(page)).toHaveAttribute('data-page', 'project')
  const head = filterPage(page, 'project').locator('.fb-page-head')
  await expect(head.locator('.fb-page-title')).toHaveText('Project')
  await expect(head.locator('.fb-page-reset')).toHaveCount(0)
  await expect(search).toHaveAttribute('placeholder', 'Search projects')
  // Two projects: nothing to search, so the first row takes focus; the arrows walk the rows.
  await expect(filterValue(page, 'project', 'Garden')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(filterValue(page, 'project', 'Home')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(filterValue(page, 'project', 'Garden')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(search).toBeFocused()
  // Backspace in the empty search box goes back; focus returns to the row that opened the page.
  await page.keyboard.press('Backspace')
  await expect(filterMenu(page)).toHaveAttribute('data-page', 'home')
  await expect(filterDimRow(page, 'project')).toBeFocused()
  await expect(search).toHaveAttribute('placeholder', 'Search filters')
  // Enter on a focused property row opens it too; the Back button returns.
  await page.keyboard.press('ArrowDown')
  await expect(filterDimRow(page, 'date')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(filterPage(page, 'date')).toBeVisible()
  await expect(filterValue(page, 'date', 'Available now')).toBeFocused()
  await filterMenu(page).getByRole('button', { name: 'Back to all filters' }).click()
  await expect(filterMenu(page)).toHaveAttribute('data-page', 'home')
  await expect(filterDimRow(page, 'date')).toBeFocused()
  // Typing on page two filters its rows; Backspace with text left only deletes.
  await openFilterPage(page, 'status')
  await search.fill('progress')
  await expect(filterPage(page, 'status').locator('.fb-opt-label')).toHaveText(['In Progress'])
  await search.fill('xyz')
  await expect(filterPage(page, 'status').locator('.fb-empty')).toHaveText('No match for "xyz"')
  await page.keyboard.press('Backspace')
  await expect(search).toHaveValue('xy')
  await expect(filterMenu(page)).toHaveAttribute('data-page', 'status')
  // Escape clears the text first and stays on the page, then closes the menu.
  await page.keyboard.press('Escape')
  await expect(search).toHaveValue('')
  await expect(filterMenu(page)).toHaveAttribute('data-page', 'status')
  await expect(filterPage(page, 'status').locator('.fb-opt-body')).toHaveCount(5)
  await page.keyboard.press('Escape')
  await expect(filterMenu(page)).toHaveCount(0)
  await expect(filterButton(page)).toBeFocused()
  // Every open starts on page one.
  await filterButton(page).click()
  await expect(filterMenu(page)).toHaveAttribute('data-page', 'home')
})

test('Enter in the search box picks the first row; a multi-select pick keeps the menu; open Filter is grey, never the accent; outside click closes', async ({ page }) => {
  await openFilterPage(page, 'project')
  await filterSearch(page).fill('hom')
  await expect(filterPage(page, 'project').locator('.fb-opt-body')).toHaveCount(1)
  await filterSearch(page).press('Enter')
  await expect(filterChip(page, 'project')).toContainText('Home')
  await expect(filterMenu(page)).toHaveAttribute('data-page', 'project')
  await expect(filterValue(page, 'project', 'Home')).toHaveAttribute('aria-pressed', 'true')
  // The property is set: Reset appears in the page head.
  await expect(filterPage(page, 'project').locator('.fb-page-head .fb-page-reset')).toHaveText('Reset')
  // The Filter button: is-active with its badge; while open, a grey fill and a hairline.
  await expect(filterButton(page)).toHaveClass(/is-active/)
  await expect(filterButton(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(filterButton(page).locator('.tp-badge[data-testid="filter-badge"]')).toHaveText('1')
  const look = await filterButton(page).evaluate((el) => {
    const probe = document.createElement('div')
    probe.style.background = 'var(--accent)'
    document.body.appendChild(probe)
    const accent = getComputedStyle(probe).backgroundColor
    probe.remove()
    const cs = getComputedStyle(el)
    return { bg: cs.backgroundColor, shadow: cs.boxShadow, accent }
  })
  expect(look.bg).not.toBe(look.accent)
  expect(look.bg).not.toBe('rgba(0, 0, 0, 0)')
  expect(look.shadow).toContain('inset')
  // A press outside closes the menu; the chip stays.
  const vp = page.viewportSize()!
  await page.mouse.click(vp.width - 4, vp.height - 4)
  await expect(filterMenu(page)).toHaveCount(0)
  await expect(filterChip(page, 'project')).toBeVisible()
})

test('single-select picks close the menu and return focus; Time presets keep their page with the basis; Reset and Clear filters', async ({ page }) => {
  await openFilterPage(page, 'blocked')
  await expect(filterPage(page, 'blocked').locator('.fb-check-box, .fb-only')).toHaveCount(0)
  await filterValue(page, 'blocked', 'Blocked').click()
  await expect(filterMenu(page)).toHaveCount(0)
  await expect(filterButton(page)).toBeFocused()
  await expect(filterChip(page, 'blocked').locator('.fb-chip-body')).toHaveText('Blocked')
  await openFilterPage(page, 'time')
  const time = filterPage(page, 'time')
  await expect(time.locator('.fb-page-sub [data-time-basis][role="radio"]')).toHaveCount(3)
  await filterValue(page, 'time', '7d').click()
  await expect(filterMenu(page)).toHaveAttribute('data-page', 'time')
  await expect(filterValue(page, 'time', '7d')).toHaveAttribute('aria-pressed', 'true')
  await expect(filterChip(page, 'time').locator('.fb-chip-body')).toHaveText('Updated in 7d')
  await time.locator('[data-time-basis="created"]').click()
  await expect(filterChip(page, 'time').locator('.fb-chip-body')).toHaveText('Created in 7d')
  await expect(time.locator('.fb-custom-time')).toHaveCount(0)
  await filterValue(page, 'time', 'Custom').click()
  await expect(time.locator('.fb-custom-time')).toBeVisible()
  await expect(filterMenu(page)).toHaveAttribute('data-page', 'time')
  // Reset puts this one property back and leaves the others.
  await time.getByRole('button', { name: 'Reset' }).click()
  await expect(filterChip(page, 'time')).toHaveCount(0)
  await expect(filterChip(page, 'blocked')).toHaveCount(1)
  await expect(time.locator('.fb-page-reset, .fb-custom-time')).toHaveCount(0)
  // The footer's Clear filters clears everything and keeps the menu open on the search box.
  await openFilterMenu(page)
  const foot = filterMenu(page).locator('.fb-menu-foot')
  await expect(foot.locator('.fb-menu-count')).toHaveText(/^\d+ tasks?$/)
  await foot.getByRole('button', { name: 'Clear filters' }).click()
  await expect(filterRow(page).locator('.fb-chip')).toHaveCount(0)
  await expect(foot).toHaveCount(0)
  await expect(filterMenu(page)).toBeVisible()
  await expect(filterSearch(page)).toBeFocused()
})

test('a short page focuses its first selected row', async ({ page }) => {
  await setStatus(page, ['Waiting'])
  await openFilterPage(page, 'status')
  await expect(filterValue(page, 'status', 'Waiting')).toBeFocused()
  await closeFilterMenu(page)
  await addFilter(page, 'date', 'No dates')
  await openFilterPage(page, 'date')
  await expect(filterValue(page, 'date', 'No dates')).toBeFocused()
})

test('Most used: a pick made twice ranks first after newer picks; ties newest first; a click toggles it', async ({ page }) => {
  await openFilterMenu(page)
  await expect(filterMenu(page).locator('[data-section="most-used"], .fb-group-title')).toHaveCount(0)
  await closeFilterMenu(page)
  // Garden twice (in two menu opens), then Home, then Overdue: each pick closes and is removed.
  for (const name of ['Garden', 'Garden', 'Home']) {
    await addFilter(page, 'project', name)
    await removeFilterChip(page, 'project')
  }
  await addFilter(page, 'date', 'Overdue')
  await removeFilterChip(page, 'date')
  expect(await storedRecent(page)).toEqual([
    { dim: 'date', value: 'overdue' },
    { dim: 'project', value: 'Home' },
    { dim: 'project', value: 'Garden', uses: 2 },
  ])
  await openFilterMenu(page)
  const group = filterMenu(page).locator('.fb-group[data-section="most-used"]')
  await expect(group.locator('.fb-group-title')).toHaveText('Most used')
  await expect(filterMenu(page).locator('.fb-group[data-section="properties"] .fb-group-title')).toHaveText('Filter by')
  const quick = group.locator('.fb-item.fb-quick')
  await expect(quick).toHaveCount(3)
  expect(await attrs(quick, 'data-filter-value')).toEqual(['Project: Garden', 'Date: Overdue', 'Project: Home'])
  expect(await attrs(quick, 'data-recent-dim')).toEqual(['project', 'date', 'project'])
  // Most used sits above the properties.
  expect((await box(quick.first())).y).toBeLessThan((await box(filterDimRow(page, 'status'))).y)
  const garden = quick.first()
  await expect(garden).toHaveAttribute('aria-pressed', 'false')
  await garden.click()
  await expect(garden).toHaveAttribute('aria-pressed', 'true')
  await expect(filterChip(page, 'project').locator('.fb-chip-val')).toHaveText('Garden')
  await expect(filterMenu(page)).toBeVisible()
  await garden.click()
  await expect(garden).toHaveAttribute('aria-pressed', 'false')
  await expect(filterChip(page, 'project')).toHaveCount(0)
  // Its own click counted: Garden has three uses now and still leads.
  expect((await storedRecent(page)).find((e) => e.value === 'Garden')?.uses).toBe(3)
  await closeFilterMenu(page)
  await openFilterMenu(page)
  await expect(quick.first()).toHaveAttribute('data-filter-value', 'Project: Garden')
})

test('chip menu: plain clicks toggle; it stays open over the Filter menu; the last status stays on; removing the last value closes it', async ({ page }) => {
  await addFilter(page, 'project', 'Garden')
  const val = filterChip(page, 'project').locator('.fb-chip-val')
  await filterChip(page, 'project').locator('.fb-chip-body').click()
  const cm = page.locator('.fb-chip-menu[data-chip-menu-dim="project"]')
  await expect(cm).toBeVisible()
  // Two values: no search box; the selected row takes focus.
  await expect(cm.getByRole('textbox')).toHaveCount(0)
  await expect(cm.locator('.fb-opt-body[data-filter-value="Garden"]')).toBeFocused()
  await cm.locator('.fb-opt-body[data-filter-value="Home"]').click()
  await expect(val).toHaveText('Garden, Home')
  await expect(cm.locator('.fb-opt-body[data-filter-value="Home"]')).toHaveAttribute('aria-pressed', 'true')
  await cm.locator('.fb-opt-body[data-filter-value="Garden"]').click()
  await expect(val).toHaveText('Home')
  await expect(cm).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(cm).toHaveCount(0)
  await expect(filterChip(page, 'project').locator('.fb-chip-body')).toBeFocused()
  // With the Filter menu open, a chip menu opens over it; a press inside keeps both; Escape takes the top one.
  await openFilterMenu(page)
  await filterChip(page, 'project').locator('.fb-chip-body').click()
  await expect(cm).toBeVisible()
  await cm.locator('.fb-opt-body[data-filter-value="Garden"]').click()
  await expect(val).toHaveText('Home, Garden')
  await expect(filterMenu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(cm).toHaveCount(0)
  await expect(filterMenu(page)).toBeVisible()
  await closeFilterMenu(page)
  // Status: the last value is locked here too; Only keeps one value.
  await setStatus(page, ['Waiting'])
  await filterChip(page, 'status').locator('.fb-chip-body').click()
  const sm = page.locator('.fb-chip-menu[data-chip-menu-dim="status"]')
  const waiting = sm.locator('.fb-opt-body[data-filter-value="Waiting"]')
  await expect(waiting).toHaveAttribute('aria-disabled', 'true')
  await expect(waiting).toBeFocused()
  await sm.locator('.fb-opt-body[data-filter-value="To Do"]').click()
  await expect(filterChip(page, 'status').locator('.fb-chip-val')).toHaveText('To Do, Waiting')
  const todoRow = sm.locator('.fb-opt').filter({ has: page.locator('[data-filter-value="To Do"]') })
  await todoRow.hover()
  await todoRow.getByRole('button', { name: 'Only To Do' }).click()
  await expect(filterChip(page, 'status').locator('.fb-chip-val')).toHaveText('To Do')
  await page.keyboard.press('Escape')
  await expect(sm).toHaveCount(0)
  // Unticking a chip's last value removes the chip, and its menu goes with it.
  await filterChip(page, 'project').locator('.fb-chip-body').click()
  await cm.locator('.fb-opt-body[data-filter-value="Home"]').click()
  await cm.locator('.fb-opt-body[data-filter-value="Garden"]').click()
  await expect(filterChip(page, 'project')).toHaveCount(0)
  await expect(cm).toHaveCount(0)
})
