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
 *   1. the strip renders all 8 tabs
 *   2. picking a tier tab mounts that tier and UNMOUNTS the others
 *   3. the picked section actually gets the height (not a few-rows sliver)
 *   4. `All` restores the stacked view (every section header back)
 *   5. the choice survives a reload (localStorage)
 *   6. searching from a tier tab still shows results (auto-routes to Tasks)
 */

import { test, expect, type Page } from '@playwright/test'

const TABS = ['All', 'Focus', 'Satellite', 'Backlog', 'Wait', 'Recent', 'Tasks', 'Notes'] as const

function tab(page: Page, name: (typeof TABS)[number]) {
  return page.locator('.todo-section-tabs [role="tab"]', { hasText: name }).first()
}

/** Seed pinned tasks across all three tiers so every tier tab has real content. */
async function seedPinnedTasks(page: Page) {
  const stamp = Date.now()
  const created: string[] = []
  for (const [tier, n] of [['focus', 3], ['satellite', 2], ['wait', 2]] as const) {
    for (let i = 0; i < n; i++) {
      const res = await page.request.post('/api/tasks', {
        data: { title: `tabs probe ${tier} ${i} ${stamp}`, source: 'local', project: 'Work' },
      })
      if (!res.ok()) throw new Error(`seed create failed: ${res.status()} ${await res.text()}`)
      const body = await res.json() as { task?: { id?: string } }
      const id = body.task?.id
      if (!id) throw new Error('seed create returned no task id')
      created.push(id)
      // Pin, then move to the target tier — two endpoints (pin defaults to focus).
      const pin = await page.request.post(`/api/focus/tasks/${id}`)
      if (!pin.ok()) throw new Error(`seed pin failed: ${pin.status()} ${await pin.text()}`)
      if (tier !== 'focus') {
        const move = await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier } })
        if (!move.ok()) throw new Error(`seed tier move failed: ${move.status()} ${await move.text()}`)
      }
    }
  }
  return created
}

test.describe('todo panel section tabs', () => {
  test('tabs swap which section owns the panel', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 20_000 })
    await seedPinnedTasks(page)
    await page.reload()

    const strip = page.locator('.todo-section-tabs')
    await expect(strip).toBeVisible({ timeout: 20_000 })

    // The PROJECT chip is a separate axis from the section tabs; pick "All" so
    // no project scoping can filter the seed tasks out of the tiers.
    await page.getByRole('button', { name: 'View options' }).click()
    await page.locator('.vd-rail-btn[data-rail-section="projects"]').click()
    await page.locator('.vd-cat').filter({
      has: page.locator('.vd-cat-name').filter({ hasText: /^All$/ }),
    }).click()
    await page.keyboard.press('Escape')

    // 1. all eight tabs present
    for (const name of TABS) {
      await expect(tab(page, name)).toBeVisible()
    }

    // 2 + 3. Focus tab: the Focus tier is mounted, the other tiers are not, and
    // the tier list gets real height rather than the old few-row sliver.
    await tab(page, 'Focus').click()
    await expect(tab(page, 'Focus')).toHaveAttribute('aria-selected', 'true')

    await expect(page.locator('.todo-pinned-wrapper-solo')).toBeVisible()
    await expect(page.locator('[data-drop-zone="focus-drop-zone"]')).toBeVisible()

    // Wait's drop zone belongs to a different tab — it must be gone from the DOM.
    await expect(page.locator('[data-drop-zone="wait-drop-zone"]')).toHaveCount(0)
    // The stacked view's section headers are gone too (the tab strip names the section).
    await expect(page.locator('.todo-pinned-header')).toHaveCount(0)
    await expect(page.locator('.todo-tasks-header')).toHaveCount(0)

    const panelBox = await page.locator('.todo-panel').boundingBox()
    const soloBox = await page.locator('.todo-pinned-section-solo').boundingBox()
    expect(panelBox).not.toBeNull()
    expect(soloBox).not.toBeNull()
    // The solo section should command most of the panel — the whole point of the
    // change. Anything under half means it's still being squeezed by siblings.
    expect(soloBox!.height).toBeGreaterThan(panelBox!.height * 0.5)

    // 2b. Wait tab: now Wait is mounted and Focus is not.
    await tab(page, 'Wait').click()
    await expect(page.locator('[data-drop-zone="wait-drop-zone"]')).toHaveCount(1)
    await expect(page.locator('[data-drop-zone="focus-drop-zone"]')).toHaveCount(0)

    // 4. All tab: the stacked view is back — Pinned + Tasks headers both render.
    await tab(page, 'All').click()
    await expect(page.locator('.todo-tasks-header')).toHaveCount(1)
    await expect(page.locator('.todo-pinned-header').first()).toBeVisible()
    await expect(page.locator('[data-drop-zone="focus-drop-zone"]')).toHaveCount(1)
    await expect(page.locator('[data-drop-zone="wait-drop-zone"]')).toHaveCount(1)
    await expect(page.locator('.todo-pinned-wrapper-solo')).toHaveCount(0)
  })

  test('the active tab survives a reload', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })

    await tab(page, 'Notes').click()
    await expect(page.locator('.global-notes-section-fill')).toBeVisible()

    await page.reload()
    await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })
    await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true')
    // Fill mode: Notes owns the panel and has no collapse chevron to hide behind.
    await expect(page.locator('.global-notes-section-fill')).toBeVisible()
    await expect(page.locator('.global-notes-chevron')).toHaveCount(0)
  })

  test('searching from a tier tab still surfaces results', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })

    // Park on a tier tab, where the main list (the only place results render) is unmounted.
    await tab(page, 'Focus').click()
    await expect(page.locator('.todo-panel-list')).toHaveCount(0)

    // Typing a query auto-routes to the stacked All view (pinned tiers AND the
    // task list all show their matches) rather than silently showing nothing.
    await page.locator('.todo-search-bar input').fill('probe')
    await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.todo-panel-list')).toHaveCount(1)

    // Tabs stay usable during a search — narrowing to Tasks is ephemeral and
    // must not overwrite the user's persisted tab.
    await tab(page, 'Tasks').click()
    await expect(tab(page, 'Tasks')).toHaveAttribute('aria-selected', 'true')
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

    // Project chip → All so the seed task is visible in the main list.
    await page.getByRole('button', { name: 'View options' }).click()
    await page.locator('.vd-rail-btn[data-rail-section="projects"]').click()
    await page.locator('.vd-cat').filter({
      has: page.locator('.vd-cat-name').filter({ hasText: /^All$/ }),
    }).click()
    await page.keyboard.press('Escape')

    await tab(page, 'Tasks').click()
    await expect(tab(page, 'Tasks')).toHaveAttribute('aria-selected', 'true')

    // Click the pinned task's row in the main list — the view must NOT teleport
    // to the task's pin tier (the old behavior); the user is working in Tasks.
    const row = page.locator(`.todo-panel-list [data-task-id="${id}"]`).first()
    await expect(row).toBeVisible()
    await row.click()
    await expect(tab(page, 'Tasks')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.todo-panel-list')).toHaveCount(1)
  })
})
