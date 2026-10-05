/**
 * The Filter bar on the owner's dense board (S7 to S11): 400 tasks, 30 projects, two sources, 80 tags.
 * Page one lists the properties (then the display rows); page two one property's values, all of them,
 * behind the menu's search box. Data comes from filter-bar-fixtures.ts (`stubBoard`), never from the
 * shared fixture board.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator } from '@playwright/test'
import {
  addFilter, closeFilterMenu, expandMoreFilters, filterChip, filterDimRow, filterMenu, filterPage, filterRow, filterSearch,
  filterValue, openFilterMenu, openFilterPage, openViewsPage, setStatus, VALUE_ROW,
} from './filter-bar-helpers'
import { SHOTS, box, clipAround, focusedLabel, openHome, ownerSeeds, row, settled, stubBoard } from './filter-bar-fixtures'

// 400 rows and many menu round trips: a busy machine needs more than 30s.
test.describe.configure({ timeout: 150_000 })

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

test.describe('Owner: dense board', () => {
  test.beforeEach(async ({ page }) => {
    await stubBoard(page, ownerSeeds())
    await openHome(page)
    await expect(row(page, 'fb-own-1')).toBeAttached({ timeout: 30_000 })
  })

  test('C4: a fresh user sees exactly Status, Project, Date and More filters under the Filter title (Source folds), then the display rows', async ({ page }) => {
    await openFilterMenu(page)
    const items = await filterMenu(page).locator('.fb-home .fb-item').evaluateAll((els) => els
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => (e.classList.contains('fb-more-toggle') ? 'more' : e.getAttribute('data-filter-dim'))))
    expect(items).toEqual(['status', 'project', 'date', 'more'])
    const toggle = filterMenu(page).getByRole('button', { name: /^More filters/ })
    await expect(toggle.locator('.fb-item-text')).toHaveText('More filters')
    await expect(toggle.locator('.fb-prop-summary')).toHaveText('Source, Blocked, Tags, Time window')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(filterMenu(page).locator('#fb-more-body')).toBeHidden()
    // Nothing set: one group titled Filter with no Clear, no search results, no page two.
    await expect(filterMenu(page).locator('.fb-group')).toHaveCount(1)
    await expect(filterMenu(page).locator('.fb-group-title')).toHaveText('Filter')
    await expect(filterMenu(page).locator('.fb-group-action, .fb-search-results, .fb-page')).toHaveCount(0)
    await expect(filterMenu(page).locator('.fb-home .fb-prop-summary:not(.is-default)')).toHaveCount(0)
    // Then the display rows, in order: Sort and Group, then View, Show tab bar, Session columns.
    const rows = await filterMenu(page).locator('.dm-section [data-view-option]').evaluateAll((els) => els
      .map((e) => e.getAttribute('data-view-option'))
      .filter((k) => ['sort', 'group', 'view', 'quick-views', 'session-panels'].includes(k ?? '')))
    expect(rows).toEqual(['sort', 'group', 'view', 'quick-views', 'session-panels'])
    // The menu is the search box and its body, nothing more: no footer.
    expect(await filterMenu(page).evaluate((el) => Array.from(el.children).map((c) => c.className))).toEqual(['fb-search fb-menu-search', 'fb-menu-body'])
    expect(await filterMenu(page).locator('.fb-menu-body').evaluate((el) => Array.from(el.children).map((c) => c.className)))
      .toEqual(['fb-home fb-group', 'dm-section dm-order', 'dm-section dm-settings', 'dm-section dm-context'])
  })

  test('S7 + C28 + C34 + C29: the Project page holds all 30 in board order behind a focused search; Source by name; the menu caps and scrolls', async ({ page }) => {
    await openFilterMenu(page)
    await expandMoreFilters(page)
    await expect(filterDimRow(page, 'source').locator('.fb-prop-summary')).toHaveText('Any')
    await expect(filterDimRow(page, 'priority')).toHaveCount(0)
    const homeH = (await box(filterMenu(page))).height
    await openFilterPage(page, 'project')
    // More than six values: the search box takes focus and names the property.
    await expect(filterSearch(page)).toBeFocused()
    await expect(filterSearch(page)).toHaveAttribute('placeholder', 'Search projects')
    const rows = filterPage(page, 'project').locator(VALUE_ROW)
    await expect(rows).toHaveCount(30)
    // The page starts with its default, Any project.
    await expect(filterPage(page, 'project').locator('.fb-opt-body').first()).toHaveAttribute('data-filter-value', 'Any project')
    // Board order: no saved order on a fresh browser, so projects sort by name.
    await expect(rows.first()).toHaveAttribute('data-filter-value', 'iOS App')
    await expect(rows.last()).toHaveAttribute('data-filter-value', 'Walnut')
    await expect(filterMenu(page).getByRole('button', { name: /^\d+ more$/ })).toHaveCount(0)
    await settled(filterMenu(page))
    const menuH = (await box(filterMenu(page))).height
    const avail = await page.evaluate(() => window.innerHeight)
    expect(menuH).toBeLessThanOrEqual(Math.min(520, avail))
    expect(menuH).toBeGreaterThan(homeH)
    expect(await filterMenu(page).locator('.fb-menu-body').evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true)
    // The search box filters the rows; the box follows its content per keystroke.
    await filterSearch(page).fill('Project 20')
    await expect(rows).toHaveCount(1)
    await expect.poll(async () => (await box(filterMenu(page))).height).toBeLessThan(menuH)
    await filterValue(page, 'project', 'Project 20').click()
    await expect(filterChip(page, 'project')).toContainText('Project 20')
    await expect(filterMenu(page)).toHaveAttribute('data-page', 'project')
    await expect(filterPage(page, 'project').locator('.fb-page-head .fb-page-reset')).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/filter-row-dense.png`, clip: await clipAround(page) })
    // Escape clears the search and stays on the page; every row comes back.
    await page.keyboard.press('Escape')
    await expect(filterSearch(page)).toHaveValue('')
    await expect(filterMenu(page)).toHaveAttribute('data-page', 'project')
    await expect(rows).toHaveCount(30)
    // Source: two values, so no search focus; the selected row (its default, Any source) takes
    // it; names, not ids, with counts.
    await openFilterPage(page, 'source')
    await expect(filterPage(page, 'source').locator('.fb-opt-label')).toHaveText(['Any source', 'Local', 'Microsoft To Do'])
    await expect(filterValue(page, 'source', 'Any source')).toBeFocused()
    await expect(filterPage(page, 'source').locator('.fb-opt-body .tp-count')).toHaveCount(2)
  })

  test('S8 + C26 + C26b + C27: typing on page one goes straight to a value, Enter only adds, a click toggles, Escape clears then closes', async ({ page }) => {
    await openFilterMenu(page)
    const search = filterSearch(page)
    await expect(search).toBeFocused()
    await search.fill('project 2')
    await expect(page.locator('.fb-search-results [role="option"]').first()).toBeVisible()
    await search.fill('Project 21')
    const hits = page.locator('.fb-search-results [role="option"]')
    await expect(hits).toHaveCount(1)
    await expect(hits.first()).toHaveAttribute('data-filter-value', 'Project 21')
    await expect(hits.first().locator('.fb-hit-dim')).toHaveText('Project')
    await expect(hits.first().locator('.fb-hit-value')).toHaveText('Project 21')
    await expect(hits.first().locator('.fb-item-icon svg')).toHaveCount(1)
    await search.press('Enter')
    await expect(filterChip(page, 'project')).toContainText('Project 21')
    await expect(hits.first()).toHaveClass(/is-selected/)
    await expect(hits.first().locator('.fb-item-check svg')).toHaveCount(1)
    // A click toggles: the pointer can take a hit back off, and put it on again.
    await hits.first().click()
    await expect(filterChip(page, 'project')).toHaveCount(0)
    await hits.first().click()
    await expect(filterChip(page, 'project')).toContainText('Project 21')
    await search.fill('todo')
    await expect(hits.first()).toHaveAttribute('data-filter-value', 'Microsoft To Do')
    await search.press('Enter')
    await expect(filterChip(page, 'source')).toContainText('Microsoft To Do')
    await expect(filterChip(page, 'status')).toHaveCount(0)
    const todoHit = page.locator('.fb-search-results [role="option"][data-filter-dim="status"][data-filter-value="To Do"]')
    const index = await hits.evaluateAll((els) => els.findIndex((e) => e.getAttribute('data-filter-dim') === 'status' && e.getAttribute('data-filter-value') === 'To Do'))
    for (let i = 0; i < index; i++) await search.press('ArrowDown')
    await expect(todoHit).toHaveAttribute('aria-selected', 'true')
    await search.press('Enter')
    await expect(todoHit).toContainText('Already on')
    await expect(filterChip(page, 'status')).toHaveCount(0)
    await search.fill('doing')
    await expect(hits.first()).toHaveAttribute('data-filter-value', 'In Progress')
    await search.fill('zzqq')
    await expect(page.locator('.fb-search-results')).toContainText('Nothing matches "zzqq"')
    await page.keyboard.press('Escape')
    await expect(search).toHaveValue('')
    await expect(filterMenu(page)).toBeVisible()
    await expect(filterMenu(page)).toHaveAttribute('data-page', 'home')
    await page.keyboard.press('Escape')
    await expect(filterMenu(page)).toHaveCount(0)
    expect(await focusedLabel(page)).toBe('Display')
  })

  test('S8b: the same search finds views; the label the text names outright leads; Enter on a view picks it and closes the menu', async ({ page }) => {
    await openFilterMenu(page)
    const search = filterSearch(page)
    const hits = page.locator('.fb-search-results [role="option"]')
    // "recent" names the Recent view, and the Time window by keyword: the view it names outright comes first.
    await search.fill('recent')
    await expect(hits.first()).toHaveAttribute('data-view-option', 'recent')
    await expect(hits.first().locator('.fb-hit-dim')).toHaveText('View')
    await expect(hits.first().locator('.fb-hit-value')).toHaveText('Recent')
    await expect(hits.first().locator('.fb-item-icon svg')).toHaveCount(1)
    await expect(page.locator('.fb-search-results .fb-hit[data-filter-dim="time"]').first()).toBeVisible()
    // The view in use carries the check.
    await search.fill('all')
    await expect(page.locator('.fb-search-results .fb-hit[data-view-option="all"]')).toHaveClass(/is-selected/)
    await search.fill('pinned')
    const pinned = page.locator('.fb-search-results .fb-hit[data-view-option="pinned"]')
    await expect(pinned).toBeVisible()
    await expect(pinned).not.toHaveClass(/is-selected/)
    const index = await hits.evaluateAll((els) => els.findIndex((e) => e.getAttribute('data-view-option') === 'pinned'))
    for (let i = 0; i < index; i++) await search.press('ArrowDown')
    await expect(pinned).toHaveAttribute('aria-selected', 'true')
    await search.press('Enter')
    await expect(filterMenu(page)).toHaveCount(0)
    expect(await focusedLabel(page)).toBe('Display')
    // The tab bar is off on a fresh browser, so the row names the view.
    await expect(filterRow(page).locator('.fb-view-item')).toHaveText(/View:\s*Pinned/)
  })

  test('S9 + C53 + C31: a plain click toggles on page two and in the chip menu; Only on hover or focus; Remove filter', async ({ page }) => {
    await addFilter(page, 'project', 'Walnut', { keepOpen: true })
    const val = filterChip(page, 'project').locator('.fb-chip-val')
    await filterValue(page, 'project', 'iOS App').click()
    await expect(val).toHaveText('Walnut, iOS App')
    await filterValue(page, 'project', 'Walnut').click()
    await expect(val).toHaveText('iOS App')
    await expect(filterValue(page, 'project', 'Walnut')).toHaveAttribute('aria-pressed', 'false')
    await filterValue(page, 'project', 'Project 01').click()
    await expect(val).toHaveText('iOS App, Project 01')
    await expect(filterMenu(page).locator('[role="checkbox"], .fb-val-add')).toHaveCount(0)
    // Only waits for the pointer: hidden until the row is hovered.
    const p05 = filterPage(page, 'project').locator('.fb-opt').filter({ has: page.locator('[data-filter-value="Project 05"]') })
    await p05.scrollIntoViewIfNeeded()
    await page.mouse.move(1, 1)
    await expect(p05.getByRole('button', { name: 'Only Project 05' })).toBeHidden()
    await p05.hover()
    await expect(p05.getByRole('button', { name: 'Only Project 05' })).toBeVisible()
    await closeFilterMenu(page)
    await filterChip(page, 'project').locator('.fb-chip-body').click()
    const menu = page.locator('.fb-chip-menu[data-chip-menu-dim="project"]')
    await expect(menu).toBeVisible()
    const chipSearch = menu.getByRole('textbox', { name: 'Search projects' })
    await expect(chipSearch).toBeFocused()
    // The chip menu toggles on a plain click too.
    await menu.locator('.fb-opt-body[data-filter-value="Walnut"]').click()
    await expect(val).toHaveText('3 projects')
    await menu.locator('.fb-opt-body[data-filter-value="Walnut"]').click()
    await expect(val).toHaveText('iOS App, Project 01')
    // Its own search box filters its rows.
    await chipSearch.fill('project 0')
    await expect(menu.locator('.fb-opt-body')).toHaveCount(9)
    await chipSearch.fill('')
    await expect(menu.locator('.fb-opt-body')).toHaveCount(30)
    const optRow = menu.locator('.fb-opt').filter({ has: page.locator('[data-filter-value="Project 01"]') })
    await optRow.locator('.fb-opt-body').focus()
    await expect(optRow.getByRole('button', { name: 'Only Project 01' })).toBeVisible()
    await optRow.getByRole('button', { name: 'Only Project 01' }).click()
    await expect(val).toHaveText('Project 01')
    await menu.getByRole('button', { name: 'Remove filter' }).click()
    await expect(filterChip(page, 'project')).toHaveCount(0)
    await expect(menu).toHaveCount(0)
  })
})

test.describe('Owner: tags and counts', () => {
  test.beforeEach(async ({ page }) => {
    await stubBoard(page, ownerSeeds())
    await openHome(page)
    await expect(row(page, 'fb-own-1')).toBeAttached({ timeout: 30_000 })
  })

  test('C60: a plain tag reads without its label: prefix on its page, in the search, the chip and its row', async ({ page }) => {
    await openFilterMenu(page)
    // Tags fold behind More filters while nothing is set on them.
    await expect(filterMenu(page).locator('#fb-more-body .fb-prop[data-filter-dim="tags"]')).toHaveCount(1)
    await openFilterPage(page, 'tags')
    await expect(filterSearch(page)).toBeFocused()
    await expect(filterSearch(page)).toHaveAttribute('placeholder', 'Search tags')
    const rows = filterPage(page, 'tags').locator(VALUE_ROW)
    await expect(rows).toHaveCount(80)
    await expect(filterMenu(page).getByRole('button', { name: /^\d+ more$/ })).toHaveCount(0)
    await filterSearch(page).fill('t03')
    await expect(rows).toHaveCount(1)
    await filterValue(page, 'tags', 't03').click()
    await expect(filterChip(page, 'tags').locator('.fb-chip-val')).toHaveText('t03')
    // Empty the box, then Backspace goes back to page one, where the row reads the value.
    await filterSearch(page).fill('')
    await filterSearch(page).press('Backspace')
    await expect(filterMenu(page)).toHaveAttribute('data-page', 'home')
    await expect(filterDimRow(page, 'tags').locator('.fb-prop-summary')).toHaveText('t03')
    await filterSearch(page).fill('t03')
    await expect(page.locator('.fb-search-results [role="option"][data-filter-dim="tags"]').first()).toHaveAttribute('data-filter-value', 't03')
    await closeFilterMenu(page)
    await openFilterMenu(page)
    // Next open: set Tags sits with the first rows, its value in words.
    await expect(filterMenu(page).locator('.fb-home[data-section="filters"] > .fb-prop[data-filter-dim="tags"]')).toBeVisible()
    await expect(filterDimRow(page, 'tags').locator('.fb-prop-summary')).toHaveText('t03')
    const text = `${await filterRow(page).innerText()} ${await filterMenu(page).innerText()}`
    expect(text).not.toContain('label:')
  })

  test('S11 + C43: the count follows every change; facet counts follow the other properties', async ({ page }) => {
    await openFilterPage(page, 'project')
    const p01 = filterValue(page, 'project', 'Project 01').locator('.tp-count')
    await expect(p01).toHaveText('14')
    await openFilterPage(page, 'source')
    await filterValue(page, 'source', 'Microsoft To Do').click()
    await expect(filterValue(page, 'source', 'Microsoft To Do')).toHaveAttribute('aria-pressed', 'true')
    // Project 01 = task 2, 32, 62...; Microsoft To Do = every 4th task: both = 32, 92, ... 392, 7 tasks.
    await openFilterPage(page, 'project')
    await expect(p01).toHaveText('7')
    await filterValue(page, 'project', 'Project 01').click()
    await expect(page.getByTestId('filter-count')).toHaveText('7 tasks')
    // One count only: the row's (the menu has no footer count of its own).
    await expect(page.getByTestId('filter-count')).toHaveCount(1)
    await expect(filterMenu(page).locator('.fb-menu-count')).toHaveCount(0)
    expect(await page.getByTestId('filter-count').textContent()).not.toContain(' of ')
  })
})

test.describe('Owner: geometry, events and narrow panels', () => {
  test.beforeEach(async ({ page }) => {
    await stubBoard(page, ownerSeeds())
  })

  for (const vp of [{ width: 1280, height: 720 }, { width: 900, height: 600 }]) {
    test(`C18: every overlay stays inside a ${vp.width}x${vp.height} viewport`, async ({ page }) => {
      await page.setViewportSize(vp)
      await openHome(page)
      const inside = async (l: Locator) => {
        const b = await box(l)
        expect(b.x).toBeGreaterThanOrEqual(0)
        expect(b.y).toBeGreaterThanOrEqual(0)
        expect(b.x + b.width).toBeLessThanOrEqual(vp.width + 0.5)
        expect(b.y + b.height).toBeLessThanOrEqual(vp.height + 0.5)
        return b
      }
      await openFilterMenu(page)
      await settled(filterMenu(page))
      const menu = await inside(filterMenu(page))
      if (vp.width < 1000) expect(menu.width).toBeLessThanOrEqual(vp.width - 16)
      // The longest page (30 projects) is capped by the room below.
      await openFilterPage(page, 'project')
      await settled(filterMenu(page))
      await inside(filterMenu(page))
      await filterValue(page, 'project', 'iOS App').click()
      await closeFilterMenu(page)
      await filterChip(page, 'project').locator('.fb-chip-body').click()
      await settled(page.locator('.fb-chip-menu'))
      await inside(page.locator('.fb-chip-menu'))
      await page.keyboard.press('Escape')
      await expect(page.locator('.fb-chip-menu')).toHaveCount(0)
      // The View page, opened from the same menu, stays inside too.
      await openViewsPage(page)
      await settled(filterMenu(page))
      await inside(filterMenu(page))
    })
  }

  test('C19: pressing inside either page or a chip menu never drags a row or closes the menu', async ({ page }) => {
    await openHome(page)
    await expect(row(page, 'fb-own-1')).toBeAttached({ timeout: 30_000 })
    await openFilterMenu(page)
    // A drag would leave a dnd-kit transform on some row (or the dragging marker).
    const moved = () => page.locator('.todo-panel-list .todo-panel-item').evaluateAll((els) =>
      els.some((e) => { const t = (e as HTMLElement).style.transform; return !!t && t !== 'none' && !/translate3d\(0px, 0px/.test(t) }))
    const drag = async (l: Locator) => {
      const b = await box(l)
      await page.mouse.move(b.x + 20, b.y + 10)
      await page.mouse.down()
      await page.mouse.move(b.x + 60, b.y + 80, { steps: 6 })
      await page.mouse.up()
    }
    await drag(filterMenu(page).locator('.fb-home'))
    expect(await moved()).toBe(false)
    await expect(filterMenu(page)).toBeVisible()
    await openFilterPage(page, 'project')
    await drag(filterPage(page, 'project').locator('.fb-list-rows'))
    await filterValue(page, 'project', 'Project 05').click()
    await expect(filterMenu(page)).toBeVisible()
    await expect(filterPage(page, 'project')).toBeVisible()
    expect(await moved()).toBe(false)
    await closeFilterMenu(page)
    await filterChip(page, 'project').locator('.fb-chip-body').click()
    const chipMenu = page.locator('.fb-chip-menu')
    await expect(chipMenu).toBeVisible()
    await drag(chipMenu.locator('.fb-list-rows'))
    await expect(chipMenu).toBeVisible()
    expect(await moved()).toBe(false)
    await expect(page.locator('.todo-panel .is-dragging, [data-dnd-dragging="true"]')).toHaveCount(0)
  })

  test('C41: the first visible list row keeps its place when the row appears and goes', async ({ page }) => {
    await openHome(page)
    await expect(row(page, 'fb-own-1')).toBeAttached({ timeout: 30_000 })
    // Whichever box really scrolls: the home scroll box, or the list inside it.
    await page.locator('.home-navigation-scroll').first().evaluate((root) => {
      const inner = root.querySelector<HTMLElement>('.todo-panel-list')
      const el = root.scrollHeight > root.clientHeight + 1 ? root : inner!
      el.setAttribute('data-test-scroller', '')
      el.scrollTop = 600
    })
    const list = page.locator('[data-test-scroller]')
    expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
    const firstVisible = () => list.evaluate((el) => {
      const top = el.getBoundingClientRect().top
      const rows = Array.from(el.querySelectorAll<HTMLElement>('.todo-panel-list .todo-panel-item[data-task-id]'))
      const hit = rows.find((r) => r.getBoundingClientRect().bottom > top + 1)!
      return { id: hit.dataset.taskId, y: hit.getBoundingClientRect().y }
    })
    const a = await firstVisible()
    // The row comes with the first chip. Waiting matches no task here, so the list is the same.
    await setStatus(page, ['To Do', 'In Progress', 'Need Action', 'Waiting'])
    await expect(filterRow(page)).toBeVisible()
    const b = await page.evaluate(([id]) => document.querySelector(`.todo-panel-list [data-task-id="${id}"]`)!.getBoundingClientRect().y, [a.id])
    expect(Math.abs(b - a.y)).toBeLessThanOrEqual(2)
    await filterRow(page).getByRole('button', { name: 'Clear all filters' }).click()
    await expect(filterRow(page)).toHaveCount(0)
    const c = await page.evaluate(([id]) => document.querySelector(`.todo-panel-list [data-task-id="${id}"]`)!.getBoundingClientRect().y, [a.id])
    expect(Math.abs(c - a.y)).toBeLessThanOrEqual(2)
  })
})

test('C28: one task with no project adds Inbox as the first value of the Project page', async ({ page }) => {
  await stubBoard(page, ownerSeeds(true))
  await openHome(page)
  await expect(row(page, 'fb-own-1')).toBeAttached({ timeout: 30_000 })
  await openFilterPage(page, 'project')
  const rows = filterPage(page, 'project').locator(VALUE_ROW)
  await expect(rows).toHaveCount(31, { timeout: 15_000 })
  await expect(rows.first()).toHaveAttribute('data-filter-value', 'Inbox')
  await expect(rows.first()).toHaveAttribute('title', 'Tasks with no project')
  await expect(rows.nth(1)).toHaveAttribute('data-filter-value', 'iOS App')
  await expect(filterMenu(page).getByRole('button', { name: /^\d+ more$/ })).toHaveCount(0)
})

test('F03: opening the menu adds no row and moves nothing; a pointer removal holds the row until the pointer leaves', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await stubBoard(page, ownerSeeds(), [], { tabBar: true })
  await openHome(page)
  await expect(row(page, 'fb-own-1')).toBeAttached({ timeout: 30_000 })
  const tabs = page.locator('.todo-section-tabs').first()
  const tabsY = () => tabs.evaluate((el) => Math.round(el.getBoundingClientRect().y))
  const listY = () => row(page, 'fb-own-1').evaluate((el) => Math.round(el.getBoundingClientRect().y))
  const y0 = await tabsY()
  const l0 = await listY()
  // Open with nothing set: no row comes (2026-10-04: a placeholder row floated over the
  // tier heading and the tab bar), and the tab bar and the list stay put.
  await openFilterMenu(page)
  await expect(filterRow(page)).toHaveCount(0)
  expect(Math.abs((await tabsY()) - y0)).toBeLessThanOrEqual(1)
  expect(Math.abs((await listY()) - l0)).toBeLessThanOrEqual(1)
  await closeFilterMenu(page)
  // One chip (Waiting matches no task here): the row comes in under the tab bar, above the list.
  await setStatus(page, ['To Do', 'In Progress', 'Need Action', 'Waiting'])
  const rowBox = await box(filterRow(page))
  const tabsBox = await box(tabs)
  expect(rowBox.y).toBeGreaterThanOrEqual(tabsBox.y + tabsBox.height - 1)
  expect(rowBox.height).toBeLessThanOrEqual(33)
  expect(Math.abs((await tabsY()) - y0)).toBeLessThanOrEqual(1)
  const l1 = await listY()
  // Remove it with the pointer: the row holds its place until the pointer leaves, then goes.
  await filterChip(page, 'status').locator('.fb-chip-x').click()
  await expect(filterChip(page, 'status')).toHaveCount(0)
  await expect(filterRow(page)).toContainText('No filters')
  expect(Math.abs((await listY()) - l1)).toBeLessThanOrEqual(1)
  await page.mouse.move(900, 700)
  await expect(filterRow(page)).toHaveCount(0)
})
