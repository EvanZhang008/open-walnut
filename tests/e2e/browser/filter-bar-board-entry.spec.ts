/**
 * E2E: the home board's entry points into the Filter bar (spec 5.10 to 5.12,
 * 6.8; checklist C51, C59, C62, C65, C67, C69, C70). Split from
 * filter-bar-board.spec.ts so each file stays under 500 lines.
 */
import { test, expect, type Page } from '@playwright/test'
import { openListProject } from './todo-panel-helpers'
import { draftComposer, openDraft } from './draft-helpers'
import { openHome } from './home-navigation-helpers'
import { closeFilterMenu, filterChip, filterMenu, filterRow, openDisplayMenu, openFilterMenu } from './filter-bar-helpers'
import { panelClip, SHOTS, QUICK_VIEWS_KEY, runStamp, boot, seed, cleanup, row, card, anyRow, tab, selectTab, filterProjects, type Seed } from './filter-bar-board-helpers'

test.setTimeout(150_000)

const TIER_WORDS = /\b(Focus|Satellite|Backlog|Parked)\b/

test.describe('board entry points', () => {
  test('a new user sees no tier heading, also with two tiers holding tasks, until a tier is picked (C51, F08)', async ({ page, baseURL }) => {
    const stamp = runStamp()
    const home = `Home ${stamp}`
    const garden = `Garden ${stamp}`
    const homeIds = await seed(page, home, [{ title: `home a ${stamp}`, pin: 'satellite' }, { title: `home b ${stamp}` }, { title: `home c ${stamp}` }])
    const gardenIds = await seed(page, garden, [{ title: `garden a ${stamp}`, pin: 'satellite' }, { title: `garden b ${stamp}` }])
    await boot(page, baseURL!)
    try {
      // The shared fixture board has pins of its own: narrow to this run's board.
      await filterProjects(page, [home, garden])
      await expect(card(page, homeIds[0])).toBeVisible()
      await expect(card(page, gardenIds[0])).toBeVisible()
      expect(await page.evaluate(() => localStorage.getItem('walnut-todo-tier-used'))).toBeNull()
      const text = await page.locator('.todo-panel').innerText()
      expect(text).not.toMatch(TIER_WORDS)
      await expect(page.locator('.todo-pinned-sublabel')).toHaveCount(0)
      // With no tier heading to stick under, a project label sits above its first card, not over it.
      await expect(page.locator('.todo-pinned-section .tier-project-label')).toHaveCount(2)
      const overlaps = await page.evaluate(() => [...document.querySelectorAll('.todo-pinned-section .tier-project-label')]
        .filter((el) => {
          const next = el.nextElementSibling
          return !!next && el.getBoundingClientRect().bottom > next.getBoundingClientRect().top + 1
        }).length)
      expect(overlaps).toBe(0)
      await page.screenshot({ path: `${SHOTS}/mia-pinned-no-tier.png`, clip: await panelClip(page) })
      await selectTab(page, 'Pinned')
      expect(await page.locator('.todo-panel').innerText()).not.toMatch(TIER_WORDS)

      // F08: a second tier with tasks (a new task from a draft lands in Focus) still
      // names no tier: the user never picked one.
      expect((await page.request.put(`/api/focus/tasks/${gardenIds[0]}/tier`, { data: { tier: 'focus' } })).ok()).toBe(true)
      await expect(page.locator(`.todo-focus-card[data-task-id="${gardenIds[0]}"]`)).toBeVisible({ timeout: 15_000 })
      await expect(card(page, homeIds[0])).toBeVisible()
      expect(await page.locator('.todo-panel').innerText()).not.toMatch(TIER_WORDS)
      await expect(page.locator('.todo-pinned-sublabel')).toHaveCount(0)
      // A task in Parked means the board has tiers on purpose: every tier names itself.
      expect((await page.request.post(`/api/focus/tasks/${homeIds[1]}`)).ok()).toBe(true)
      expect((await page.request.put(`/api/focus/tasks/${homeIds[1]}/tier`, { data: { tier: 'wait' } })).ok()).toBe(true)
      await expect(page.locator('.todo-pinned-sublabel', { hasText: 'Parked' })).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('.todo-pinned-sublabel', { hasText: 'Focus' })).toBeVisible()
      expect((await page.request.delete(`/api/focus/tasks/${homeIds[1]}`)).ok()).toBe(true)
      await expect(page.locator('.todo-pinned-sublabel')).toHaveCount(0, { timeout: 15_000 })
      // Switching to a tier view marks the board as one that uses tiers; from then on
      // two tiers with tasks draw their headings.
      await openDisplayMenu(page)
      await page.locator('.dm-menu').getByRole('button', { name: /^More views/ }).click()
      await page.locator('.dm-views-flyout [data-view-option="satellite"]').click()
      await page.keyboard.press('Escape')
      expect(await page.evaluate(() => localStorage.getItem('walnut-todo-tier-used'))).toBe('1')
      await selectTab(page, 'Pinned')
      await expect(page.locator('.todo-pinned-sublabel', { hasText: 'Focus' })).toBeVisible({ timeout: 15_000 })
    } finally {
      await cleanup(page, [...homeIds, ...gardenIds])
    }
  })

  test('focus-override reasons use the chip words and each Show widens one chip (C62)', async ({ page, baseURL }) => {
    const stamp = runStamp()
    const home = `Home ${stamp}`
    const garden = `Garden ${stamp}`
    // Seed first: a task completed under 3s ago still shows in its completion grace.
    const [done] = await seed(page, garden, [{ title: `g done ${stamp}`, phase: 'COMPLETE' }])
    const doneAt = Date.now()
    const [homeTask] = await seed(page, home, [{ title: `h open ${stamp}` }])
    // Wait the grace out (TodoPanel GRACE_MS is 3150ms from completed_at): a fast boot
    // (the built SPA) otherwise opens the list while the done row is still in grace.
    await page.waitForTimeout(Math.max(0, 3_600 - (Date.now() - doneAt)))
    await boot(page, baseURL!, { 'walnut-todo-filters': filtersRecord({ projects: [garden] }) })
    try {
      await expect(filterChip(page, 'project')).toContainText(garden)
      await expect(page.getByTitle('No task has this value now')).toHaveCount(0, { timeout: 20_000 })
      // Open a task the chips hide (a search hit click is a locate, like a deep link).
      await locateBySearch(page, `g done ${stamp}`, done)
      const reasons = row(page, done).getByTestId('filter-override-reasons')
      await expect(reasons).toContainText('Hidden by Status: Open', { timeout: 20_000 })
      expect((await reasons.textContent()) ?? '').not.toMatch(/\u2260|phase| \u00B7 /)
      await reasons.getByRole('button', { name: 'Show tasks hidden by Status: Open' }).click()
      await expect(filterChip(page, 'status')).toContainText('Open, Complete')
      await expect(row(page, done).getByTestId('filter-override-reasons')).toHaveCount(0)

      // Search honors the Project chip the user added (5.7), so the Home task opens by its link.
      await openHome(page, `${baseURL}/?task=${homeTask}`, 90_000)
      const projectReason = row(page, homeTask).getByTestId('filter-override-reasons')
      await expect(projectReason).toContainText(`Hidden by Project: ${garden}`, { timeout: 20_000 })
      await projectReason.getByRole('button', { name: `Show tasks hidden by Project: ${garden}` }).click()
      await expect(filterChip(page, 'project')).toContainText(`${garden}, ${home}`)
    } finally {
      await cleanup(page, [done, homeTask])
    }
  })
})

/** Search for a title, click its hit (a user locate), then clear the search. */
async function locateBySearch(page: Page, title: string, id: string): Promise<void> {
  await page.locator('.todo-search-input').fill(title)
  const hitRow = page.locator(`.todo-search-results .todo-panel-item[data-task-id="${id}"]`)
  await expect(hitRow).toBeVisible({ timeout: 15_000 })
  await hitRow.locator('.todo-item-title, .todo-panel-item-title').first().click()
  await page.locator('.todo-search-clear').click()
  await expect(page.locator('.todo-search-results')).toHaveCount(0)
}

/** A stored v1 filter record (4.8) with these overrides. */
function filtersRecord(over: Record<string, unknown>): string {
  return JSON.stringify({
    v: 1, status: ['TODO', 'IN_PROGRESS', 'NEED_ACTION'], projects: [], date: 'now', sources: [], priorities: [],
    tagsAny: [], sprints: [], time: { basis: 'updated', preset: null, customValue: 24, customUnit: 'hours' }, ...over,
  })
}

test.describe('shortcuts, menus and overlays', () => {
  test('the project heading filters to itself; F opens Filter in Search filters (C65)', async ({ page, baseURL }) => {
    const stamp = runStamp()
    const garden = `Garden ${stamp}`
    const ids = await seed(page, garden, [{ title: `g one ${stamp}` }])
    await boot(page, baseURL!)
    try {
      await selectTab(page, 'All')
      const header = page.locator('.todo-group-project-header').filter({ has: page.locator('.todo-group-project-name', { hasText: garden }) }).first()
      await expect(header).toBeVisible({ timeout: 20_000 })
      await header.click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Filter to this project' }).click()
      await expect(filterRow(page).locator('[data-chip-dim]')).toHaveCount(1)
      await expect(filterChip(page, 'project')).toContainText(garden)
      await expect(page.getByTestId('filter-badge')).toHaveText('1')

      // F with focus on the list (not in a text field) opens Filter in its search box.
      await page.locator('.todo-section-tabs').click({ position: { x: 2, y: 2 } })
      await page.keyboard.press('f')
      await expect(filterMenu(page)).toBeVisible()
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Search filters')
      await page.keyboard.type('f')
      await expect(page.getByRole('textbox', { name: 'Search filters' })).toHaveValue('f')
      await closeFilterMenu(page)
      // In the task search box F is just a letter.
      await page.locator('.todo-search-input').click()
      await page.keyboard.press('f')
      await expect(filterMenu(page)).toHaveCount(0)
      await expect(page.locator('.todo-search-input')).toHaveValue('f')
    } finally {
      await cleanup(page, ids)
    }
  })

  test('Escape and the closing click stop at the Filter and Display overlays (C69)', async ({ page, baseURL }) => {
    const stamp = runStamp()
    const garden = `Garden ${stamp}`
    const ids = await seed(page, garden, [{ title: `g one ${stamp}` }, { title: `g two ${stamp}` }])
    // A wide panel, so a row's title sits left of the right-aligned popovers.
    await boot(page, baseURL!, { 'open-walnut-todo-width': '55' })
    try {
      await filterProjects(page, [garden])
      await openListProject(page, garden)
      await row(page, ids[0]).locator('.task-kebab-btn').click()
      await page.locator('.task-kebab-menu').getByText('Select…').click()
      await expect(page.locator('.task-selection-bar')).toBeVisible()
      for (const open of [() => openFilterMenu(page), () => openDisplayMenu(page)]) {
        await open()
        await page.keyboard.press('Escape')
        await expect(filterMenu(page)).toHaveCount(0)
        await expect(page.locator('.dm-menu')).toHaveCount(0)
        await expect(page.locator('.task-selection-bar')).toBeVisible()
      }
      await page.locator('.task-selection-clear-btn').click({ timeout: 10_000 })
      await expect(page.locator('.task-selection-bar')).toHaveCount(0)

      // The press that closes a popover does not also open the task under it.
      // The Project chip's bookmark lands in the URL asynchronously: let it settle first.
      await expect(page).toHaveURL(/[?&]proj=/)
      const urlBefore = page.url()
      for (const open of [() => openFilterMenu(page), () => openDisplayMenu(page)]) {
        await open()
        await row(page, ids[1]).locator('.todo-item-title').first().click({ position: { x: 4, y: 6 }, timeout: 10_000 })
        await expect(filterMenu(page)).toHaveCount(0)
        await expect(page.locator('.dm-menu')).toHaveCount(0)
        expect(page.url()).toBe(urlBefore)
        await expect(row(page, ids[1])).not.toHaveClass(/task-focused/)
      }
    } finally {
      await cleanup(page, ids)
    }
  })

  test('the panel root keeps container-type normal; the toolbar scope is inline-size (C67)', async ({ page, baseURL }) => {
    await boot(page, baseURL!)
    const types = await page.evaluate(() => ({
      panel: getComputedStyle(document.querySelector('.todo-panel')!).containerType,
      scope: getComputedStyle(document.querySelector('.fb-toolbar-scope')!).containerType,
    }))
    expect(types).toEqual({ panel: 'normal', scope: 'inline-size' })
    // Toolbar order: Search, New, Filter, Display, Hide panel (C2); no View options (C1).
    const order = await page.locator('.todo-panel-toolbar').evaluate((bar) =>
      [...bar.querySelectorAll('input.todo-search-input, button')].map((el) => el.getAttribute('aria-label') || el.className))
    const at = (label: string) => order.indexOf(label)
    expect(at('Filter')).toBeGreaterThan(-1)
    expect(at('Filter')).toBeLessThan(at('Display'))
    expect(at('Display')).toBeLessThan(at('Hide task panel'))
    await expect(page.locator('.todo-panel button[aria-label="View options"], .vd-panel, .vd-rail, [data-rail-section]')).toHaveCount(0)
  })

  test('with the tab bar off, a non-All view shows as View: <name> in the filter row (C70 wiring)', async ({ page, baseURL }) => {
    await boot(page, baseURL!, { [QUICK_VIEWS_KEY]: 'false' })
    await expect(filterRow(page)).toHaveCount(0)
    await openDisplayMenu(page)
    await page.locator('.dm-menu [data-view-option="pinned"]').click()
    await page.keyboard.press('Escape')
    const item = filterRow(page).locator('.fb-view-item')
    await expect(item).toContainText('Pinned')
    await expect(page.getByTestId('filter-badge')).toHaveCount(0)
    await item.click()
    await expect(page.locator('.dm-menu')).toBeVisible()
    await page.locator('.dm-menu [data-view-option="all"]').click()
    await page.keyboard.press('Escape')
    await expect(filterRow(page)).toHaveCount(0)
  })
})

test('a task created outside the chips stays with an Outside filters pill and a Show toast (C59)', async ({ page, baseURL }) => {
  const stamp = runStamp()
  const garden = `Garden ${stamp}`
  const ids = await seed(page, garden, [{ title: `g one ${stamp}` }])
  await boot(page, baseURL!)
  try {
    await filterProjects(page, [garden])
    const panel = await openDraft(page)
    await draftComposer(page).fill(`new outside ${stamp}`)
    // Save as todo (no session); pinned or not, the board must keep it on screen.
    const created = page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/tasks')
    await panel.locator('.draft-later-btn').click()
    const id = ((await (await created).json()) as { task: { id: string } }).task.id
    ids.push(id)
    const toast = page.locator('.notification-toast').filter({ hasText: `Saved to Inbox. Hidden by Project: ${garden}` })
    await expect(toast).toBeVisible({ timeout: 15_000 })
    const newRow = anyRow(page, id).first()
    await expect(newRow).toBeVisible()
    await expect(newRow.getByTestId('filter-outside-pill')).toHaveText('Outside filters')
    // F33: one message per create (this toast replaced "Task created"), and it lasts
    // long enough to reach Show (F07: it used to leave after about 3s).
    await expect(page.locator('.notification-toast').filter({ hasText: 'Task created' })).toHaveCount(0)
    await page.waitForTimeout(4500)
    await expect(toast).toBeVisible()
    await toast.getByRole('button', { name: 'Show' }).click()
    await expect(filterChip(page, 'project')).toContainText(`${garden}, Inbox`)
    await expect(newRow.getByTestId('filter-outside-pill')).toHaveCount(0)
  } finally {
    await cleanup(page, ids)
  }
})

test('in the Pinned view a task created outside the chips keeps its card and pill (F07)', async ({ page, baseURL }) => {
  const stamp = runStamp()
  const garden = `Garden ${stamp}`
  const ids = await seed(page, garden, [{ title: `g pin ${stamp}`, pin: 'satellite' }])
  await boot(page, baseURL!)
  try {
    await filterProjects(page, [garden])
    await selectTab(page, 'Pinned')
    const panel = await openDraft(page)
    await draftComposer(page).fill(`pinned outside ${stamp}`)
    const created = page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/tasks')
    await panel.locator('.draft-later-btn').click()
    const id = ((await (await created).json()) as { task: { id: string } }).task.id
    ids.push(id)
    // A draft lands pinned: the Pinned view draws it with its pill, not only a toast.
    const newCard = card(page, id).first()
    await expect(newCard).toBeVisible({ timeout: 15_000 })
    await expect(newCard.getByTestId('filter-outside-pill')).toHaveText('Outside filters')
    // Not a hit: the count and the badge leave it out (4.6).
    await expect(page.getByTestId('filter-count')).toHaveText('1 task')
  } finally {
    await cleanup(page, ids)
  }
})
