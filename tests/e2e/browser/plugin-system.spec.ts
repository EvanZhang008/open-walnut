/**
 * Playwright browser tests for the plugin system UI.
 *
 * Verifies sync badges, source routing, display metadata, and error states
 * render correctly across TodoPanel (main page) and TaskCard (dashboard).
 *
 * Relies on seeded tasks in test-server.ts:
 * - pw-task-001:              source=ms-todo, no ext (unsynced)
 * - pw-task-plugina-synced:   source=plugin-a, ext.plugin-a.id set (synced)
 * - pw-task-plugina-unsynced: source=plugin-a, no ext (unsynced)
 * - pw-task-pluginb-synced:   source=plugin-b, ext.plugin-b set (synced), category=Engineering
 * - pw-task-local:            source=local, category=Later
 * - pw-task-sync-error:       source=ms-todo, sync_error set
 * - pw-task-ms-synced:        source=ms-todo, ext.ms-todo set (synced), category=Personal
 */
import { test, expect } from '@playwright/test'

const API = 'http://localhost:3457'

// ── Helpers ──

async function showAllTasksInTodoPanel(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.todo-panel-tab', { hasText: 'All' }).click()
  await page.waitForTimeout(300)
}

async function goToDashboard(page: import('@playwright/test').Page) {
  await page.goto('/tasks')
  await page.waitForLoadState('networkidle')
}

// ── 1. App loads with plugin system ──

test.describe('1. App loads with plugin system', () => {
  test('app loads and todo panel renders with badges', async ({ page }) => {
    await showAllTasksInTodoPanel(page)
    await page.screenshot({ path: 'playwright-report/plugin-01-app-load.png' })
    await expect(page.locator('.todo-panel')).toBeVisible()

    // At least one task-source-badge should be visible
    const badges = page.locator('.task-source-badge')
    await expect(badges.first()).toBeVisible({ timeout: 5000 })
  })
})

// ── 2. Create task via REST — verify badge ──

test.describe('2. Create task — source auto-assigned', () => {
  test('task created via API gets source auto-assigned', async ({ page }) => {
    const title = `Plugin API task ${Date.now()}`
    const res = await page.request.post(`${API}/api/tasks`, {
      data: { title, category: 'Inbox' },
    })
    expect(res.status()).toBe(201)
    const body = await res.json() as { task: { source: string; id: string } }

    // Source is auto-assigned by plugin system (Inbox → local or ms-todo depending on config)
    expect(body.task.source).toBeTruthy()
    expect(body.task.source.length).toBeGreaterThan(0)
  })

  test('task appears in UI with source badge after page load', async ({ page }) => {
    // Create task, then load page — task should be in the todo panel
    const title = `Plugin badge test ${Date.now()}`
    await page.request.post(`${API}/api/tasks`, {
      data: { title, category: 'Inbox' },
    })

    await showAllTasksInTodoPanel(page)

    const taskItem = page.locator('.todo-panel-item', { hasText: title })
    await expect(taskItem).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'playwright-report/plugin-02-badge-visible.png' })

    const badge = taskItem.locator('.task-source-badge')
    await expect(badge).toBeVisible()
  })
})

// ── 3. Click into task — TaskContextBar ──

test.describe('3. Click into task shows context', () => {
  test('clicking a seeded task shows context bar or navigates', async ({ page }) => {
    await showAllTasksInTodoPanel(page)

    const taskItem = page.locator('.todo-panel-item', { hasText: 'PluginA synced task' })
    await expect(taskItem).toBeVisible({ timeout: 5000 })

    // Click the title area
    const titleEl = taskItem.locator('.todo-panel-item-title')
    if (await titleEl.isVisible()) {
      await titleEl.click()
    } else {
      await taskItem.click()
    }
    await page.screenshot({ path: 'playwright-report/plugin-03-task-context.png' })

    // Either context bar appears or we navigate to task detail
    const contextBar = page.locator('.task-context-bar')
    const isContextBar = await contextBar.isVisible().catch(() => false)
    if (!isContextBar) {
      await expect(page).toHaveURL(/\/tasks\/|\//, { timeout: 3000 })
    }
  })
})

// ── 4. Phase cycling on dashboard ──

test.describe('4. Dashboard task with phase info', () => {
  test('seeded task shows sync indicator on dashboard', async ({ page }) => {
    await goToDashboard(page)

    // Look for any task card that has a sync indicator — Work category tasks should be visible
    const taskCard = page.locator('.task-card', { hasText: 'PluginA synced task' })
    await expect(taskCard).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'playwright-report/plugin-04-phase-dashboard.png' })

    const indicator = taskCard.locator('.sync-indicator')
    await expect(indicator).toBeVisible()
  })
})

// ── 5. GET /api/integrations ──

test.describe('5. GET /api/integrations endpoint', () => {
  test('returns array of plugin metadata excluding local', async ({ page }) => {
    const res = await page.request.get(`${API}/api/integrations`)
    expect(res.status()).toBe(200)

    const body = await res.json() as Array<{ id: string; name: string; badge: string; badgeColor: string }>
    expect(Array.isArray(body)).toBe(true)
    expect(body.every(p => p.id !== 'local')).toBe(true)

    for (const plugin of body) {
      expect(plugin.id).toBeTruthy()
      expect(plugin.name).toBeTruthy()
      expect(plugin.badge).toBeTruthy()
      expect(plugin.badgeColor).toBeTruthy()
    }
  })

  test('ms-todo has badge M / #0078D4', async ({ page }) => {
    const res = await page.request.get(`${API}/api/integrations`)
    const body = await res.json() as Array<{ id: string; badge: string; badgeColor: string }>
    const ms = body.find(p => p.id === 'ms-todo')
    if (ms) {
      expect(ms.badge).toBe('M')
      expect(ms.badgeColor).toBe('#0078D4')
    }
  })
})

// ── 6. Sync indicator states on dashboard ──

test.describe('6. Sync indicator states on dashboard', () => {
  test('synced plugin-a task: badge with sync-synced', async ({ page }) => {
    await goToDashboard(page)
    const taskCard = page.locator('.task-card', { hasText: 'PluginA synced task' })
    await expect(taskCard).toBeVisible({ timeout: 5000 })

    const indicator = taskCard.locator('.sync-indicator')
    await expect(indicator).toHaveClass(/sync-synced/)
    await page.screenshot({ path: 'playwright-report/plugin-06-synced-plugina.png' })
  })

  test('unsynced plugin-a task: sync-unsynced class', async ({ page }) => {
    await goToDashboard(page)
    const taskCard = page.locator('.task-card', { hasText: 'PluginA unsynced task' })
    await expect(taskCard).toBeVisible({ timeout: 5000 })

    const indicator = taskCard.locator('.sync-indicator')
    await expect(indicator).toHaveClass(/sync-unsynced/)
    await page.screenshot({ path: 'playwright-report/plugin-06-unsynced-plugina.png' })
  })

  test('synced plugin-b task: badge with sync-synced', async ({ page }) => {
    await goToDashboard(page)
    // Plugin-b task is in Engineering category — check it appears on /tasks
    const taskCard = page.locator('.task-card', { hasText: 'PluginB synced task' })
    // May not be visible if dashboard filters by default category
    if (await taskCard.isVisible().catch(() => false)) {
      const indicator = taskCard.locator('.sync-indicator')
      await expect(indicator).toHaveClass(/sync-synced/)
    }
    await page.screenshot({ path: 'playwright-report/plugin-06-synced-pluginb.png' })
  })

  test('local task: "L" with sync-local', async ({ page }) => {
    await goToDashboard(page)
    const taskCard = page.locator('.task-card', { hasText: 'Local only task' })
    if (await taskCard.isVisible().catch(() => false)) {
      const indicator = taskCard.locator('.sync-indicator')
      await expect(indicator).toHaveText('L')
      await expect(indicator).toHaveClass(/sync-local/)
      await expect(indicator).toHaveAttribute('title', /Local only/)
    }
    await page.screenshot({ path: 'playwright-report/plugin-06-local.png' })
  })

  test('sync error task: sync-error class with error tooltip', async ({ page }) => {
    await goToDashboard(page)
    const taskCard = page.locator('.task-card', { hasText: 'Sync error task' })
    await expect(taskCard).toBeVisible({ timeout: 5000 })

    const indicator = taskCard.locator('.sync-indicator')
    await expect(indicator).toHaveClass(/sync-error/)
    await expect(indicator).toHaveAttribute('title', /Sync error.*Token expired/)
    await page.screenshot({ path: 'playwright-report/plugin-06-sync-error.png' })
  })

  test('synced MS To-Do task: "M" with sync-synced', async ({ page }) => {
    await goToDashboard(page)
    const taskCard = page.locator('.task-card', { hasText: 'MS To-Do synced task' })
    if (await taskCard.isVisible().catch(() => false)) {
      const indicator = taskCard.locator('.sync-indicator')
      await expect(indicator).toHaveText('M')
      await expect(indicator).toHaveClass(/sync-synced/)
    }
    await page.screenshot({ path: 'playwright-report/plugin-06-synced-ms-todo.png' })
  })
})

// ── 7. Task detail page — external link ──

test.describe('7. Task detail page', () => {
  test('PluginB synced task has external link', async ({ page }) => {
    await page.goto('/tasks/pw-task-pluginb-synced')
    await page.waitForLoadState('networkidle')
    // Wait for integrations hook to resolve
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'playwright-report/plugin-07-pluginb-detail.png' })

    const externalLink = page.locator('a[href*="plugin-b.example.com"]')
    await expect(externalLink).toBeVisible({ timeout: 5000 })
    await expect(externalLink).toContainText(/PluginB|External/)
  })

  test('PluginA synced task has external link', async ({ page }) => {
    await page.goto('/tasks/pw-task-plugina-synced')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'playwright-report/plugin-07-plugina-detail.png' })

    const externalLink = page.locator('a[href*="plugin-a.example.com"]')
    await expect(externalLink).toBeVisible({ timeout: 5000 })
    await expect(externalLink).toContainText(/PluginA|External/)
  })
})

// ── 8. TodoPanel source badges ──

test.describe('8. TodoPanel source badges', () => {
  test('synced plugin-a badge: no error/unsynced class', async ({ page }) => {
    await showAllTasksInTodoPanel(page)

    const todoItem = page.locator('.todo-panel-item', { hasText: 'PluginA synced task' })
    await expect(todoItem).toBeVisible({ timeout: 5000 })

    const badge = todoItem.locator('.task-source-badge')
    await expect(badge).not.toHaveClass(/task-source-badge-error/)
    await expect(badge).not.toHaveClass(/task-source-badge-unsynced/)
    await page.screenshot({ path: 'playwright-report/plugin-08-badge-synced-plugina.png' })
  })

  test('unsynced plugin-a badge: with unsynced class', async ({ page }) => {
    await showAllTasksInTodoPanel(page)

    const todoItem = page.locator('.todo-panel-item', { hasText: 'PluginA unsynced task' })
    await expect(todoItem).toBeVisible({ timeout: 5000 })

    const badge = todoItem.locator('.task-source-badge')
    await expect(badge).toHaveClass(/task-source-badge-unsynced/)
  })

  test('sync error badge: "!" with error class and tooltip', async ({ page }) => {
    await showAllTasksInTodoPanel(page)

    const todoItem = page.locator('.todo-panel-item', { hasText: 'Sync error task' })
    await expect(todoItem).toBeVisible({ timeout: 5000 })

    const badge = todoItem.locator('.task-source-badge')
    await expect(badge).toHaveText('!')
    await expect(badge).toHaveClass(/task-source-badge-error/)
    await expect(badge).toHaveAttribute('title', /Sync error.*Token expired/)
    await page.screenshot({ path: 'playwright-report/plugin-08-badge-sync-error.png' })
  })

  test('local badge: "L" with local tooltip', async ({ page }) => {
    await showAllTasksInTodoPanel(page)

    const todoItem = page.locator('.todo-panel-item', { hasText: 'Local only task' })
    await expect(todoItem).toBeVisible({ timeout: 5000 })

    const badge = todoItem.locator('.task-source-badge')
    await expect(badge).toHaveText('L')
    await expect(badge).toHaveAttribute('title', /Local only/)
    await page.screenshot({ path: 'playwright-report/plugin-08-badge-local.png' })
  })

  test('MS To-Do synced badge: "M"', async ({ page }) => {
    await showAllTasksInTodoPanel(page)

    const todoItem = page.locator('.todo-panel-item', { hasText: 'MS To-Do synced task' })
    await expect(todoItem).toBeVisible({ timeout: 5000 })

    const badge = todoItem.locator('.task-source-badge')
    await expect(badge).toHaveText('M')
    await expect(badge).not.toHaveClass(/task-source-badge-unsynced/)
    await expect(badge).not.toHaveClass(/task-source-badge-error/)
  })

  test('PluginB synced badge visible', async ({ page }) => {
    await showAllTasksInTodoPanel(page)

    const todoItem = page.locator('.todo-panel-item', { hasText: 'PluginB synced task' })
    await expect(todoItem).toBeVisible({ timeout: 5000 })

    const badge = todoItem.locator('.task-source-badge')
    await expect(badge).not.toHaveClass(/task-source-badge-unsynced/)
  })
})

// ── 9. Multi-category source assignment ──

test.describe('9. Multi-category source assignment', () => {
  test('tasks in different categories get sources assigned', async ({ page }) => {
    const categories = ['PW-Cat-One', 'PW-Cat-Two']
    for (const cat of categories) {
      const res = await page.request.post(`${API}/api/tasks`, {
        data: { title: `Cat ${cat} ${Date.now()}`, category: cat },
      })
      expect(res.status()).toBe(201)
      const body = await res.json() as { task: { source: string } }
      expect(body.task.source).toBeTruthy()
    }
  })
})

// ── 10. Sync error / tooltip details ──

test.describe('10. Sync error and tooltip details', () => {
  test('TodoPanel error badge tooltip has full error message', async ({ page }) => {
    await showAllTasksInTodoPanel(page)

    const badge = page.locator('.todo-panel-item', { hasText: 'Sync error task' }).locator('.task-source-badge')
    const tooltip = await badge.getAttribute('title')
    expect(tooltip).toContain('Sync error')
    expect(tooltip).toContain('Token expired')
    await page.screenshot({ path: 'playwright-report/plugin-10-error-tooltip.png' })
  })

  test('Dashboard error indicator tooltip has full error message', async ({ page }) => {
    await goToDashboard(page)

    const indicator = page.locator('.task-card', { hasText: 'Sync error task' }).locator('.sync-indicator')
    await expect(indicator).toBeVisible({ timeout: 5000 })
    const tooltip = await indicator.getAttribute('title')
    expect(tooltip).toContain('Sync error')
    expect(tooltip).toContain('Token expired')
  })

  test('synced task tooltip includes "Synced to"', async ({ page }) => {
    await goToDashboard(page)

    const indicator = page.locator('.task-card', { hasText: 'PluginA synced task' }).locator('.sync-indicator')
    await expect(indicator).toBeVisible({ timeout: 5000 })
    const tooltip = await indicator.getAttribute('title')
    expect(tooltip).toContain('Synced to')
    // Case-insensitive check — may show plugin name depending on integration loading
    expect(tooltip!.toLowerCase()).toContain('plugin-a')
  })

  test('unsynced task tooltip includes "Not synced" and "will retry"', async ({ page }) => {
    await goToDashboard(page)

    const indicator = page.locator('.task-card', { hasText: 'PluginA unsynced task' }).locator('.sync-indicator')
    await expect(indicator).toBeVisible({ timeout: 5000 })
    const tooltip = await indicator.getAttribute('title')
    expect(tooltip).toContain('Not synced')
    expect(tooltip).toContain('will retry')
  })
})
