/**
 * The home task panel's Filter button, popover and filter row on Mia's
 * first-week board (spec 2.1, 6.1 to 6.4): Home 3 + Garden 2 open, one Garden
 * task complete, two pins. Also the two themes and the view item. The dense
 * board lives in filter-bar-dense.spec.ts. Every test answers the board reads
 * for its own page (filter-bar-fixtures.ts `stubBoard`); nothing is written to
 * the fixture server, and isolateUiPrefs keeps the filter keys per context.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator } from '@playwright/test'
import {
  addFilter, closeFilterMenu, expandMoreFilters, filterButton, filterChip, filterDimRow, filterMenu, filterRow,
  filterValue, openDisplayMenu, openFilterMenu, removeFilterChip, setStatus, valuesFlyout,
} from './filter-bar-helpers'
import {
  MIA, MIA_PINS, SHOTS, badge, box, clipAround, contrastOf, focusedLabel, listIds, openHome, ownerSeeds, row, settled, stubBoard,
} from './filter-bar-fixtures'

// Dense boards and many popover round trips: a busy machine needs more than 30s.
test.describe.configure({ timeout: 90_000 })

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

test.describe('Mia: first week', () => {
  test.beforeEach(async ({ page }) => {
    await stubBoard(page, MIA, MIA_PINS)
    await openHome(page)
    await expect(row(page, 'fb-mia-h2')).toBeVisible({ timeout: 20_000 })
  })

  test('S1 + S3 + C3 + C5 + C55: one click narrows to Garden; the row sits above the popover', async ({ page }) => {
    // C3: default state has no row, no badge, and the open statuses + Available now pressed.
    await expect(filterRow(page)).toHaveCount(0)
    await expect(badge(page)).toHaveCount(0)
    await expect(filterButton(page)).toHaveAttribute('title', 'Filter tasks')
    await openFilterMenu(page)
    await expect(page.locator('.fb-menu .fb-search-input')).toBeFocused()
    for (const [label, on] of [['To Do', 'true'], ['In Progress', 'true'], ['Need Action', 'true'], ['Waiting', 'false'], ['Complete', 'false']]) {
      await expect(filterValue(page, 'status', label)).toHaveAttribute('aria-pressed', on)
    }
    await expect(filterValue(page, 'date', 'Available now')).toHaveAttribute('aria-pressed', 'true')
    // C55: the row is there with its placeholder; the popover hangs under it, right edges aligned.
    await expect(filterRow(page)).toContainText('No filters yet')
    await settled(filterMenu(page))
    const rowBefore = await box(filterRow(page))
    const menu = await box(filterMenu(page))
    const btn = await box(filterButton(page))
    expect(menu.y).toBeGreaterThanOrEqual(rowBefore.y + rowBefore.height - 1)
    // Right edges align when the popover fits left of the button's right edge; else it is clamped in.
    if (btn.x + btn.width - menu.width >= 8) expect(Math.abs(menu.x + menu.width - (btn.x + btn.width))).toBeLessThanOrEqual(2)
    else expect(menu.x).toBeGreaterThanOrEqual(0)
    // C5: one click on Garden, same poll: chip, badge, list, popover still open.
    await filterValue(page, 'project', 'Garden').click()
    await expect(filterChip(page, 'project')).toContainText('Garden')
    await expect(badge(page)).toHaveText('1')
    await expect(filterValue(page, 'project', 'Garden')).toHaveAttribute('aria-pressed', 'true')
    await expect(filterMenu(page)).toBeVisible()
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
    await expect(filterMenu(page).locator('.fb-menu-summary')).toHaveText('Project: Garden')
    await expect(filterButton(page)).toHaveAttribute('title', 'Filter tasks (1 active)')
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

  test('S2 + C6 + C63: pointer removal holds the row until the pointer leaves, then focus is on Filter', async ({ page }) => {
    await addFilter(page, 'project', 'Garden')
    const tabs = page.locator('.todo-section-tabs').first()
    const tabsY = (await box(tabs)).y
    const x = filterChip(page, 'project').locator('.fb-chip-x')
    const xBox = await box(x)
    await page.mouse.click(xBox.x + xBox.width / 2, xBox.y + xBox.height / 2)
    await expect(filterChip(page, 'project')).toHaveCount(0)
    await expect(filterRow(page)).toContainText('No filters')
    expect(await focusedLabel(page)).toBe('Filter')
    expect(Math.abs((await box(tabs)).y - tabsY)).toBeLessThanOrEqual(1)
    const selected = await page.locator('.todo-section-tabs [role="tab"][aria-selected="true"]').textContent()
    await page.mouse.click(xBox.x + xBox.width / 2, xBox.y + xBox.height / 2)
    expect(await page.locator('.todo-section-tabs [role="tab"][aria-selected="true"]').textContent()).toBe(selected)
    await expect(badge(page)).toHaveCount(0)
    await page.mouse.move(2, 2)
    await expect(filterRow(page)).toHaveCount(0, { timeout: 1_000 })
    await expect(row(page, 'fb-mia-h2')).toBeVisible()
  })

  test('C6 + C32: keyboard reaches body, x and Clear; Backspace removes at once and focus walks next, previous, Filter', async ({ page, browserName }) => {
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
    expect(await focusedLabel(page)).toBe('Filter')
  })

  test('C7: Clear puts every dimension back, keeps Sort, and the row goes', async ({ page }) => {
    const sortBefore = await page.evaluate(() => localStorage.getItem('walnut-todo-sortBy'))
    await addFilter(page, 'project', 'Garden')
    await setStatus(page, ['To Do', 'Waiting'])
    await addFilter(page, 'date', 'Overdue')
    await expect(filterRow(page).locator('.fb-chip')).toHaveCount(3)
    await filterRow(page).getByRole('button', { name: 'Clear all filters' }).click()
    await expect(filterRow(page)).toHaveCount(0)
    expect(await focusedLabel(page)).toBe('Filter')
    expect(await page.evaluate(() => localStorage.getItem('walnut-todo-sortBy'))).toBe(sortBefore)
    await openFilterMenu(page)
    for (const [label, on] of [['To Do', 'true'], ['In Progress', 'true'], ['Need Action', 'true'], ['Waiting', 'false'], ['Complete', 'false']]) {
      await expect(filterValue(page, 'status', label)).toHaveAttribute('aria-pressed', on)
    }
    await expect(filterValue(page, 'date', 'Available now')).toHaveAttribute('aria-pressed', 'true')
    await expect(filterValue(page, 'project', 'Garden')).toHaveAttribute('aria-pressed', 'false')
  })

  test('C11 + C12 + C13 + C13b + C50: last status stays on; no native checkbox; plain first-layer words with titles', async ({ page }) => {
    await setStatus(page, ['Complete'], { keepOpen: true })
    const complete = filterValue(page, 'status', 'Complete')
    await expect(complete).toHaveAttribute('aria-disabled', 'true')
    await expect(complete).toHaveAttribute('title', 'At least one status stays on')
    await complete.click({ force: true })
    await expect(complete).toHaveAttribute('aria-pressed', 'true')
    await expect(filterChip(page, 'status')).toContainText('Complete')
    expect(await page.locator('.fb-menu input[type="checkbox"], .fb-menu select').count()).toBe(0)
    const first = page.locator('.fb-menu .fb-dims > .fb-dim')
    const text = (await first.allInnerTexts()).join(' ')
    expect(text).not.toMatch(/\b(Focus|Satellite|Backlog|Parked)\b/)
    const titles = await first.locator('.fb-val[data-filter-value]').evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''))
    expect(titles.length).toBeGreaterThan(5)
    for (const t of titles) { expect(t).not.toBe(''); expect(t).not.toMatch(/tier|focus|satellite|backlog|parked/i) }
    const words = await filterDimRow(page, 'status').locator('.fb-val-text').allInnerTexts()
    expect(words).toEqual(['To Do', 'In Progress', 'Need Action', 'Waiting', 'Complete'])
    const open = await box(page.locator('.fb-menu .fb-open-label'))
    const todo = await box(filterValue(page, 'status', 'To Do'))
    expect(open.y + open.height).toBeLessThanOrEqual(todo.y + 1)
    await closeFilterMenu(page)
  })
})

test.describe('Mia: popover layout and words', () => {
  test.beforeEach(async ({ page }) => {
    await stubBoard(page, MIA, MIA_PINS)
    await openHome(page)
    await expect(row(page, 'fb-mia-h2')).toBeVisible({ timeout: 20_000 })
  })

  test('C47: clicking at the coordinates measured at open never moves a value; Recent waits for the next open', async ({ page }) => {
    await openFilterMenu(page)
    await settled(filterMenu(page))
    await expect(page.locator('.fb-menu [data-filter-dim="recent"]')).toHaveCount(0)
    const vals = page.locator('.fb-menu [data-filter-dim="status"] .fb-val, .fb-menu [data-filter-dim="project"] .fb-val')
    const before = await vals.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width] }))
    const at = async (l: Locator) => { const b = await box(l); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
    const targets = [
      await at(filterValue(page, 'status', 'Waiting')),
      await at(filterValue(page, 'status', 'Complete')),
      await at(filterValue(page, 'project', 'Home')),
      await at(filterValue(page, 'project', 'Garden')),
    ]
    await page.mouse.click(targets[0].x, targets[0].y)
    await page.mouse.click(targets[1].x, targets[1].y)
    await page.keyboard.down('ControlOrMeta')
    await page.mouse.click(targets[2].x, targets[2].y)
    await page.mouse.click(targets[3].x, targets[3].y)
    await page.keyboard.up('ControlOrMeta')
    for (const [dim, v] of [['status', 'Waiting'], ['status', 'Complete'], ['project', 'Home'], ['project', 'Garden']] as const) {
      await expect(filterValue(page, dim, v)).toHaveAttribute('aria-pressed', 'true')
    }
    const after = await vals.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width] }))
    expect(after.length).toBe(before.length)
    after.forEach((a, i) => a.forEach((n, k) => expect(Math.abs(n - before[i][k])).toBeLessThanOrEqual(1)))
    await expect(page.locator('.fb-menu [data-filter-dim="recent"]')).toHaveCount(0)
    await expect(filterChip(page, 'project')).toContainText('Home, Garden')
    await closeFilterMenu(page)
    await openFilterMenu(page)
    await expect(page.locator('.fb-menu [data-filter-dim="recent"]')).toBeVisible()
  })

  test('C29 + C42 + F14: More filters grows the box below its toggle and folds it back; Mia stays small; no motion under reduced motion', async ({ page }) => {
    await openFilterMenu(page)
    await settled(filterMenu(page))
    const h0 = (await box(filterMenu(page))).height
    expect(h0).toBeLessThan(300)
    // Folded, the box ends right under the toggle: no blank space for rows it does not draw (F14).
    const toggle = filterMenu(page).getByRole('button', { name: /^More filters/ })
    const t0 = await box(toggle)
    const m0 = await box(filterMenu(page))
    expect(m0.y + m0.height - (t0.y + t0.height)).toBeLessThan(16)
    await expandMoreFilters(page)
    await expect(filterDimRow(page, 'time')).toBeVisible()
    // The fold's rows land under the toggle: the box grows, the toggle does not move.
    expect((await box(filterMenu(page))).height).toBeGreaterThan(h0)
    expect(Math.abs((await box(toggle)).y - t0.y)).toBeLessThanOrEqual(1)
    await toggle.click()
    await expect(filterDimRow(page, 'time')).toBeHidden()
    expect((await box(filterMenu(page))).height).toBe(h0)
    await expandMoreFilters(page)
    await filterValue(page, 'blocked', 'Not blocked').click()
    await expect(filterMenu(page).getByRole('button', { name: /^More filters/ })).toHaveText('More filters (1 set)')
    await filterMenu(page).getByRole('button', { name: /^More filters/ }).click()
    // The first chip brought the footer in: the box grew for it, so the folded toggle
    // still sits fully inside the box, not behind a scrollbar.
    await expect(filterMenu(page).locator('.fb-menu-foot')).toBeVisible()
    await expect.poll(async () => {
      const [m, t] = [await box(filterMenu(page)), await box(toggle)]
      return t.y + t.height <= m.y + m.height + 0.5 && t.y >= m.y
    }).toBe(true)
    await closeFilterMenu(page)
    await openFilterMenu(page)
    await expect(filterMenu(page).getByRole('button', { name: /^More filters/ })).toHaveAttribute('aria-expanded', 'true')
    await closeFilterMenu(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openFilterMenu(page)
    const motion = await page.evaluate(() => {
      const d = (sel: string, prop: 'animationDuration' | 'transitionDuration') => {
        const el = document.querySelector(sel)
        return el ? getComputedStyle(el)[prop] : 'missing'
      }
      return [d('.fb-menu', 'animationDuration'), d('.fb-chip', 'animationDuration'), d('.fb-row', 'transitionDuration')]
    })
    expect(motion).toEqual(['0s', '0s', '0s'])
  })

  test('C39 + C60: Date first layer, More dates, and value-only Blocked and Time chips', async ({ page }) => {
    await openFilterMenu(page)
    const dateVals = filterDimRow(page, 'date').locator('.fb-val')
    await expect(dateVals).toHaveText(['Available now', 'Any date', 'More dates'])
    await expect(filterValue(page, 'date', 'Available now')).toHaveAttribute('title', 'Hide tasks that start later. Tasks with no start date stay.')
    await expect(filterValue(page, 'date', 'Any date')).toHaveAttribute('title', 'Show every task, including ones that start later.')
    await filterDimRow(page, 'date').getByRole('button', { name: 'More dates' }).click()
    const fly = valuesFlyout(page)
    await expect(fly.locator('[data-date-value]')).toHaveText(['Overdue', 'Starting within 7 days', 'No dates'])
    await expect(fly.locator('[data-date-value="this-week"]')).toHaveAttribute('title', 'Hide only tasks that start more than 7 days from now.')
    await page.keyboard.press('Escape')
    await expect(fly).toHaveCount(0)
    await expect(filterMenu(page)).toBeVisible()
    await filterValue(page, 'date', 'Any date').click()
    await expect(filterChip(page, 'date')).toContainText('Date: Any date')
    await expandMoreFilters(page)
    await filterValue(page, 'blocked', 'Not blocked').click()
    await filterValue(page, 'time', '24h').click()
    await closeFilterMenu(page)
    await expect(filterChip(page, 'blocked').locator('.fb-chip-body')).toHaveText('Not blocked')
    await expect(filterChip(page, 'time').locator('.fb-chip-body')).toHaveText('Updated in 24h')
    await removeFilterChip(page, 'date')
    await openFilterMenu(page)
    await expect(filterValue(page, 'date', 'Available now')).toHaveAttribute('aria-pressed', 'true')
  })
})

test.describe('Themes, narrow panels and the view item', () => {
  test('C36 + C17: selected and unselected text clears 4.5:1 in both themes', async ({ page }) => {
    await stubBoard(page, MIA, MIA_PINS)
    await openHome(page)
    await expect(row(page, 'fb-mia-h2')).toBeVisible({ timeout: 20_000 })
    await addFilter(page, 'project', 'Garden', { keepOpen: true })
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      for (const sel of [
        '.fb-menu .fb-val[data-filter-value="Garden"] .fb-val-text',
        '.fb-menu .fb-val[data-filter-value="Home"] .fb-val-text',
        '.fb-menu [data-filter-dim="status"] .fb-val[data-filter-value="To Do"] .fb-val-text',
        '.fb-row [data-chip-dim="project"] .fb-chip-val',
        '.fb-row [data-chip-dim="project"] .fb-chip-dim',
      ]) expect(await contrastOf(page, sel), `${theme} ${sel}`).toBeGreaterThanOrEqual(4.5)
      await expect(filterDimRow(page, 'project').getByRole('checkbox', { name: 'Add Garden' }).locator('svg')).toHaveCount(1)
      const name = theme === 'dark' ? (test.info().project.name === 'webkit' ? 'webkit-filter-dark' : 'filter-menu-dark') : null
      if (name) await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: await clipAround(page) })
    }
  })

  test('C35 + C66 + F01 + F02: a narrow panel keeps dimension names and the unit, shows three filters, folds the rest behind +N', async ({ page }) => {
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
    // The fit settles over a frame or two after the width change: wait for a stable split of 7.
    const split = async () => (await filterRow(page).locator('.fb-chip[data-chip-dim]').count()) + Number((await plus.innerText()).replace('+', ''))
    await expect.poll(split).toBe(7)
    const n = Number((await plus.innerText()).replace('+', ''))
    await expect(plus).toHaveAttribute('aria-label', `${n} more filters`)
    const shown = await filterRow(page).locator('.fb-chip[data-chip-dim]').count()
    expect(shown + n).toBe(7)
    await plus.click()
    const over = page.locator('.fb-overflow-menu')
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
    const tabBarSwitch = page.locator('.dm-menu [data-view-option="quick-views"]')
    await expect(tabBarSwitch).toHaveAttribute('aria-checked', 'true')
    await tabBarSwitch.click()
    // C56: switching the bar off closes Display and leaves focus on its button.
    await expect(page.locator('.dm-menu')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Display')
    await openDisplayMenu(page)
    await expect(tabBarSwitch).toHaveAttribute('aria-checked', 'false')
    await page.locator('.dm-menu [data-view-option="pinned"]').click()
    await page.keyboard.press('Escape')
    const item = filterRow(page).locator('.fb-view-item')
    await expect(item).toHaveText('View: Pinned')
    await expect(item).toHaveAttribute('aria-label', 'View: Pinned, change in Display')
    await expect(filterRow(page).locator('.fb-chip-x')).toHaveCount(0)
    await expect(badge(page)).toHaveCount(0)
    await item.click()
    await expect(page.locator('.dm-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await addFilter(page, 'project', 'Garden')
    await filterRow(page).getByRole('button', { name: 'Clear all filters' }).click()
    await expect(item).toHaveText('View: Pinned')
    await openDisplayMenu(page)
    await page.locator('.dm-menu [data-view-option="all"]').click()
    await page.keyboard.press('Escape')
    await expect(filterRow(page)).toHaveCount(0)
  })
})
