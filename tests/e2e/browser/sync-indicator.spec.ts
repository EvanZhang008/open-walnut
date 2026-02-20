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

// ── TaskCard sync indicators (dashboard / task list views) ──

test.describe('TaskCard SyncIndicator', () => {
  test('synced plugin-a task shows badge with sync-synced class', async ({ page }) => {
    await page.goto('/tasks')
    await page.waitForLoadState('networkidle')

    const taskCard = page.locator('.task-card', { hasText: 'PluginA synced task' })
    await expect(taskCard).toBeVisible({ timeout: 5000 })

    const indicator = taskCard.locator('.sync-indicator')
    await expect(indicator).toBeVisible()
    await expect(indicator).toHaveClass(/sync-synced/)
    await expect(indicator).not.toHaveClass(/sync-unsynced/)
  })

  test('unsynced plugin-a task shows badge with sync-unsynced class', async ({ page }) => {
    await page.goto('/tasks')
    await page.waitForLoadState('networkidle')

    const taskCard = page.locator('.task-card', { hasText: 'PluginA unsynced task' })
    await expect(taskCard).toBeVisible({ timeout: 5000 })

    const indicator = taskCard.locator('.sync-indicator')
    await expect(indicator).toBeVisible()
    await expect(indicator).toHaveClass(/sync-unsynced/)
    await expect(indicator).not.toHaveClass(/sync-synced/)
  })

  test('unsynced MS To-Do task shows unsynced indicator', async ({ page }) => {
    await page.goto('/tasks')
    await page.waitForLoadState('networkidle')

    const taskCard = page.locator('.task-card', { hasText: 'Playwright test task' })
    await expect(taskCard).toBeVisible({ timeout: 5000 })

    const indicator = taskCard.locator('.sync-indicator')
    await expect(indicator).toBeVisible()
    await expect(indicator).toHaveClass(/sync-unsynced/)
  })
})

// ── TodoPanel source badges (main page) ──
// The TodoPanel defaults to the starred tab (no tasks starred = empty).
// Click "All" tab first to reveal all tasks.

test.describe('TodoPanel source badge', () => {
  async function showAllTasks(page: import('@playwright/test').Page) {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Click "All" category tab to show all tasks (default is starred tab which may be empty)
    await page.locator('.todo-panel-tab', { hasText: 'All' }).click()
  }

  test('synced plugin-a task shows normal badge', async ({ page }) => {
    await showAllTasks(page)

    const todoItem = page.locator('.todo-panel-item', { hasText: 'PluginA synced task' })
    await expect(todoItem).toBeVisible({ timeout: 5000 })

    const badge = todoItem.locator('.task-source-badge')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveClass(/task-source-badge-plugin-a/)
    await expect(badge).not.toHaveClass(/task-source-badge-unsynced/)
  })

  test('unsynced plugin-a task shows badge with unsynced class', async ({ page }) => {
    await showAllTasks(page)

    const todoItem = page.locator('.todo-panel-item', { hasText: 'PluginA unsynced task' })
    await expect(todoItem).toBeVisible({ timeout: 5000 })

    const badge = todoItem.locator('.task-source-badge')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveClass(/task-source-badge-unsynced/)
  })

  test('unsynced plugin-a task badge has warning tooltip', async ({ page }) => {
    await showAllTasks(page)

    const todoItem = page.locator('.todo-panel-item', { hasText: 'PluginA unsynced task' })
    await expect(todoItem).toBeVisible({ timeout: 5000 })

    const badge = todoItem.locator('.task-source-badge')
    await expect(badge).toHaveAttribute('title', /Not synced.*will retry/)
  })

  test('synced plugin-a task badge has synced tooltip', async ({ page }) => {
    await showAllTasks(page)

    const todoItem = page.locator('.todo-panel-item', { hasText: 'PluginA synced task' })
    await expect(todoItem).toBeVisible({ timeout: 5000 })

    const badge = todoItem.locator('.task-source-badge')
    await expect(badge).toHaveAttribute('title', /Synced to/)
  })
})
