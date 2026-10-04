/**
 * The home task panel's one toolbar button (Display), its menu and the filter
 * row on Mia's first-week board (spec 2.1, 6.1 to 6.4): Home 3 + Garden 2 open,
 * one Garden task complete, two pins. The menu has two pages: page one lists
 * the properties with their values, then the display rows (Sort, Group, View,
 * Show tab bar, Session columns); page two one property's values as a
 * checklist, or the views. Also the two themes and the view item. The dense board lives in
 * filter-bar-dense.spec.ts, page navigation and keys in filter-bar-pages.spec.ts.
 * Every test answers the board reads for its own page (filter-bar-fixtures.ts
 * `stubBoard`); nothing is written to the fixture server, and isolateUiPrefs
 * keeps the filter keys per context.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator } from '@playwright/test'
import {
  addFilter, chooseDisplayOption, closeFilterMenu, expandMoreFilters, filterButton, filterChip, filterDimRow, filterMenu, filterPage,
  filterRow, filterSearch, filterValue, openDisplayMenu, openFilterMenu, openFilterPage, openViewsPage, removeFilterChip, setStatus,
} from './filter-bar-helpers'
import {
  MIA, MIA_PINS, SHOTS, badge, box, clipAround, contrastOf, focusedLabel, listIds, openHome, ownerSeeds, row, settled, stubBoard,
} from './filter-bar-fixtures'

// Dense boards and many menu round trips: a busy machine needs more than 30s.
test.describe.configure({ timeout: 120_000 })

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

const OPEN_STATUS = [['To Do', 'true'], ['In Progress', 'true'], ['Need Action', 'true'], ['Waiting', 'false'], ['Complete', 'false']] as const
const shownDims = (l: Locator) => l.locator('.fb-home[data-section="filters"] > .fb-prop')
  .evaluateAll((els) => els.map((e) => e.getAttribute('data-filter-dim')))
const summary = (page: Parameters<typeof filterDimRow>[0], dim: Parameters<typeof filterDimRow>[1]) => filterDimRow(page, dim).locator('.fb-prop-summary')
/** The Filter title's Clear, there only while a filter is set. */
const clearInTitle = (page: Parameters<typeof filterMenu>[0]) => filterMenu(page).locator('.fb-home .fb-group-title .fb-group-action')

test.describe('Mia: first week', () => {
  test.beforeEach(async ({ page }) => {
    await stubBoard(page, MIA, MIA_PINS)
    await openHome(page)
    await expect(row(page, 'fb-mia-h2')).toBeVisible({ timeout: 20_000 })
  })

  test('S1 + S3 + C3 + C5 + C55: one click narrows to Garden; the row sits above the menu', async ({ page }) => {
    // C3: default state has no row, no badge; page one reads every default.
    await expect(filterRow(page)).toHaveCount(0)
    await expect(badge(page)).toHaveCount(0)
    await expect(filterButton(page)).toHaveAttribute('title', 'Display: sort, group, layout')
    await openFilterMenu(page)
    await expect(filterSearch(page)).toBeFocused()
    await expect(filterMenu(page)).toHaveAttribute('data-page', 'home')
    await expect(filterSearch(page)).toHaveAttribute('placeholder', 'Search filters and views')
    await expect(filterMenu(page).locator('.fb-home .fb-group-title > span')).toHaveText('Filter')
    // One source, so no Source row (C34).
    expect(await shownDims(filterMenu(page))).toEqual(['status', 'project', 'date'])
    for (const [dim, text] of [['status', 'Open'], ['project', 'Any'], ['date', 'Available now']] as const) {
      await expect(summary(page, dim)).toHaveText(text)
      await expect(summary(page, dim)).toHaveClass(/is-default/)
    }
    // Nothing set: nothing to clear.
    await expect(clearInTitle(page)).toHaveCount(0)
    // C55: the row is there with its placeholder; the menu hangs under it, right edges aligned.
    await expect(filterRow(page)).toContainText('No filters yet')
    await settled(filterMenu(page))
    const rowBefore = await box(filterRow(page))
    const menu = await box(filterMenu(page))
    const btn = await box(filterButton(page))
    // One width for every page: 320px, or the viewport less a margin.
    expect(Math.round(menu.width)).toBe(Math.min(320, page.viewportSize()!.width - 16))
    expect(menu.y).toBeGreaterThanOrEqual(rowBefore.y + rowBefore.height - 1)
    // Right edges align when the menu fits on the panel left of the button's right edge;
    // else its left edge is clamped to the panel's left edge (F11).
    const panelLeft = await page.locator('.todo-panel').first().evaluate((el) => el.getBoundingClientRect().left)
    const btnRight = btn.x + btn.width
    if (btnRight - menu.width >= panelLeft) expect(Math.abs(menu.x + menu.width - btnRight)).toBeLessThanOrEqual(2)
    else expect(Math.abs(menu.x - Math.max(panelLeft, 8))).toBeLessThanOrEqual(2)
    // C3 on page two: the three open statuses ticked, Available now picked.
    await openFilterPage(page, 'status')
    for (const [label, on] of OPEN_STATUS) await expect(filterValue(page, 'status', label)).toHaveAttribute('aria-pressed', on)
    await openFilterPage(page, 'date')
    await expect(filterValue(page, 'date', 'Available now')).toHaveAttribute('aria-pressed', 'true')
    // C5: one click on Garden, same poll: chip, badge, list, menu still open on its page.
    await openFilterPage(page, 'project')
    const pageBox = await box(filterMenu(page))
    expect(Math.abs(pageBox.x - menu.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(pageBox.y - menu.y)).toBeLessThanOrEqual(1)
    await filterValue(page, 'project', 'Garden').click()
    await expect(filterChip(page, 'project')).toContainText('Garden')
    await expect(badge(page)).toHaveText('1')
    await expect(filterValue(page, 'project', 'Garden')).toHaveAttribute('aria-pressed', 'true')
    await expect(filterMenu(page)).toHaveAttribute('data-page', 'project')
    await expect(row(page, 'fb-mia-g2')).toBeVisible()
    expect((await listIds(page)).every((id) => id?.startsWith('fb-mia-g'))).toBe(true)
    await expect(page.locator('.todo-panel [data-task-id^="fb-mia-h"]')).toHaveCount(0)
    await expect(page.getByTestId('filter-count')).toHaveText('2 tasks')
    const rowAfter = await box(filterRow(page))
    expect(Math.abs(rowAfter.y - rowBefore.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(rowAfter.height - rowBefore.height)).toBeLessThanOrEqual(1)
    const chipBox = await box(filterChip(page, 'project'))
    const menuNow = await box(filterMenu(page))
    expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(menuNow.y + 1)
    // Page one says what is set in its rows (no summary line, no footer); Clear sits in the Filter title.
    await filterMenu(page).getByRole('button', { name: 'Back to all filters' }).click()
    await expect(summary(page, 'project')).toHaveText('Garden')
    await expect(summary(page, 'project')).not.toHaveClass(/is-default/)
    await expect(filterMenu(page).locator('.fb-menu-summary, .fb-menu-foot, .fb-menu-count')).toHaveCount(0)
    await expect(clearInTitle(page)).toHaveText('Clear')
    await expect(filterButton(page)).toHaveAttribute('title', 'Display: 1 active filter, sort, group, layout')
    await page.screenshot({ path: `${SHOTS}/filter-menu-light.png`, clip: await clipAround(page) })
    // Escape closes; the row stays.
    await page.keyboard.press('Escape')
    await expect(filterMenu(page)).toHaveCount(0)
    await expect(filterButton(page)).toBeFocused()
    await expect(filterChip(page, 'project')).toBeVisible()
  })
})

test.describe('Mia: removing and clearing', () => {
  test.beforeEach(async ({ page }) => {
    await stubBoard(page, MIA, MIA_PINS, { tabBar: true })
    await openHome(page)
    await expect(row(page, 'fb-mia-h2')).toBeVisible({ timeout: 20_000 })
  })

  test('S2 + C6 + C63: pointer removal holds the row until the pointer leaves, then focus is on Display', async ({ page }) => {
    await addFilter(page, 'project', 'Garden')
    const tabs = page.locator('.todo-section-tabs').first()
    const tabsY = (await box(tabs)).y
    const x = filterChip(page, 'project').locator('.fb-chip-x')
    const xBox = await box(x)
    await page.mouse.click(xBox.x + xBox.width / 2, xBox.y + xBox.height / 2)
    await expect(filterChip(page, 'project')).toHaveCount(0)
    await expect(filterRow(page)).toContainText('No filters')
    expect(await focusedLabel(page)).toBe('Display')
    expect(Math.abs((await box(tabs)).y - tabsY)).toBeLessThanOrEqual(1)
    const selected = await page.locator('.todo-section-tabs [role="tab"][aria-selected="true"]').textContent()
    await page.mouse.click(xBox.x + xBox.width / 2, xBox.y + xBox.height / 2)
    expect(await page.locator('.todo-section-tabs [role="tab"][aria-selected="true"]').textContent()).toBe(selected)
    await expect(badge(page)).toHaveCount(0)
    await page.mouse.move(2, 2)
    await expect(filterRow(page)).toHaveCount(0, { timeout: 1_000 })
    await expect(row(page, 'fb-mia-h2')).toBeVisible()
  })

  test('C6 + C32: keyboard reaches body, x and Clear; Backspace removes at once and focus walks next, previous, Display', async ({ page, browserName }) => {
    // WebKit tabs through buttons only with Option held (the Safari default).
    const TAB = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'
    await addFilter(page, 'project', 'Garden')
    await addFilter(page, 'date', 'Any date')
    await expect(filterRow(page).locator('.fb-chip')).toHaveCount(2)
    await filterChip(page, 'project').locator('.fb-chip-body').focus()
    await page.keyboard.press(TAB)
    expect(await focusedLabel(page)).toBe('Remove Project filter')
    await page.keyboard.press(TAB)
    expect(await focusedLabel(page)).toBe('Date: Any date, change')
    await page.keyboard.press(TAB)
    await page.keyboard.press(TAB)
    expect(await focusedLabel(page)).toBe('Clear all filters')
    await filterChip(page, 'project').locator('.fb-chip-body').focus()
    await page.keyboard.press('Backspace')
    await expect(filterChip(page, 'project')).toHaveCount(0)
    expect(await focusedLabel(page)).toBe('Remove Date filter')
    await page.keyboard.press('Delete')
    await expect(filterRow(page)).toHaveCount(0)
    await expect(badge(page)).toHaveCount(0)
    expect(await focusedLabel(page)).toBe('Display')
  })

  test('C7: Clear puts every property back, keeps Sort, and the row goes', async ({ page }) => {
    const sortBefore = await page.evaluate(() => localStorage.getItem('walnut-todo-sortBy'))
    await addFilter(page, 'project', 'Garden')
    await setStatus(page, ['To Do', 'Waiting'])
    await addFilter(page, 'date', 'Overdue')
    await expect(filterRow(page).locator('.fb-chip')).toHaveCount(3)
    await filterRow(page).getByRole('button', { name: 'Clear all filters' }).click()
    await expect(filterRow(page)).toHaveCount(0)
    expect(await focusedLabel(page)).toBe('Display')
    expect(await page.evaluate(() => localStorage.getItem('walnut-todo-sortBy'))).toBe(sortBefore)
    await openFilterMenu(page)
    for (const [dim, text] of [['status', 'Open'], ['project', 'Any'], ['date', 'Available now']] as const) {
      await expect(summary(page, dim)).toHaveText(text)
      await expect(summary(page, dim)).toHaveClass(/is-default/)
    }
    await expect(clearInTitle(page)).toHaveCount(0)
    await openFilterPage(page, 'status')
    for (const [label, on] of OPEN_STATUS) await expect(filterValue(page, 'status', label)).toHaveAttribute('aria-pressed', on)
    await openFilterPage(page, 'date')
    await expect(filterValue(page, 'date', 'Available now')).toHaveAttribute('aria-pressed', 'true')
    await openFilterPage(page, 'project')
    await expect(filterValue(page, 'project', 'Garden')).toHaveAttribute('aria-pressed', 'false')
  })

  test('C11 + C12 + C13 + C13b + C50: last status stays on; no native checkbox; plain words with titles on both pages', async ({ page }) => {
    await setStatus(page, ['Complete'], { keepOpen: true })
    const complete = filterValue(page, 'status', 'Complete')
    await expect(complete).toHaveAttribute('aria-disabled', 'true')
    await expect(complete).toHaveAttribute('title', 'At least one status stays on')
    await expect(filterPage(page, 'status').getByRole('button', { name: 'Only Complete' })).toHaveCount(0)
    await complete.click({ force: true })
    await expect(complete).toHaveAttribute('aria-pressed', 'true')
    await expect(filterChip(page, 'status')).toContainText('Complete')
    expect(await page.locator('.fb-menu input[type="checkbox"], .fb-menu select').count()).toBe(0)
    // C50: the status words, in order (the Open row over its three), each with a title that names no tier.
    await expect(filterPage(page, 'status').locator('.fb-opt-label')).toHaveText(['Open', 'To Do', 'In Progress', 'Need Action', 'Waiting', 'Complete'])
    const titles = await filterPage(page, 'status').locator('.fb-opt-body').evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''))
    expect(titles).toHaveLength(6)
    for (const t of titles) { expect(t).not.toBe(''); expect(t).not.toMatch(/tier|focus|satellite|backlog|parked/i) }
    // C13: page one names no tier either, in its words or its titles, and reads the set status.
    await openFilterMenu(page)
    await expandMoreFilters(page)
    expect(await filterMenu(page).locator('.fb-home').innerText()).not.toMatch(/\b(Focus|Satellite|Backlog|Parked)\b/)
    const homeTitles = await filterMenu(page).locator('.fb-home [title]').evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''))
    expect(homeTitles.length).toBeGreaterThan(3)
    for (const t of homeTitles) expect(t).not.toMatch(/tier|focus|satellite|backlog|parked/i)
    await expect(summary(page, 'status')).toHaveText('Complete')
    expect(await page.locator('.fb-menu input[type="checkbox"], .fb-menu select').count()).toBe(0)
    await closeFilterMenu(page)
  })
})

test.describe('Mia: menu layout and words', () => {
  test.beforeEach(async ({ page }) => {
    await stubBoard(page, MIA, MIA_PINS)
    await openHome(page)
    await expect(row(page, 'fb-mia-h2')).toBeVisible({ timeout: 20_000 })
  })

  test('C47 + G5: clicking at the coordinates measured when a page opens never moves a row; page one keeps its rows until the next open', async ({ page }) => {
    await openFilterMenu(page)
    const rects = (l: Locator) => l.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width] }))
    const same = (a: number[][], b: number[][]) => {
      expect(a.length).toBe(b.length)
      a.forEach((p, i) => p.forEach((n, k) => expect(Math.abs(n - b[i][k])).toBeLessThanOrEqual(1)))
    }
    const at = async (l: Locator) => { const b = await box(l); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
    // Status: plain clicks toggle; the first chip arrives without moving a row.
    await openFilterPage(page, 'status')
    await settled(filterMenu(page))
    const statusRows = filterPage(page, 'status').locator('.fb-opt-body')
    const s0 = await rects(statusRows)
    const st = [await at(filterValue(page, 'status', 'Waiting')), await at(filterValue(page, 'status', 'Complete'))]
    for (const t of st) await page.mouse.click(t.x, t.y)
    for (const v of ['Waiting', 'Complete']) await expect(filterValue(page, 'status', v)).toHaveAttribute('aria-pressed', 'true')
    same(await rects(statusRows), s0)
    // Project: two plain clicks add two values (no modifier, no add square).
    await openFilterPage(page, 'project')
    await settled(filterMenu(page))
    const projRows = filterPage(page, 'project').locator('.fb-opt-body')
    const p0 = await rects(projRows)
    const pt = [await at(filterValue(page, 'project', 'Home')), await at(filterValue(page, 'project', 'Garden'))]
    for (const t of pt) await page.mouse.click(t.x, t.y)
    for (const v of ['Home', 'Garden']) await expect(filterValue(page, 'project', v)).toHaveAttribute('aria-pressed', 'true')
    same(await rects(projRows), p0)
    await expect(filterChip(page, 'project')).toContainText('Home, Garden')
    // A Time window preset keeps its page open; back on page one the property still sits in the
    // fold it was listed in at open (its value already reads), and leaves it on the next open.
    await openFilterPage(page, 'time')
    await filterValue(page, 'time', '24h').click()
    await openFilterMenu(page)
    await expect(filterMenu(page).locator('#fb-more-body .fb-prop[data-filter-dim="time"]')).toHaveCount(1)
    await expect(summary(page, 'time')).toHaveText('Updated in 24h')
    // The row holds two lines while the menu hangs under it, so the third chip waits behind +N until it closes.
    await closeFilterMenu(page)
    await expect(filterChip(page, 'time')).toBeVisible()
    await openFilterMenu(page)
    expect(await shownDims(filterMenu(page))).toEqual(['status', 'project', 'date', 'time'])
    await expect(filterMenu(page).locator('#fb-more-body .fb-prop[data-filter-dim="time"]')).toHaveCount(0)
  })

  test('C29 + C42 + F14: More filters grows the box below its toggle and folds back; a set folded property is promoted; no motion under reduced motion', async ({ page }) => {
    await openFilterMenu(page)
    const h0 = (await box(filterMenu(page))).height
    // Page one, display rows included, fits under the cap: its body does not scroll.
    expect(h0).toBeLessThan(520)
    expect(await filterMenu(page).locator('.fb-menu-body').evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
    const toggle = filterMenu(page).getByRole('button', { name: /^More filters/ })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toHaveAttribute('aria-controls', 'fb-more-body')
    await expect(toggle.locator('.fb-prop-summary')).toHaveText('Blocked, Time window')
    // Folded, the display rows start right under the toggle: no blank space for rows it does not draw (F14).
    const t0 = await box(toggle)
    const order0 = await box(filterMenu(page).locator('.dm-section.dm-order'))
    expect(order0.y - (t0.y + t0.height)).toBeLessThan(16)
    await expandMoreFilters(page)
    await expect(filterDimRow(page, 'time')).toBeVisible()
    // The fold's rows land under the toggle: the box grows, the toggle does not move.
    expect((await box(filterMenu(page))).height).toBeGreaterThan(h0)
    expect(Math.abs((await box(toggle)).y - t0.y)).toBeLessThanOrEqual(1)
    await toggle.click()
    await expect(filterDimRow(page, 'time')).toBeHidden()
    expect(Math.abs((await box(filterMenu(page))).height - h0)).toBeLessThanOrEqual(1)
    // The fold state persists across opens.
    await expandMoreFilters(page)
    await closeFilterMenu(page)
    await openFilterMenu(page)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // Not blocked: a single-select pick closes the menu.
    await openFilterPage(page, 'blocked')
    await filterValue(page, 'blocked', 'Not blocked').click()
    await expect(filterMenu(page)).toHaveCount(0)
    await expect(filterButton(page)).toBeFocused()
    // Next open, Blocked is set, so it sits with the first rows and leaves the fold.
    await openFilterMenu(page)
    expect(await shownDims(filterMenu(page))).toEqual(['status', 'project', 'date', 'blocked'])
    await expect(filterMenu(page).locator('#fb-more-body .fb-prop[data-filter-dim="blocked"]')).toHaveCount(0)
    await expect(summary(page, 'blocked')).toHaveText('Not blocked')
    await expect(summary(page, 'blocked')).not.toHaveClass(/is-default/)
    await expect(toggle.locator('.fb-prop-summary')).toHaveText('Time window')
    // Folded again with a filter set (Clear in the title): the toggle sits fully inside the box, not behind a scrollbar.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(clearInTitle(page)).toBeVisible()
    await expect.poll(async () => {
      const [m, t] = [await box(filterMenu(page)), await box(toggle)]
      return t.y + t.height <= m.y + m.height + 0.5 && t.y >= m.y
    }).toBe(true)
    await closeFilterMenu(page)
    // C42: reduced motion stops every animation and transition the menu and the row own.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openFilterMenu(page)
    const motion = () => page.evaluate(() => {
      const d = (sel: string, prop: 'animationDuration' | 'transitionDuration') => {
        const el = document.querySelector(sel)
        return el ? getComputedStyle(el)[prop].replace(/(, 0s)+$/, '') : 'missing'
      }
      return [
        d('.fb-menu', 'animationDuration'), d('.fb-chip', 'animationDuration'), d('.fb-row', 'transitionDuration'),
        d('.fb-more-chevron', 'transitionDuration'), d('.fb-check-box', 'transitionDuration'),
      ]
    })
    expect((await motion()).slice(0, 4)).toEqual(['0s', '0s', '0s', '0s'])
    await openFilterPage(page, 'status')
    expect((await motion())[4]).toBe('0s')
  })

  test('C39 + C60: Date lists all five values in one page; single-select picks close; value-only Blocked and Time chips', async ({ page }) => {
    await openFilterPage(page, 'date')
    const rows = filterPage(page, 'date').locator('.fb-opt-body')
    await expect(rows.locator('.fb-opt-label')).toHaveText(['Available now', 'Any date', 'Overdue', 'Starting within 7 days'])
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-date-value')))).toEqual(['now', '', 'overdue', 'this-week'])
    await expect(filterValue(page, 'date', 'Available now')).toHaveAttribute('title', 'Hide tasks that start later. Tasks with no start date stay.')
    await expect(filterValue(page, 'date', 'Any date')).toHaveAttribute('title', 'Show every task, including ones that start later.')
    await expect(filterValue(page, 'date', 'this-week')).toHaveAttribute('title', 'Hide only tasks that start more than 7 days from now.')
    // Single-select: a bare tick slot, no square and no Only.
    await expect(filterPage(page, 'date').locator('.fb-check-box, .fb-only')).toHaveCount(0)
    await expect(filterValue(page, 'date', 'Available now').locator('.fb-check svg')).toHaveCount(1)
    // A pick closes the menu and hands focus back to Display.
    await filterValue(page, 'date', 'Any date').click()
    await expect(filterMenu(page)).toHaveCount(0)
    await expect(filterButton(page)).toBeFocused()
    await expect(filterChip(page, 'date')).toContainText('Date: Any date')
    await openFilterPage(page, 'blocked')
    await filterValue(page, 'blocked', 'Not blocked').click()
    await expect(filterMenu(page)).toHaveCount(0)
    // A Time window preset keeps its page open (the basis may come next).
    await openFilterPage(page, 'time')
    await filterValue(page, 'time', '24h').click()
    await expect(filterValue(page, 'time', '24h')).toHaveAttribute('aria-pressed', 'true')
    await expect(filterMenu(page)).toHaveAttribute('data-page', 'time')
    await closeFilterMenu(page)
    await expect(filterChip(page, 'blocked').locator('.fb-chip-body')).toHaveText('Not blocked')
    await expect(filterChip(page, 'time').locator('.fb-chip-body')).toHaveText('Updated in 24h')
    await removeFilterChip(page, 'date')
    await openFilterMenu(page)
    await expect(summary(page, 'date')).toHaveText('Available now')
    await openFilterPage(page, 'date')
    await expect(filterValue(page, 'date', 'Available now')).toHaveAttribute('aria-pressed', 'true')
  })
})

test.describe('Themes, narrow panels and the view item', () => {
  test('C36 + C17: selected and unselected text clears 4.5:1 in both themes, on every page and in the row', async ({ page }) => {
    await stubBoard(page, MIA, MIA_PINS)
    await openHome(page)
    await expect(row(page, 'fb-mia-h2')).toBeVisible({ timeout: 20_000 })
    const measure = async (sels: string[]) => {
      for (const theme of ['light', 'dark']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        for (const sel of sels) expect.soft(await contrastOf(page, sel), `${theme} ${sel}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    await addFilter(page, 'project', 'Garden', { keepOpen: true })
    await page.mouse.move(1, 1)
    await measure([
      '.fb-menu .fb-opt-body[data-filter-value="Garden"] .fb-opt-label',
      '.fb-menu .fb-opt-body[data-filter-value="Home"] .fb-opt-label',
      '.fb-menu .fb-page-title',
      '.fb-row [data-chip-dim="project"] .fb-chip-val',
      '.fb-row [data-chip-dim="project"] .fb-chip-dim',
    ])
    // The ticked square draws its tick; the unticked one draws none.
    await expect(filterValue(page, 'project', 'Garden').locator('.fb-check-box svg')).toHaveCount(1)
    await expect(filterValue(page, 'project', 'Home').locator('.fb-check-box svg')).toHaveCount(0)
    const name = test.info().project.name === 'webkit' ? 'webkit-filter-dark' : 'filter-menu-dark'
    await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: await clipAround(page) })
    // Page one: property names, a set value, the Filter title's Clear and the View row.
    await openFilterMenu(page)
    await page.mouse.move(1, 1)
    await measure([
      '.fb-menu .fb-prop[data-filter-dim="status"] .fb-item-text',
      '.fb-menu .fb-prop[data-filter-dim="project"] .fb-prop-summary',
      '.fb-menu .fb-home .fb-group-action',
      '.fb-menu [data-view-option="view"] .fb-item-text',
    ])
    // The View page: the current view and another one.
    await openViewsPage(page)
    await page.mouse.move(1, 1)
    await measure([
      '.fb-menu .dm-view[aria-pressed="true"] .dm-view-label',
      '.fb-menu .dm-view[aria-pressed="false"] .dm-view-label',
      '.fb-menu .fb-page-title',
    ])
  })

  test('C35 + C66 + F01 + F02: a narrow panel keeps property names and the unit, shows three filters, folds the rest behind +N', async ({ page }) => {
    await stubBoard(page, ownerSeeds())
    await openHome(page)
    await expect(row(page, 'fb-own-1')).toBeAttached({ timeout: 30_000 })
    await addFilter(page, 'project', 'Walnut')
    await page.locator('.fb-toolbar-scope').evaluate((el) => { (el as HTMLElement).style.width = '360px' })
    const body = filterChip(page, 'project').locator('.fb-chip-body')
    // F01: the default panel is narrow, so the narrow row must still read on its own, on one
    // line (WebKit's innerText breaks between flex items, hence the whitespace).
    await expect(body).toHaveText(/^Project:\s*Walnut\s*$/, { useInnerText: true })
    expect((await body.boundingBox())!.height).toBeLessThanOrEqual(28)
    await expect(body).toHaveAttribute('aria-label', 'Project: Walnut, change')
    await expect(page.getByTestId('filter-count')).toHaveText(/^\d+ tasks?$/, { useInnerText: true })
    await expect(page.getByTestId('filter-count')).toHaveAttribute('aria-label', /^\d+ tasks?$/)
    await page.screenshot({ path: `${SHOTS}/narrow-panel.png`, clip: await clipAround(page) })
    await addFilter(page, 'source', 'Microsoft To Do')
    await setStatus(page, ['To Do', 'In Progress', 'Need Action', 'Complete'])
    await closeFilterMenu(page)
    // F02: three filters are all on screen, no +N while the row has room for them.
    await expect(filterRow(page).locator('.fb-chip[data-chip-dim]')).toHaveCount(3)
    await expect(filterRow(page).locator('.fb-chip-plus')).toHaveCount(0)
    await expect(filterChip(page, 'status').locator('.fb-chip-body')).toHaveText(/^Status:\s*Open, Complete\s*$/, { useInnerText: true })
    await addFilter(page, 'date', 'Any date')
    await addFilter(page, 'blocked', 'Not blocked')
    await addFilter(page, 'time', '24h')
    await addFilter(page, 'tags', 't03')
    await page.locator('.fb-toolbar-scope').evaluate((el) => { (el as HTMLElement).style.width = '320px' })
    const plus = filterRow(page).locator('.fb-chip-plus')
    await expect(plus).toBeVisible()
    // The fit settles over a frame or two after the width change, and again whenever the
    // tail's count changes width (`Loading completed` to `N tasks`): wait for the count,
    // then for a split of 7, and read `+N` again at each step rather than trusting an
    // earlier read (WebKit: a read straddling a refit came back one short).
    await expect(page.getByTestId('filter-count')).toHaveText(/^\d+ tasks?$/, { useInnerText: true })
    const plusN = async () => Number((await plus.innerText()).replace('+', ''))
    const split = async () => (await filterRow(page).locator('.fb-chip[data-chip-dim]').count()) + await plusN()
    await expect.poll(split).toBe(7)
    await expect.poll(async () => (await plus.getAttribute('aria-label')) === `${await plusN()} more filters`).toBe(true)
    await plus.click()
    const over = page.locator('.fb-overflow-menu')
    const n = await plusN()
    await expect(over.locator('.fb-chip[data-chip-dim]')).toHaveCount(n)
    await settled(over)
    const ob = await box(over)
    const vp = page.viewportSize()!
    expect(ob.x + ob.width).toBeLessThanOrEqual(vp.width)
    expect(ob.y + ob.height).toBeLessThanOrEqual(vp.height)
    await over.locator('.fb-chip-x').first().click()
    await expect(filterRow(page).locator('.fb-chip[data-chip-dim]').or(over.locator('.fb-chip[data-chip-dim]'))).toHaveCount(6)
  })

  test('C70: with the tab bar hidden, the view name leads the row, opens Display, and survives Clear', async ({ page }) => {
    await stubBoard(page, MIA, MIA_PINS, { tabBar: true })
    await openHome(page)
    await openDisplayMenu(page)
    const tabBarSwitch = filterMenu(page).locator('[data-view-option="quick-views"]')
    await expect(tabBarSwitch).toHaveAttribute('aria-checked', 'true')
    await tabBarSwitch.click()
    // C56: switching the bar off closes the menu and leaves focus on Display.
    await expect(filterMenu(page)).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Display')
    await openDisplayMenu(page)
    await expect(tabBarSwitch).toHaveAttribute('aria-checked', 'false')
    // A view is picked on the View page; the pick closes the menu.
    await chooseDisplayOption(page, 'pinned')
    await expect(filterMenu(page)).toHaveCount(0)
    const item = filterRow(page).locator('.fb-view-item')
    await expect(item).toHaveText('View: Pinned')
    await expect(item).toHaveAttribute('aria-label', 'View: Pinned, change in Display')
    await expect(filterButton(page)).toHaveAttribute('title', 'Display: view Pinned, sort, group, layout')
    await expect(filterRow(page).locator('.fb-chip-x')).toHaveCount(0)
    await expect(badge(page)).toHaveCount(0)
    await item.click()
    await expect(filterMenu(page)).toBeVisible()
    await expect(filterMenu(page).locator('[data-view-option="view"] .fb-prop-summary')).toHaveText('Pinned')
    await page.keyboard.press('Escape')
    await expect(filterMenu(page)).toHaveCount(0)
    await addFilter(page, 'project', 'Garden')
    await filterRow(page).getByRole('button', { name: 'Clear all filters' }).click()
    await expect(item).toHaveText('View: Pinned')
    await chooseDisplayOption(page, 'all')
    await expect(filterMenu(page)).toHaveCount(0)
    await expect(filterRow(page)).toHaveCount(0)
  })
})
