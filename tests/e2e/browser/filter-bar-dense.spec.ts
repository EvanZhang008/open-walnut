/**
 * The Filter bar on the owner's dense board (S6 to S11): 400 tasks, 30 projects, two sources, 80 tags.
 * Data comes from filter-bar-fixtures.ts (`stubBoard`), never from the shared fixture board.
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

// 400 rows and many popover round trips: a busy machine needs more than 30s.
test.describe.configure({ timeout: 120_000 })

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

test.describe('Owner: dense board', () => {
  test.beforeEach(async ({ page }) => {
    await stubBoard(page, ownerSeeds())
    await openHome(page)
    await expect(row(page, 'fb-own-1')).toBeAttached({ timeout: 30_000 })
  })

  test('S7 + C28 + C34 + C29: 8 projects + "22 more" flyout; Source by name; the popover holds its height through the flyout and grows only for its footer', async ({ page }) => {
    await openFilterMenu(page)
    const proj = filterDimRow(page, 'project').locator('.fb-val[data-filter-value]')
    await expect(proj).toHaveCount(8)
    // Board order: no saved order on a fresh browser, so projects sort by name.
    await expect(proj.first()).toHaveAttribute('data-filter-value', 'iOS App')
    await expect(filterDimRow(page, 'source').locator('.fb-val[data-filter-value]')).toHaveText([/^Local/, /^Microsoft To Do/])
    await expect(filterDimRow(page, 'priority')).toHaveCount(0)
    await settled(filterMenu(page))
    const menuH = (await box(filterMenu(page))).height
    const avail = await page.evaluate(() => window.innerHeight)
    expect(menuH).toBeLessThanOrEqual(Math.min(460, avail))
    expect(menuH).toBeGreaterThan(300)
    await filterDimRow(page, 'project').getByRole('button', { name: '22 more' }).click()
    const fly = valuesFlyout(page)
    await expect(fly).toBeVisible()
    expect((await box(filterMenu(page))).height).toBe(menuH)
    await fly.getByRole('textbox', { name: 'Search projects' }).fill('Project 20')
    await fly.locator('[data-filter-value="Project 20"]').click()
    await expect(filterChip(page, 'project')).toContainText('Project 20')
    // The first chip brings the footer in: the box grows by that row (F14) and then holds.
    await expect(filterMenu(page).locator('.fb-menu-foot')).toBeVisible()
    const withFoot = (await box(filterMenu(page))).height
    expect(withFoot).toBeGreaterThan(menuH)
    expect(withFoot - menuH).toBeLessThanOrEqual(48)
    await page.screenshot({ path: `${SHOTS}/filter-row-dense.png`, clip: await clipAround(page) })
    await page.keyboard.press('Escape')
    await expect(fly).toHaveCount(0)
    await expect(filterMenu(page)).toBeVisible()
    expect((await box(filterMenu(page))).height).toBe(withFoot)
  })

  test('S8 + C26 + C26b + C27: typing goes straight to a value, Enter only adds, Escape clears then closes', async ({ page }) => {
    await openFilterMenu(page)
    const search = filterMenu(page).getByRole('textbox', { name: 'Search filters' })
    await expect(search).toBeFocused()
    await search.fill('project 2')
    await expect(page.locator('.fb-search-results [role="option"]').first()).toBeVisible()
    await search.fill('Project 21')
    const hits = page.locator('.fb-search-results [role="option"]')
    await expect(hits).toHaveCount(1)
    await expect(hits.first()).toHaveAttribute('data-filter-value', 'Project 21')
    await search.press('Enter')
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
    await expect(page.locator('.fb-search-results')).toContainText('No filter matches "zzqq"')
    await page.keyboard.press('Escape')
    await expect(search).toHaveValue('')
    await expect(filterMenu(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(filterMenu(page)).toHaveCount(0)
    expect(await focusedLabel(page)).toBe('Filter')
  })

  test('S9 + C53 + C31: a click replaces, the square adds, Only and Remove filter in the chip menu', async ({ page }) => {
    await addFilter(page, 'project', 'Walnut', { keepOpen: true })
    await filterValue(page, 'project', 'iOS App').click()
    await expect(filterChip(page, 'project').locator('.fb-chip-val')).toHaveText('iOS App')
    await filterDimRow(page, 'project').getByRole('checkbox', { name: 'Add Project 01' }).click()
    await expect(filterChip(page, 'project').locator('.fb-chip-val')).toHaveText('iOS App, Project 01')
    await closeFilterMenu(page)
    await filterChip(page, 'project').locator('.fb-chip-body').click()
    const menu = page.locator('.fb-chip-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('textbox', { name: 'Search projects' })).toBeFocused()
    const optRow = menu.locator('.fb-opt').filter({ has: page.locator('[data-filter-value="Project 01"]') })
    await optRow.locator('.fb-opt-body').focus()
    await expect(optRow.getByRole('button', { name: 'Only Project 01' })).toBeVisible()
    await optRow.getByRole('button', { name: 'Only Project 01' }).click()
    await expect(filterChip(page, 'project').locator('.fb-chip-val')).toHaveText('Project 01')
    await menu.getByRole('button', { name: 'Remove filter' }).click()
    await expect(filterChip(page, 'project')).toHaveCount(0)
    await expect(menu).toHaveCount(0)
  })
})

test.describe('Owner: Recent, tags, counts', () => {
  test.beforeEach(async ({ page }) => {
    await stubBoard(page, ownerSeeds())
    await openHome(page)
    await expect(row(page, 'fb-own-1')).toBeAttached({ timeout: 30_000 })
  })

  test('S6 + C33 + C68: Recent remembers ids, draws them in words, and one click applies', async ({ page }) => {
    await openFilterMenu(page)
    await expect(page.locator('.fb-menu [data-filter-dim="recent"]')).toHaveCount(0)
    await closeFilterMenu(page)
    await addFilter(page, 'project', 'Walnut')
    await addFilter(page, 'source', 'Microsoft To Do')
    await setStatus(page, ['To Do', 'In Progress', 'Need Action', 'Complete'])
    await addFilter(page, 'date', 'Starting within 7 days')
    await filterRow(page).getByRole('button', { name: 'Clear all filters' }).click()
    await openFilterMenu(page)
    const recent = page.locator('.fb-menu [data-filter-dim="recent"] .fb-val')
    await expect(recent).toHaveText(['Date: Starting within 7 days', 'Status: Open, Complete', 'Source: Microsoft To Do', 'Project: Walnut'])
    expect((await recent.allInnerTexts()).join(' ')).not.toMatch(/this-week|COMPLETE|ms-todo/)
    await recent.filter({ hasText: 'Status: Open, Complete' }).click()
    await expect(filterChip(page, 'status')).toContainText('Open, Complete')
    await recent.filter({ hasText: 'Project: Walnut' }).click()
    await expect(filterChip(page, 'project').locator('.fb-chip-val')).toHaveText('Walnut')
    await expect(recent.filter({ hasText: 'Project: Walnut' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('C60: a plain tag reads without its label: prefix in the popover, the search, the chip and Recent', async ({ page }) => {
    await openFilterMenu(page)
    await expandMoreFilters(page)
    await expect(filterDimRow(page, 'tags').locator('.fb-val[data-filter-value]')).toHaveCount(12)
    await expect(filterDimRow(page, 'tags').getByRole('button', { name: '68 more' })).toBeVisible()
    await filterValue(page, 'tags', 't03').click()
    await expect(filterChip(page, 'tags').locator('.fb-chip-val')).toHaveText('t03')
    await filterMenu(page).getByRole('textbox', { name: 'Search filters' }).fill('t03')
    await expect(page.locator('.fb-search-results [role="option"][data-filter-dim="tags"]').first()).toHaveAttribute('data-filter-value', 't03')
    await closeFilterMenu(page)
    await openFilterMenu(page)
    await expect(page.locator('.fb-menu [data-filter-dim="recent"]')).toContainText('Tags: t03')
    const text = `${await filterRow(page).innerText()} ${await filterMenu(page).innerText()}`
    expect(text).not.toContain('label:')
  })

  test('S11 + C43: the count follows every change; facet counts follow the other dimensions', async ({ page }) => {
    await openFilterMenu(page)
    const p01 = filterValue(page, 'project', 'Project 01').locator('.tp-count')
    await expect(p01).toHaveText('14')
    await filterValue(page, 'source', 'Microsoft To Do').click()
    // Project 01 = task 2, 32, 62...; Microsoft To Do = every 4th task: both = 32, 92, ... 392, 7 tasks.
    await expect(p01).toHaveText('7')
    await filterValue(page, 'project', 'Project 01').click()
    await expect(page.getByTestId('filter-count')).toHaveText('7 tasks')
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
      await filterDimRow(page, 'project').getByRole('button', { name: '22 more' }).click()
      await settled(valuesFlyout(page))
      await inside(valuesFlyout(page))
      await page.keyboard.press('Escape')
      await filterValue(page, 'project', 'iOS App').click()
      await closeFilterMenu(page)
      await filterChip(page, 'project').locator('.fb-chip-body').click()
      await settled(page.locator('.fb-chip-menu'))
      await inside(page.locator('.fb-chip-menu'))
      await page.keyboard.press('Escape')
      await expect(page.locator('.fb-chip-menu')).toHaveCount(0)
      await openDisplayMenu(page)
      await settled(page.locator('.dm-menu'))
      await inside(page.locator('.dm-menu'))
    })
  }

  test('C19: pressing inside the popover, a flyout or a chip menu never drags a row or closes the parent', async ({ page }) => {
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
    await drag(filterDimRow(page, 'status'))
    expect(await moved()).toBe(false)
    await expect(filterMenu(page)).toBeVisible()
    await filterDimRow(page, 'project').getByRole('button', { name: '22 more' }).click()
    await drag(valuesFlyout(page).locator('.fb-list-rows'))
    await valuesFlyout(page).locator('[data-filter-value="Project 05"]').click()
    await expect(filterMenu(page)).toBeVisible()
    await expect(valuesFlyout(page)).toBeVisible()
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
    await openFilterMenu(page)
    await expect(filterRow(page)).toBeVisible()
    const b = await page.evaluate(([id]) => document.querySelector(`.todo-panel-list [data-task-id="${id}"]`)!.getBoundingClientRect().y, [a.id])
    expect(Math.abs(b - a.y)).toBeLessThanOrEqual(2)
    await closeFilterMenu(page)
    await expect(filterRow(page)).toHaveCount(0)
    const c = await page.evaluate(([id]) => document.querySelector(`.todo-panel-list [data-task-id="${id}"]`)!.getBoundingClientRect().y, [a.id])
    expect(Math.abs(c - a.y)).toBeLessThanOrEqual(2)
  })
})

test('C28: one task with no project adds Inbox as the first value and "23 more"', async ({ page }) => {
  await stubBoard(page, ownerSeeds(true))
  await openHome(page)
  await expect(row(page, 'fb-own-1')).toBeAttached({ timeout: 30_000 })
  await openFilterMenu(page)
  const proj = filterDimRow(page, 'project').locator('.fb-val[data-filter-value]')
  await expect(proj).toHaveCount(8, { timeout: 15_000 })
  await expect(proj.first()).toHaveAttribute('data-filter-value', 'Inbox')
  await expect(proj.first()).toHaveAttribute('title', 'Tasks with no project')
  await expect(filterDimRow(page, 'project').getByRole('button', { name: '23 more' })).toBeVisible()
})

test('F03: opening Filter with no chip moves nothing; a pointer removal holds the row height until the pointer leaves', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await stubBoard(page, ownerSeeds(), [], { tabBar: true })
  await openHome(page)
  await expect(row(page, 'fb-own-1')).toBeAttached({ timeout: 30_000 })
  const tabsY = () => page.locator('.todo-section-tabs').first().evaluate((el) => Math.round(el.getBoundingClientRect().y))
  const y0 = await tabsY()
  // Open with nothing set: the row floats over the tab bar, the list stays put.
  await openFilterMenu(page)
  await expect(filterRow(page)).toContainText('No filters yet')
  expect(Math.abs((await tabsY()) - y0)).toBeLessThanOrEqual(1)
  const rowBox = await box(filterRow(page))
  expect((await box(filterMenu(page))).y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 1)
  await closeFilterMenu(page)
  expect(Math.abs((await tabsY()) - y0)).toBeLessThanOrEqual(1)
  // Three chips, then remove the first with the pointer: the next x does not move up.
  await addFilter(page, 'project', 'iOS App')
  await addFilter(page, 'source', 'Local')
  await setStatus(page, ['To Do', 'In Progress', 'Need Action', 'Waiting'])
  await closeFilterMenu(page)
  const yChips = await tabsY()
  await filterChip(page, 'status').locator('.fb-chip-x').click()
  await expect(filterChip(page, 'status')).toHaveCount(0)
  expect(Math.abs((await tabsY()) - yChips)).toBeLessThanOrEqual(1)
  await page.mouse.move(900, 700)
  await expect.poll(tabsY).toBeLessThan(yChips + 1)
})
