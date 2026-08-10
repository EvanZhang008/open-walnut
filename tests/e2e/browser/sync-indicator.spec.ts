/**
 * Playwright browser tests for sync indicator badges.
 *
 * Verifies that:
 * - Synced plugin-a tasks show badge with the synced (blue) style
 * - Unsynced plugin-a tasks show badge with the warning (orange) style
 * - MS To-Do tasks without ms_todo_id show the unsynced style
 *
 * Relies on seeded tasks in test-server.ts:
 * - pw-task-plugina-synced: source=plugin-a, ext set
 * - pw-task-plugina-unsynced: source=plugin-a, no ext
 * - pw-task-001: source=ms-todo, no ms_todo_id
 */
import { test, expect } from '@playwright/test'
import { showEverything } from './todo-panel-helpers'

// ── TaskCard sync indicators (dashboard / task list views) ──

test.describe('TaskCard SyncIndicator', () => {
  async function showAllStatuses(page: import('@playwright/test').Page) {
    await page.goto('/tasks')
    await page.waitForLoadState('networkidle')
    // The /tasks table shows Todo-only by default — turn the Done chip on too.
    const doneChip = page.locator('.tp-chip', { hasText: 'Done' })
    if (!/\bon\b/.test((await doneChip.getAttribute('class')) ?? '')) await doneChip.click()
  }

  test('synced plugin-a task shows badge with sync-synced class', async ({ page }) => {
    await showAllStatuses(page)

    const taskCard = page.locator('.tp-row', { hasText: 'PluginA synced task' })
    await expect(taskCard).toBeVisible({ timeout: 5000 })

    const indicator = taskCard.locator('.sync-indicator')
    await expect(indicator).toBeVisible()
    await expect(indicator).toHaveClass(/sync-synced/)
    await expect(indicator).not.toHaveClass(/sync-unsynced/)
  })

  test('unsynced plugin-a task shows badge with sync-unsynced class', async ({ page }) => {
    await showAllStatuses(page)

    const taskCard = page.locator('.tp-row', { hasText: 'PluginA unsynced task' })
    await expect(taskCard).toBeVisible({ timeout: 5000 })

    const indicator = taskCard.locator('.sync-indicator')
    await expect(indicator).toBeVisible()
    await expect(indicator).toHaveClass(/sync-unsynced/)
    await expect(indicator).not.toHaveClass(/sync-synced/)
  })

  test('unsynced MS To-Do task shows unsynced indicator', async ({ page }) => {
    await showAllStatuses(page)

    const taskCard = page.locator('.tp-row', { hasText: 'Playwright test task' })
    await expect(taskCard).toBeVisible({ timeout: 5000 })

    const indicator = taskCard.locator('.sync-indicator')
    await expect(indicator).toBeVisible()
    await expect(indicator).toHaveClass(/sync-unsynced/)
  })
})

// ── TodoPanel source status (main-page kebab menu) ──
// The TodoPanel defaults to the starred tab (no tasks starred = empty).
// Select the "All" project chip first to reveal all tasks.

test.describe('TodoPanel source badge', () => {
  async function showAllTasks(page: import('@playwright/test').Page) {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Both axes: the SECTION tab defaults to Focus (where `.todo-panel-item` rows
    // aren't mounted at all) and the PROJECT chip defaults to ★ Starred.
    await showEverything(page)
  }

  async function openSourceRow(
    page: import('@playwright/test').Page,
    taskTitle: string,
  ) {
    const todoItem = page.locator('.todo-panel-item', { hasText: taskTitle })
    await expect(todoItem).toBeVisible({ timeout: 5000 })
    await todoItem.getByRole('button', { name: 'More actions' }).click()
    const sourceRow = page.locator('.task-kebab-menu .task-kebab-info')
    await expect(sourceRow).toBeVisible()
    return sourceRow
  }

  test('synced plugin-a task shows normal badge', async ({ page }) => {
    await showAllTasks(page)

    const sourceRow = await openSourceRow(page, 'PluginA synced task')
    const badge = sourceRow.locator('.task-source-badge')
    await expect(badge).toBeVisible()
    await expect(sourceRow).not.toContainText('(unsynced)')
  })

  test('unsynced plugin-a task shows unsynced status', async ({ page }) => {
    await showAllTasks(page)

    const sourceRow = await openSourceRow(page, 'PluginA unsynced task')
    const badge = sourceRow.locator('.task-source-badge')
    await expect(badge).toBeVisible()
    await expect(sourceRow).toContainText('(unsynced)')
  })

  test('unsynced plugin-a task menu identifies its integration', async ({ page }) => {
    await showAllTasks(page)

    const sourceRow = await openSourceRow(page, 'PluginA unsynced task')
    await expect(sourceRow).toContainText(/plugin-a/i)
    await expect(sourceRow).toContainText('(unsynced)')
  })

  test('synced plugin-a task menu identifies its integration', async ({ page }) => {
    await showAllTasks(page)

    const sourceRow = await openSourceRow(page, 'PluginA synced task')
    await expect(sourceRow).toContainText(/plugin-a/i)
    await expect(sourceRow).not.toContainText('(unsynced)')
  })
})
