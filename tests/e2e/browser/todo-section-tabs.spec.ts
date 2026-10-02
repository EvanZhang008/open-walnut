/**
 * Todo panel section tabs.
 *
 * The panel used to be ONE vertical stack of 7 regions (Focus / Satellite / Wait /
 * hidden-groups / Recent / Tasks / Notes). With real task volume every region got a
 * few rows and the whole panel read as cramped. Now a tab strip picks ONE section
 * which owns the full panel height; `All` is kept as a tab because cross-tier drag
 * needs source and target mounted together.
 *
 * These assertions are about the LAYOUT CONTRACT, not styling:
 *   1. the strip renders its 7 tabs (Projects moved to the Display menu, the Scratchpad to the rail)
 *   2. picking a tier tab mounts that tier and UNMOUNTS the others
 *   3. the picked section actually gets the height (not a few-rows sliver)
 *   4. `All` restores the stacked view (every section header back)
 *   5. the choice survives a reload (localStorage)
 *   6. searching from a tier tab still shows results (auto-routes to Tasks)
 *   7. the bar's own menu picks the tabs, hides empty ones, and turns the bar off
 *   8. that menu lists All, Pinned and Recent first and the tiers under More views (spec 5.10)
 */

import { test, expect } from './shortcut-test-fixture'
import { type Page } from '@playwright/test'
import { isolateUiPrefs, openListProject, selectProject, selectSection, showMoreUntil } from './todo-panel-helpers'
import { closeViewMenu, openViewMenu } from './home-navigation-helpers'

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    if (localStorage.getItem('walnut-todo-collapsed-sections') === null) localStorage.setItem('walnut-todo-collapsed-sections', '[]')
  })
})

const TABS = ['All', 'Pinned', 'Focus', 'Satellite', 'Parked', 'Recent'] as const

function tab(page: Page, name: (typeof TABS)[number]) {
  return page.locator('.todo-section-tabs [role="tab"]', { hasText: name }).first()
}

/** Seed pinned tasks across all three tiers so every tier tab has real content. */
async function seedPinnedTasks(page: Page, project = 'Work') {
  const stamp = Date.now()
  const seeds = ([['focus', 3], ['satellite', 2], ['wait', 2]] as const)
    .flatMap(([tier, n]) => Array.from({ length: n }, (_, i) => ({ tier, i })))
  // One create → pin → place chain per task, all tasks at once: 21 calls in a row ran past
  // the test budget on a loaded machine.
  return Promise.all(seeds.map(async ({ tier, i }) => {
    const res = await page.request.post('/api/tasks', {
      data: { title: `tabs probe ${tier} ${i} ${stamp}`, source: 'local', project },
    })
    if (!res.ok()) throw new Error(`seed create failed: ${res.status()} ${await res.text()}`)
    const body = await res.json() as { task?: { id?: string } }
    const id = body.task?.id
    if (!id) throw new Error('seed create returned no task id')
    // Pin, then place in the target tier: two endpoints (a bare pin carries no tier and
    // reads as Satellite, so Focus is set explicitly too).
    const pin = await page.request.post(`/api/focus/tasks/${id}`)
    if (!pin.ok()) throw new Error(`seed pin failed: ${pin.status()} ${await pin.text()}`)
    const move = await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier } })
    if (!move.ok()) throw new Error(`seed tier move failed: ${move.status()} ${await move.text()}`)
    return id
  }))
}

test.describe('todo panel section tabs', () => {
  // Several steps each wait on a reload; 30s is not enough on a busy machine.
  test.describe.configure({ timeout: 120_000 })

  test('tabs swap which section owns the panel', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 20_000 })
    await seedPinnedTasks(page)
    await page.reload()

    const strip = page.locator('.todo-section-tabs')
    await expect(strip).toBeVisible({ timeout: 20_000 })

    // The Project filter is a separate axis from the section tabs; drop any Project
    // chip so no project scoping can filter the seed tasks out of the tiers.
    await selectProject(page, 'All')

    // 1. all seven tabs present (the shortcut fixture keeps every tab on the bar, empty or
    // not); All is its word plus the view's count (spec 4.6: the active tab's badge is the
    // same number as the filter row's count), and neither Projects nor the Scratchpad is a tab.
    for (const name of TABS) {
      await expect(tab(page, name)).toBeVisible()
    }
    // (Custom tiers other specs made on the shared fixture add tabs of their own.)
    await expect(page.locator('.todo-section-tabs [role="tab"]:not(.todo-section-tab-custom)')).toHaveCount(TABS.length)
    await expect(tab(page, 'All').locator('.todo-section-tab-icon')).toHaveCount(0)
    await expect(tab(page, 'All').locator('.todo-section-tab-label')).toHaveText('All')
    await expect(tab(page, 'All').locator('.todo-section-tab-count')).toHaveText(/^(\d+|99\+)$/)
    await expect(page.locator('.todo-section-tab-tasks, .todo-section-tab-notes')).toHaveCount(0)

    // 2 + 3. Focus tab: the Focus tier is mounted, the other tiers are not, and
    // the tier list gets real height rather than the old few-row sliver.
    await tab(page, 'Focus').click()
    await expect(tab(page, 'Focus')).toHaveAttribute('aria-selected', 'true')

    await expect(page.locator('.todo-pinned-wrapper-solo')).toBeVisible()
    await expect(page.locator('[data-drop-zone="focus-drop-zone"]')).toBeVisible()

    // Wait's drop zone belongs to a different tab: it must be gone from the DOM.
    await expect(page.locator('[data-drop-zone="wait-drop-zone"]')).toHaveCount(0)
    // The stacked view's section headers are gone too (the tab strip names the section).
    await expect(page.locator('.todo-pinned-header')).toHaveCount(0)
    await expect(page.locator('.todo-tasks-header')).toHaveCount(0)

    const panelBox = await page.locator('.todo-panel').boundingBox()
    const soloBox = await page.locator('.todo-pinned-section-solo').boundingBox()
    expect(panelBox).not.toBeNull()
    expect(soloBox).not.toBeNull()
    // The solo section should command most of the panel: the whole point of the
    // change. Anything under half means it's still being squeezed by siblings.
    expect(soloBox!.height).toBeGreaterThan(panelBox!.height * 0.5)

    // 2b. Wait tab: now Wait is mounted and Focus is not.
    await tab(page, 'Parked').click()
    await expect(page.locator('[data-drop-zone="wait-drop-zone"]')).toHaveCount(1)
    await expect(page.locator('[data-drop-zone="focus-drop-zone"]')).toHaveCount(0)

    // 4. All tab: the stacked view is back: Pinned + Tasks headers both render.
    await tab(page, 'All').click()
    await expect(page.locator('.todo-tasks-header')).toHaveCount(1)
    await expect(page.locator('.todo-pinned-header').first()).toBeVisible()
    await expect(page.locator('[data-drop-zone="focus-drop-zone"]')).toHaveCount(1)
    await expect(page.locator('[data-drop-zone="wait-drop-zone"]')).toHaveCount(1)
    await expect(page.locator('.todo-pinned-wrapper-solo')).toHaveCount(0)
  })

  test('the active tab survives a reload, and the retired Notes tab falls back to All', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })

    await tab(page, 'Parked').click()
    await expect(page.locator('[data-drop-zone="wait-drop-zone"]')).toHaveCount(1)

    await page.reload()
    await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })
    await expect(tab(page, 'Parked')).toHaveAttribute('aria-selected', 'true')

    // A panel that was left on the Notes tab opens on All; the Scratchpad lives in the rail now.
    await page.evaluate(() => localStorage.setItem('walnut-todo-active-section', 'notes'))
    await page.reload()
    await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
    await expect(page.locator('.todo-panel .global-notes-section')).toHaveCount(0)
  })

  test('searching from a tier tab still surfaces results', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })

    // Park on a tier tab, where the main list (the only place results render) is unmounted.
    await tab(page, 'Focus').click()
    await expect(page.locator('.todo-panel-list')).toHaveCount(0)

    // Typing a query auto-routes to the stacked All view (pinned tiers AND the
    // task list all show their matches) rather than silently showing nothing.
    await page.locator('#home-task-navigation .todo-search-input').click()
    await page.locator('.todo-search-bar input').fill('probe')
    await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.todo-panel-list')).toHaveCount(1)

    // Views stay switchable during a search: narrowing to Projects (the filter menu) is
    // ephemeral and must not overwrite the user's persisted tab.
    await selectSection(page, 'Tasks')
    await expect(page.locator('.todo-section-tabs [role="tab"][aria-selected="true"]')).toHaveCount(0)
    await expect(page.locator('.todo-panel-list')).toHaveCount(1)

    // Clearing the query drops back to the tab the user had actually picked.
    await page.locator('.todo-search-bar input').fill('')
    await expect(tab(page, 'Focus')).toHaveAttribute('aria-selected', 'true')

    // A fresh search starts from the All default again (the ephemeral Tasks
    // narrowing above must not stick).
    await page.locator('.todo-search-bar input').fill('probe')
    await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true')
  })

  test('clicking a pinned task in the Tasks list stays on the Tasks tab', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 20_000 })
    const [id] = await seedPinnedTasks(page)
    await page.reload()
    await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })

    // No Project chip, so the seed task is visible in the main list.
    await selectProject(page, 'All')

    await selectSection(page, 'Tasks')
    await expect(page.locator('.todo-section-tabs [role="tab"][aria-selected="true"]')).toHaveCount(0)

    // Click the pinned task's row in the main list: the view must NOT teleport
    // to the task's pin tier (the old behavior); the user is working in Tasks.
    // Its project starts folded (the list opens only what the user opened) and may be
    // long enough to draw in batches.
    await openListProject(page, 'Work')
    const row = page.locator(`.todo-panel-list [data-task-id="${id}"]`).first()
    await showMoreUntil(page.locator('.todo-panel-list'), row)
    await expect(row).toBeVisible()
    await row.click()
    await expect(page.locator('.todo-section-tabs [role="tab"][aria-selected="true"]')).toHaveCount(0)
    await expect(page.locator('.todo-panel-list')).toHaveCount(1)
    await expect(page.locator('.todo-pinned-wrapper-solo')).toHaveCount(0)
  })

  test('a bar nobody customised is All and Pinned by name, and the Pinned tab stacks the tiers without the project list', async ({ page }) => {
    // Undo the fixture's "every tab" seed: this test is about the untouched default.
    await page.addInitScript(() => localStorage.removeItem('walnut-todo-tab-bar-hidden-tabs'))
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 20_000 })
    await seedPinnedTasks(page)
    await page.reload()
    const strip = page.locator('.todo-section-tabs')
    await expect(strip).toBeVisible({ timeout: 20_000 })
    await selectProject(page, 'All')

    // Two built-in tabs, both spelled out: a short bar names every tab, so it says what it is.
    await expect(page.locator('.todo-section-tabs [role="tab"]:not(.todo-section-tab-custom)')).toHaveCount(2)
    await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true')
    await expect(strip).toHaveClass(/is-roomy/)
    await expect(tab(page, 'Pinned').locator('.todo-section-tab-label')).toBeVisible()
    await expect(tab(page, 'Pinned').locator('.todo-section-tab-icon svg')).toBeVisible()
    const pinnedCount = Number(await tab(page, 'Pinned').locator('.todo-section-tab-count').textContent())
    expect(pinnedCount).toBeGreaterThanOrEqual(7)
    await expect(page.locator('.todo-section-tab-focus, .todo-section-tab-satellite, .todo-section-tab-wait, .todo-section-tab-recent')).toHaveCount(0)

    // The Pinned view: the Pinned heading over tier headings and drop zones for the tiers that
    // hold a task (the All view's stack, so the view is named with the tab bar off too), no
    // Projects heading, no list, and the first card is not under a stuck heading.
    await tab(page, 'Pinned').click()
    await expect(tab(page, 'Pinned')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.home-navigation-scroll')).toHaveClass(/is-stacked/)
    await expect(page.locator('[data-drop-zone="focus-drop-zone"]')).toHaveCount(1)
    await expect(page.locator('[data-drop-zone="wait-drop-zone"]')).toHaveCount(1)
    await expect(page.locator('.todo-pinned-subgroup-heading .navigation-heading[data-navigation-id="focus"]')).toBeVisible()
    await expect(page.locator('.todo-pinned-header')).toHaveCount(1)
    await expect(page.locator('.todo-tasks-header')).toHaveCount(0)
    const firstCard = page.locator('.todo-pinned-section [data-task-id]').first()
    const cardBox = (await firstCard.boundingBox())!
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-task-id]'), { x: cardBox.x + 60, y: cardBox.y + cardBox.height / 2 })).toBe(true)
    await expect(page.locator('.todo-panel-list')).toHaveCount(0)
    await expect(page.locator('.todo-pinned-wrapper-solo')).toHaveCount(0)

    // The view survives a reload, and the Display menu offers it by name.
    await page.reload()
    await expect(tab(page, 'Pinned')).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
    await openViewMenu(page)
    await expect(page.locator('.dm-menu [data-view-option="pinned"]')).toHaveAttribute('aria-pressed', 'true')
    await closeViewMenu(page)

    // The tiers wait in the bar's menu: two more and the bar is crowded, so only the active
    // tab keeps its name.
    const barMenu = page.getByRole('button', { name: 'Tab bar options' })
    await barMenu.click()
    await page.locator('.wn-context-menu').getByRole('menuitemcheckbox', { name: 'Focus', exact: true }).click()
    await expect(tab(page, 'Focus')).toBeVisible()
    await expect(strip).toHaveClass(/is-roomy/)
    await page.locator('.wn-context-menu').getByRole('menuitemcheckbox', { name: 'Satellite', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(tab(page, 'Satellite')).toBeVisible()
    await expect(strip).not.toHaveClass(/is-roomy/)
    await expect(tab(page, 'Focus').locator('.todo-section-tab-label')).not.toBeVisible()
    await expect(tab(page, 'Pinned').locator('.todo-section-tab-label')).toBeVisible()
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('walnut-todo-tab-bar-hidden-tabs') ?? '[]'))).toEqual(['wait', 'recent'])
  })

  test('the bar menu lists All, Pinned and Recent first and every tier under More views, each with its sentence', async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem('walnut-todo-tab-bar-hidden-tabs'))
    await page.goto('/')
    await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Tab bar options' }).click()
    const menu = page.locator('.wn-context-menu')
    await expect(menu).toBeVisible()
    // Read the menu top to bottom: section headers, dividers and items in DOM order.
    const rows = await menu.locator('.wn-context-menu-section, .wn-context-menu-divider, [role="menuitemcheckbox"]').evaluateAll((els) =>
      els.map((el) => el.classList.contains('wn-context-menu-divider') ? '---'
        : el.classList.contains('wn-context-menu-section') ? `#${el.textContent?.trim()}`
          : el.querySelector('.wn-context-menu-label')?.textContent?.trim() ?? ''))
    const moreAt = rows.indexOf('#More views')
    expect(moreAt).toBeGreaterThan(0)
    expect(rows.slice(0, moreAt)).toEqual(['#Tabs', 'All', 'Pinned', 'Recent', '---'])
    const tiers = rows.slice(moreAt + 1, rows.indexOf('---', moreAt))
    expect(tiers.slice(0, 3)).toEqual(['Focus', 'Satellite', 'Parked'])
    // The words above the divider never name a tier; every tier item explains itself on hover.
    expect(rows.slice(0, moreAt).join(' ')).not.toMatch(/focus|satellite|backlog|parked/i)
    for (const name of ['Focus', 'Satellite', 'Parked']) {
      const title = await menu.getByRole('menuitemcheckbox', { name, exact: true }).getAttribute('title')
      expect(title, name).toBeTruthy()
    }
    // All and Pinned explain themselves without a tier word, on the bar and in the menu.
    for (const name of ['All', 'Pinned'] as const) {
      const titles = [await tab(page, name).getAttribute('title'), await menu.getByRole('menuitemcheckbox', { name, exact: true }).getAttribute('title')]
      for (const title of titles) {
        expect(title, name).toBeTruthy()
        expect(title!, name).not.toMatch(/tier|focus|satellite|backlog|parked/i)
      }
    }
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })
})
