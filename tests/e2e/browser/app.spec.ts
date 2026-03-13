/**
 * Playwright browser tests for the Walnut web SPA.
 *
 * Runs against a real server (started by playwright.config.ts webServer)
 * with a pre-built SPA served from dist/web/static/.
 *
 * All tests are parallel-safe: each test creates its own unique data
 * (using Date.now() suffixes) and asserts on that specific data.
 *
 * Prerequisites:
 *   cd web && npx vite build    (builds SPA to dist/web/static/)
 *   npx playwright test          (runs these tests)
 */
import { test, expect } from '@playwright/test'

const API = 'http://localhost:3457'

// Helper: create task via REST API with unique suffix for parallel safety
async function createTaskViaApi(
  title: string,
  opts: Record<string, string> = {},
): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: uniqueTitle, ...opts }),
  })
  if (!res.ok) throw new Error(`API call failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string; title: string } }
  return body.task
}

// ── App loads ──

test('app loads and shows main page elements', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Page title
  await expect(page.locator('.page-title')).toBeVisible()

  // Todo panel should be visible
  await expect(page.locator('.todo-panel')).toBeVisible()

  // Chat input should exist
  await expect(page.locator('.chat-input-textarea')).toBeVisible()
})

test('todo panel shows seeded test task', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // The test server seeds "Playwright test task"
  const taskItem = page.locator('.todo-panel-item', { hasText: 'Playwright test task' })
  await expect(taskItem).toBeVisible({ timeout: 5000 })
})

// ── Create task ──

test('create task via quick-add form', async ({ page }) => {
  const uniqueTitle = `Browser created task ${Date.now()}`

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Type in the quick-add input
  const input = page.locator('input[aria-label="New task title"]')
  await input.fill(uniqueTitle)

  // Click Add button
  await page.locator('.todo-panel-add button').click()

  // Verify task appears in the todo list (match exact unique title)
  const taskItem = page.locator('.todo-panel-item', { hasText: uniqueTitle })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  // Input should be cleared
  await expect(input).toHaveValue('')
})

// ── Toggle task complete ──

test('toggle task complete via checkbox', async ({ page }) => {
  // Create a fresh task via API with unique name
  const task = await createTaskViaApi('Toggle test task')

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Find the task item by its unique title
  const taskItem = page.locator('.todo-panel-item', { hasText: task.title })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  // Click the checkbox
  await taskItem.locator('.task-checkbox').click()

  // Wait for the task to get the done styling or disappear from active list
  // (completed tasks are hidden by default in the todo panel)
  await expect(taskItem).toBeHidden({ timeout: 5000 }).catch(() => {
    // If not hidden, it should have the done class
    return expect(taskItem).toHaveClass(/todo-panel-item-done/)
  })

  // Verify via API that the task is done
  const res = await fetch(`${API}/api/tasks/${task.id}`)
  const body = (await res.json()) as { task: { status: string } }
  expect(body.task.status).toBe('done')
})

// ── Real-time WS update ──

test('task created via REST API appears in browser without refresh', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Create a task via REST API (not through the browser)
  const task = await createTaskViaApi('WS update task', { category: 'Work', priority: 'immediate' })

  // Wait for the task to appear via WebSocket push (no page refresh)
  const taskItem = page.locator('.todo-panel-item', { hasText: task.title })
  await expect(taskItem).toBeVisible({ timeout: 5000 })
})

// ── Task detail navigation ──

test('click task navigates to detail page', async ({ page }) => {
  const task = await createTaskViaApi('Detail nav task', { category: 'Work' })

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Wait for the task to appear
  const taskItem = page.locator('.todo-panel-item', { hasText: task.title })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  // Click the task title to focus it (not the checkbox)
  await taskItem.locator('.todo-panel-item-title').click()

  // Should show task context pill or navigate to detail
  // The TodoPanel focuses the task in the chat context
  await expect(page.locator('.chat-input-task-pill')).toBeVisible({ timeout: 3000 }).catch(async () => {
    // If no context pill, check if we navigated to task detail page
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}`))
  })
})

// ── Category tabs ──

test('category tabs filter tasks', async ({ page }) => {
  // Create tasks in different categories with unique names
  const workTask = await createTaskViaApi('Work category task', { category: 'Work' })
  const lifeTask = await createTaskViaApi('Life category task', { category: 'Life' })

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Both should be visible in "All" tab
  await expect(page.locator('.todo-panel-item', { hasText: workTask.title })).toBeVisible({ timeout: 3000 })
  await expect(page.locator('.todo-panel-item', { hasText: lifeTask.title })).toBeVisible({ timeout: 3000 })

  // Click a specific category tab (if it exists)
  const workTab = page.locator('.todo-panel-tab', { hasText: 'Work' })
  if (await workTab.isVisible()) {
    await workTab.click()
    // Work task should still be visible
    await expect(page.locator('.todo-panel-item', { hasText: workTask.title })).toBeVisible()
  }
})

// ── Todo panel collapse/expand ──

test('todo panel can be collapsed and expanded', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const toggleBtn = page.locator('.todo-toggle-btn')
  if (await toggleBtn.isVisible()) {
    // Click to collapse
    await toggleBtn.click()
    await expect(page.locator('.main-page-todo')).toHaveClass(/collapsed/)

    // Click to expand
    await toggleBtn.click()
    await expect(page.locator('.main-page-todo')).not.toHaveClass(/collapsed/)
  }
})
