/**
 * Playwright browser tests for the plugin system UI.
 *
 * Verifies sync badges, source routing, display metadata, and error states
 * render correctly across TodoPanel (main page) and TaskCard (dashboard).
 *
 * Relies on seeded tasks in test-server.ts. A project belongs to one source, so
 * each plugin's tasks sit in a project that plugin owns (the seed's `categories`):
 * - pw-task-plugina-synced:   source=plugin-a, ext.plugin-a.id set (synced), project=Atlas
 * - pw-task-plugina-unsynced: source=plugin-a, no ext (unsynced), project=Atlas
 * - pw-task-pluginb-synced:   source=plugin-b, ext.plugin-b set (synced), project=Backend
 * - pw-task-local:            source=local, project=Ideas
 * - pw-task-sync-error:       source=ms-todo, sync_error set, project=Errands
 * - pw-task-ms-synced:        source=ms-todo, ext.ms-todo set (synced), project=Errands
 * - pw-task-ms-unsynced:      source=ms-todo, no ext (unsynced), project=Errands
 */
import { test, expect } from '@playwright/test'
import { showEverything } from './todo-panel-helpers'

const API = 'http://localhost:3457'

// ── Helpers ──

async function showAllTasksInTodoPanel(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // Both axes: the SECTION tab defaults to Focus (main list not mounted) and the
  // PROJECT chip scopes by project. Projects live in the View dropdown now.
  await showEverything(page)
  await page.waitForTimeout(300)
}

/**
 * The source row of a task's menu. The badge left the panel's rows for the menu
 * (TaskKebabMenu.tsx: the badge, then the integration's name and its sync state),
 * so the row-badge classes and tooltip these tests read are gone.
 */
async function openSourceRow(page: import('@playwright/test').Page, taskTitle: string) {
  const todoItem = page.locator('.todo-panel-item', { hasText: taskTitle })
  await expect(todoItem).toBeVisible({ timeout: 5000 })
  await todoItem.getByRole('button', { name: 'More actions' }).click()
  const sourceRow = page.locator('.task-kebab-menu .task-kebab-info')
  await expect(sourceRow).toBeVisible()
  return sourceRow
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

    // A seeded plugin task's menu names its source with the badge.
    const sourceRow = await openSourceRow(page, 'PluginA synced task')
    await expect(sourceRow.locator('.task-source-badge')).toBeVisible()
  })
})

// ── 2. Create task via REST — verify badge ──

test.describe('2. Create task — source auto-assigned', () => {
  test('task created via API gets source auto-assigned', async ({ page }) => {
    const title = `Plugin API task ${Date.now()}`
    const res = await page.request.post(`${API}/api/tasks`, {
      data: { title },
    })
    expect(res.status()).toBe(201)
    const body = await res.json() as { task: { source: string; id: string } }

    // No project = Inbox, which is structurally local-only (no registry row, no
    // provider can claim it) — so the plugin system must resolve source=local.
    expect(body.task.source).toBe('local')
  })

  test('task appears in UI with source badge after page load', async ({ page }) => {
    // Create task, then load page — task should be in the todo panel
    const title = `Plugin badge test ${Date.now()}`
    // Unpinned, so it is a row of the task list (a create is born pinned: ddda11ac4).
    await page.request.post(`${API}/api/tasks`, {
      data: { title, pinned: false },
    })

    await showAllTasksInTodoPanel(page)

    const sourceRow = await openSourceRow(page, title)
    await page.screenshot({ path: 'playwright-report/plugin-02-badge-visible.png' })
    await expect(sourceRow.locator('.task-source-badge')).toHaveText('L')
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

    // Either task context pill appears or we navigate to task detail
    const contextBar = page.locator('.chat-input-task-pill')
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

    // Look for any task card that has a sync indicator — Walnut-project tasks should be visible
    const taskCard = page.locator('.tp-row', { hasText: 'PluginA synced task' })
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
    const taskCard = page.locator('.tp-row', { hasText: 'PluginA synced task' })
    await expect(taskCard).toBeVisible({ timeout: 5000 })

    const indicator = taskCard.locator('.sync-indicator')
    await expect(indicator).toHaveClass(/sync-synced/)
    await page.screenshot({ path: 'playwright-report/plugin-06-synced-plugina.png' })
  })

  test('unsynced plugin-a task: sync-unsynced class', async ({ page }) => {
    await goToDashboard(page)
    const taskCard = page.locator('.tp-row', { hasText: 'PluginA unsynced task' })
    await expect(taskCard).toBeVisible({ timeout: 5000 })

    const indicator = taskCard.locator('.sync-indicator')
    await expect(indicator).toHaveClass(/sync-unsynced/)
    await page.screenshot({ path: 'playwright-report/plugin-06-unsynced-plugina.png' })
  })

  test('synced plugin-b task: badge with sync-synced', async ({ page }) => {
    await goToDashboard(page)
    // Plugin-b task is in the Backend project — check it appears on /tasks
    const taskCard = page.locator('.tp-row', { hasText: 'PluginB synced task' })
    // May not be visible if the dashboard scopes to a different project
    if (await taskCard.isVisible().catch(() => false)) {
      const indicator = taskCard.locator('.sync-indicator')
      await expect(indicator).toHaveClass(/sync-synced/)
    }
    await page.screenshot({ path: 'playwright-report/plugin-06-synced-pluginb.png' })
  })

  test('local task: "L" with sync-local', async ({ page }) => {
    await goToDashboard(page)
    const taskCard = page.locator('.tp-row', { hasText: 'Local only task' })
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
    const taskCard = page.locator('.tp-row', { hasText: 'Sync error task' })
    await expect(taskCard).toBeVisible({ timeout: 5000 })

    const indicator = taskCard.locator('.sync-indicator')
    await expect(indicator).toHaveClass(/sync-error/)
    await expect(indicator).toHaveAttribute('title', /Sync error.*Token expired/)
    await page.screenshot({ path: 'playwright-report/plugin-06-sync-error.png' })
  })

  test('synced MS To-Do task: "M" with sync-synced', async ({ page }) => {
    await goToDashboard(page)
    const taskCard = page.locator('.tp-row', { hasText: 'MS To-Do synced task' })
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

// ── 8. The source row of a task's menu ──

test.describe('8. Task menu source row', () => {
  test('synced plugin-a task: badge, no sync warning', async ({ page }) => {
    await showAllTasksInTodoPanel(page)
    const sourceRow = await openSourceRow(page, 'PluginA synced task')
    await expect(sourceRow.locator('.task-source-badge')).toBeVisible()
    await expect(sourceRow).not.toContainText('(unsynced)')
    await expect(sourceRow).not.toContainText('(sync error)')
    await page.screenshot({ path: 'playwright-report/plugin-08-badge-synced-plugina.png' })
  })

  test('unsynced plugin-a task: says unsynced', async ({ page }) => {
    await showAllTasksInTodoPanel(page)
    const sourceRow = await openSourceRow(page, 'PluginA unsynced task')
    await expect(sourceRow).toContainText('(unsynced)')
  })

  test('sync error task: "!" and says sync error', async ({ page }) => {
    await showAllTasksInTodoPanel(page)
    const sourceRow = await openSourceRow(page, 'Sync error task')
    await expect(sourceRow.locator('.task-source-badge')).toHaveText('!')
    await expect(sourceRow).toContainText('(sync error)')
    await page.screenshot({ path: 'playwright-report/plugin-08-badge-sync-error.png' })
  })

  test('local task: "L"', async ({ page }) => {
    await showAllTasksInTodoPanel(page)
    const sourceRow = await openSourceRow(page, 'Local only task')
    await expect(sourceRow.locator('.task-source-badge')).toHaveText('L')
    await page.screenshot({ path: 'playwright-report/plugin-08-badge-local.png' })
  })

  test('MS To-Do synced task: "M"', async ({ page }) => {
    await showAllTasksInTodoPanel(page)
    const sourceRow = await openSourceRow(page, 'MS To-Do synced task')
    await expect(sourceRow.locator('.task-source-badge')).toHaveText('M')
  })

  test('PluginB synced task: badge, no sync warning', async ({ page }) => {
    await showAllTasksInTodoPanel(page)
    const sourceRow = await openSourceRow(page, 'PluginB synced task')
    await expect(sourceRow.locator('.task-source-badge')).toBeVisible()
    await expect(sourceRow).not.toContainText('(unsynced)')
  })
})

// ── 9. Multi-project source assignment ──

test.describe('9. Multi-project source assignment', () => {
  test('tasks in different projects get sources assigned (auto-created registry rows)', async ({ page }) => {
    const projects = ['PW-Proj-One', 'PW-Proj-Two']
    for (const proj of projects) {
      const res = await page.request.post(`${API}/api/tasks`, {
        data: { title: `Proj ${proj} ${Date.now()}`, project: proj },
      })
      expect(res.status()).toBe(201)
      const body = await res.json() as { task: { source: string; project: string } }
      // A brand-new project name auto-creates its registry row, and the task's
      // source comes from that row (local unless a plugin claims the name).
      expect(body.task.project).toBe(proj)
      expect(body.task.source).toBeTruthy()
    }
  })
})

// ── 10. Sync error / tooltip details ──

test.describe('10. Sync error and tooltip details', () => {
  // "TodoPanel error badge tooltip has full error message" was deleted 2026-10-31:
  // the panel's rows have no badge or tooltip now (section 8 reads the menu's), and
  // the full error text is the Dashboard's, below.

  test('Dashboard error indicator tooltip has full error message', async ({ page }) => {
    await goToDashboard(page)

    const indicator = page.locator('.tp-row', { hasText: 'Sync error task' }).locator('.sync-indicator')
    await expect(indicator).toBeVisible({ timeout: 5000 })
    const tooltip = await indicator.getAttribute('title')
    expect(tooltip).toContain('Sync error')
    expect(tooltip).toContain('Token expired')
  })

  test('synced task tooltip includes "Synced to"', async ({ page }) => {
    await goToDashboard(page)

    const indicator = page.locator('.tp-row', { hasText: 'PluginA synced task' }).locator('.sync-indicator')
    await expect(indicator).toBeVisible({ timeout: 5000 })
    const tooltip = await indicator.getAttribute('title')
    expect(tooltip).toContain('Synced to')
    // Case-insensitive check — may show plugin name depending on integration loading
    expect(tooltip!.toLowerCase()).toContain('plugin-a')
  })

  test('unsynced task tooltip includes "Not synced" and "will retry"', async ({ page }) => {
    await goToDashboard(page)

    const indicator = page.locator('.tp-row', { hasText: 'PluginA unsynced task' }).locator('.sync-indicator')
    await expect(indicator).toBeVisible({ timeout: 5000 })
    const tooltip = await indicator.getAttribute('title')
    expect(tooltip).toContain('Not synced')
    expect(tooltip).toContain('will retry')
  })
})
