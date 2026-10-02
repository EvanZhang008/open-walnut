/**
 * E2E: the home board wired to the Filter bar (spec D10, 4.3 to 4.8, 5.3, 5.6,
 * 5.8, 5.10 to 5.12, 6.4 Clear, 6.8; checklist C8 to C10, C25, C30, C39, C44 to
 * C46, C48, C49, C51, C54, C59, C62, C65, C67, C69, C70). One predicate decides
 * every surface: a Project chip scopes the pin area, Pinned, tier views and the
 * list alike, the filter row count equals the tab badge and the hit rows, the
 * footer counts follow the chips, and the chips survive a reload.
 *
 * The fixture board is shared, so every test seeds its own projects with a run
 * stamp (`Garden <stamp>`) and filters to them; prefs are isolated per test.
 */
import { test, expect } from '@playwright/test'
import { openListProject } from './todo-panel-helpers'
import { MIA, MIA_PINS, stubBoard } from './filter-bar-fixtures'
import { openHome } from './home-navigation-helpers'
import { addFilter, displayButton, filterChip, filterRow, openDisplayMenu, removeFilterChip, setStatus } from './filter-bar-helpers'
import { SHOTS, runStamp, boot, seed, cleanup, row, card, anyRow, tab, tabCount, footer, hitIds, selectTab, filterProjects, panelClip } from './filter-bar-board-helpers'

test.setTimeout(150_000)

test.describe('one predicate for every view', () => {
  test('a Project chip scopes the pin area, Pinned and Focus; count = badge = hit rows (C45, C48, C25, C30)', async ({ page, baseURL }) => {
    const stamp = runStamp()
    const home = `Home ${stamp}`
    const garden = `Garden ${stamp}`
    const homeIds = await seed(page, home, [
      { title: `home a ${stamp}`, pin: 'focus' }, { title: `home b ${stamp}` }, { title: `home c ${stamp}` },
    ])
    const gardenIds = await seed(page, garden, [{ title: `garden a ${stamp}`, pin: 'focus' }, { title: `garden b ${stamp}` }])
    await boot(page, baseURL!)
    try {
      await filterProjects(page, [garden])
      await expect(filterChip(page, 'project')).toContainText(garden)
      // C30: one project = query.projects + the tab bookmark, activeProject never set.
      expect(await page.evaluate(() => localStorage.getItem('walnut-todo-active-tab'))).toBe(garden)
      await expect(card(page, gardenIds[0])).toBeVisible()
      for (const id of homeIds) await expect(anyRow(page, id)).toHaveCount(0)
      await openListProject(page, garden)
      await expect(row(page, gardenIds[1])).toBeVisible()
      // C25 + C48 in All (pin area + list, deduped): 2 tasks everywhere.
      await expect(page.getByTestId('filter-count')).toHaveText('2 tasks')
      expect(await tabCount(page, 'All')).toBe(2)
      expect((await hitIds(page)).sort()).toEqual([...gardenIds].sort())
      await expect(page.getByTestId('filter-count')).not.toContainText(' of ')

      await selectTab(page, 'Pinned')
      await expect(card(page, gardenIds[0])).toBeVisible()
      await expect(card(page, homeIds[0])).toHaveCount(0)
      await expect(page.getByTestId('filter-count')).toHaveText('1 task')
      expect(await tabCount(page, 'Pinned')).toBe(1)
      expect(await hitIds(page)).toEqual([gardenIds[0]])

      // Focus through Display (the tab bar has only All and Pinned for a new user).
      await openDisplayMenu(page)
      const more = page.locator('.dm-menu').getByRole('button', { name: /^More views/ })
      await more.click()
      await page.locator('.dm-views-flyout [data-view-option="focus"]').click()
      await page.keyboard.press('Escape')
      await expect(card(page, gardenIds[0])).toBeVisible()
      await expect(card(page, homeIds[0])).toHaveCount(0)
      await expect(page.getByTestId('filter-count')).toHaveText('1 task')

      // Two projects: the pin area is scoped the same way; the bookmark clears.
      await selectTab(page, 'All').catch(async () => { await openDisplayMenu(page); await page.locator('.dm-menu [data-view-option="all"]').click(); await page.keyboard.press('Escape') })
      await addFilter(page, 'project', home, { add: true })
      await expect(filterChip(page, 'project')).toContainText(garden)
      await expect(filterChip(page, 'project')).toContainText(home)
      await expect(card(page, homeIds[0])).toBeVisible()
      await expect(page.getByTestId('filter-count')).toHaveText('5 tasks')
      expect(await page.evaluate(() => localStorage.getItem('walnut-todo-active-tab'))).toBe('')
    } finally {
      await cleanup(page, [...homeIds, ...gardenIds])
    }
  })
})

test.describe('Status, footer and persistence', () => {
  test('Complete, Waiting and Need Action really show their rows; footer is a second door (C8, C9, C10, C49)', async ({ page, baseURL }) => {
    const stamp = runStamp()
    const garden = `Garden ${stamp}`
    const home = `Home ${stamp}`
    const [open, waiting, done, need] = await seed(page, garden, [
      { title: `g open ${stamp}` }, { title: `g wait ${stamp}`, phase: 'WAITING' },
      { title: `g done ${stamp}`, phase: 'COMPLETE' }, { title: `g need ${stamp}`, phase: 'NEED_ACTION' },
    ])
    const homeIds = await seed(page, home, [{ title: `h done ${stamp}`, phase: 'COMPLETE' }, { title: `h wait ${stamp}`, phase: 'WAITING' }])
    await boot(page, baseURL!)
    try {
      await filterProjects(page, [garden])
      await openListProject(page, garden)
      await expect(row(page, open)).toBeVisible()
      await expect(row(page, done)).toHaveCount(0)
      await expect(row(page, waiting)).toHaveCount(0)
      // C49: the footer counts follow the Project chip (Home's done and waiting do not count).
      await expect(page.getByTestId('todo-filter-footer-completed')).toHaveText('1 Complete hidden')
      await expect(page.getByTestId('todo-filter-footer-waiting')).toHaveText('1 Waiting hidden')
      const text = (await footer(page).textContent()) ?? ''
      expect(text).not.toMatch(/\u00D7|deferred| \u00B7 /)
      await expect(page.getByTestId('todo-filter-footer-phase')).toHaveCount(0)

      // C9: the footer door and the Status door give the same chip and list.
      await page.getByTestId('todo-filter-footer-waiting').click()
      await expect(filterChip(page, 'status')).toContainText('Open, Waiting')
      await expect(row(page, waiting)).toBeVisible()
      await expect(page.getByTestId('todo-filter-footer-waiting')).toHaveText('1 Waiting shown')
      await removeFilterChip(page, 'status')
      await expect(row(page, waiting)).toHaveCount(0)
      await setStatus(page, ['To Do', 'In Progress', 'Need Action', 'Waiting'])
      await expect(filterChip(page, 'status')).toContainText('Open, Waiting')
      await expect(row(page, waiting)).toBeVisible()

      // C8: Open + Complete shows the done row; the footer says shown.
      await setStatus(page, ['To Do', 'In Progress', 'Need Action', 'Complete'])
      await expect(filterChip(page, 'status')).toContainText('Open, Complete')
      await expect(row(page, done)).toBeVisible()
      await expect(page.getByTestId('todo-filter-footer-completed')).toHaveText('1 Complete shown')

      // C10: Complete alone shows only completed rows; Need Action alone only those.
      await setStatus(page, ['Complete'])
      await expect(filterChip(page, 'status')).toHaveText(/Complete/)
      await expect(row(page, done)).toBeVisible()
      await expect(row(page, open)).toHaveCount(0)
      await expect(row(page, need)).toHaveCount(0)
      await setStatus(page, ['Need Action'])
      await expect(row(page, need)).toBeVisible()
      await expect(row(page, open)).toHaveCount(0)
      await expect(row(page, done)).toHaveCount(0)
      await expect(page.getByTestId('filter-count')).toHaveText('1 task')
    } finally {
      await cleanup(page, [open, waiting, done, need, ...homeIds])
    }
  })

  test('the footer offers not-available tasks only under the default Date (C39)', async ({ page, baseURL }) => {
    const stamp = runStamp()
    const garden = `Garden ${stamp}`
    const ids = await seed(page, garden, [{ title: `g now ${stamp}` }, { title: `g later ${stamp}`, start: '2099-01-01' }])
    await boot(page, baseURL!)
    try {
      await filterProjects(page, [garden])
      await openListProject(page, garden)
      const item = page.getByTestId('todo-filter-footer-date')
      await expect(item).toHaveText('1 not available yet: show')
      await item.click()
      await expect(filterChip(page, 'date')).toContainText('Any date')
      await expect(row(page, ids[1])).toBeVisible()
      await expect(item).toHaveCount(0)
      await removeFilterChip(page, 'date')
      await expect(row(page, ids[1])).toHaveCount(0)
      await expect(item).toHaveText('1 not available yet: show')
      await addFilter(page, 'date', 'overdue')
      await expect(page.getByTestId('todo-filter-footer-date')).toHaveCount(0)
    } finally {
      await cleanup(page, ids)
    }
  })

  test('chips survive a reload, first frame already narrowed; a project without open tasks stays (C46, C30)', async ({ page, baseURL }) => {
    const stamp = runStamp()
    const garden = `Garden ${stamp}`
    const empty = `Empty ${stamp}`
    const ids = await seed(page, garden, [{ title: `g done ${stamp}`, phase: 'COMPLETE' }, { title: `g open ${stamp}` }])
    const emptyIds = await seed(page, empty, [{ title: `e done ${stamp}`, phase: 'COMPLETE' }])
    await boot(page, baseURL!)
    try {
      await filterProjects(page, [garden, empty])
      await setStatus(page, ['Complete'])
      await expect(row(page, ids[0])).toBeVisible()
      const before = {
        badge: await page.getByTestId('filter-badge').textContent(),
        hits: (await hitIds(page)).sort(),
      }
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('walnut-todo-filters') ?? '{}'))
      expect(stored.v).toBe(1)
      expect(stored.projects).toEqual([garden, empty])
      expect(before.hits).toEqual([ids[0], emptyIds[0]].sort())
      // The first committed frame after reload must already be narrowed: record
      // whether this run's open row ever mounts.
      await page.addInitScript((openId) => {
        const seen = { open: false }
        ;(window as unknown as { __pwSeen: typeof seen }).__pwSeen = seen
        new MutationObserver(() => {
          if (document.querySelector(`[data-task-id="${openId}"]`)) seen.open = true
        }).observe(document, { childList: true, subtree: true })
      }, ids[1])
      await page.reload()
      await expect(displayButton(page)).toBeVisible({ timeout: 60_000 })
      await expect(page.getByTestId('filter-badge')).toHaveText(before.badge ?? '')
      await expect(row(page, ids[0])).toBeVisible({ timeout: 30_000 })
      expect((await hitIds(page)).sort()).toEqual(before.hits)
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('walnut-todo-filters') ?? '{}'))).toEqual(stored)
      expect(await page.evaluate(() => (window as unknown as { __pwSeen: { open: boolean } }).__pwSeen.open)).toBe(false)
    } finally {
      await cleanup(page, [...ids, ...emptyIds])
    }
  })
})

test.describe('Clear, empty state and the archive', () => {
  test('0 hits shows the filter empty state; Clear is undoable and a new chip ends the toast (C25, C54)', async ({ page, baseURL }) => {
    // A stubbed board (filter-bar-fixtures): two sources and a tag, which the
    // shared fixture board does not guarantee.
    await stubBoard(page, [
      ...MIA,
      { id: 'fb-d-ms1', title: 'Order seeds', project: 'Garden', source: 'ms-todo', tags: ['label:urgent'] },
      { id: 'fb-d-w1', title: 'Wait for the frost', project: 'Home', phase: 'WAITING', tags: ['label:urgent'] },
    ], MIA_PINS, { tabBar: true })
    await openHome(page, baseURL!, 90_000)
    await expect(anyRow(page, 'fb-mia-h1').first()).toBeVisible({ timeout: 20_000 })
    await filterProjects(page, ['Home', 'Garden'])
    await setStatus(page, ['Need Action'])
    const empty = page.getByTestId('todo-filter-empty')
    await expect(empty).toContainText('No tasks match these filters')
    await expect(page.getByTestId('filter-count')).toHaveAttribute('aria-label', '0 tasks')
    await page.screenshot({ path: `${SHOTS}/empty-match.png`, clip: await panelClip(page) })
    await setStatus(page, ['To Do', 'Waiting'])
    await addFilter(page, 'source', 'Local')
    await addFilter(page, 'tags', 'urgent')
    await expect(page.getByTestId('filter-badge')).toHaveText('4')
    const storedBefore = await page.evaluate(() => localStorage.getItem('walnut-todo-filters'))
    const hitsBefore = (await hitIds(page)).sort()
    expect(hitsBefore).toEqual(['fb-d-w1'])

    await filterRow(page).getByRole('button', { name: 'Clear all filters' }).click()
    await expect(filterRow(page)).toHaveCount(0)
    const toast = page.locator('.notification-toast').filter({ hasText: 'Filters cleared' }).first()
    await expect(toast).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/clear-undo-toast.png`, clip: await panelClip(page, toast) })
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByTestId('filter-badge')).toHaveText('4')
    expect(await page.evaluate(() => localStorage.getItem('walnut-todo-filters'))).toBe(storedBefore)
    expect((await hitIds(page)).sort()).toEqual(hitsBefore)
    await expect(filterChip(page, 'status')).toContainText('To Do, Waiting')

    // The empty state's own button runs the same Clear.
    await setStatus(page, ['Need Action'])
    await page.getByTestId('todo-filter-empty').getByRole('button', { name: 'Clear filters' }).click()
    await expect(page.getByTestId('todo-filter-empty')).toHaveCount(0)
    await expect(filterRow(page)).toHaveCount(0)
    await expect(toast).toBeVisible()
    // A chip added after Clear takes the toast down (Undo would overwrite it).
    await addFilter(page, 'project', 'Garden')
    await expect(page.locator('.notification-toast').filter({ hasText: 'Filters cleared' })).toHaveCount(0)
  })

  test('a failed archive load keeps the chip and the loaded rows, with one toast (C44, C8)', async ({ page, baseURL }) => {
    const stamp = runStamp()
    const garden = `Garden ${stamp}`
    const ids = await seed(page, garden, [{ title: `g done ${stamp}`, phase: 'COMPLETE' }, { title: `g open ${stamp}` }])
    await boot(page, baseURL!)
    try {
      await filterProjects(page, [garden])
      let failed = 0
      // The archive fetch is the list read WITHOUT the recent-completed window.
      await page.route(/\/api\/tasks(\?|$)/, async (route) => {
        const url = route.request().url()
        if (route.request().method() === 'GET' && url.includes('fields=list') && !url.includes('ids=') && !url.includes('completedWithinDays')) {
          failed += 1
          await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"archive unavailable"}' })
          return
        }
        await route.continue()
      })
      await setStatus(page, ['To Do', 'In Progress', 'Need Action', 'Complete'])
      await expect(filterChip(page, 'status')).toContainText('Open, Complete')
      const toast = page.getByText('Could not load older completed tasks. Showing the ones already loaded.')
      await expect(toast).toHaveCount(1, { timeout: 45_000 })
      expect(failed).toBeGreaterThan(0)
      await expect(filterChip(page, 'status')).toContainText('Open, Complete')
      await openListProject(page, garden)
      await expect(row(page, ids[0])).toBeVisible()
    } finally {
      await page.unroute(/\/api\/tasks(\?|$)/)
      await cleanup(page, ids)
    }
  })
})
