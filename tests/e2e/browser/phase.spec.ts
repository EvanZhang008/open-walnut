/**
 * Playwright browser tests for the phase lifecycle feature.
 *
 * Tests:
 * 1. Phase-aware status icons render correctly for seeded tasks
 * 2. Sprint pill renders for plugin tasks with sprint
 * 3. Phase cycling via status button click
 * 4. Phase badge shows on task detail page
 * 5. New tasks created via quick-add get phase=TODO
 */
import { test, expect } from '@playwright/test'

const API = 'http://localhost:3457'

// Helper: create task via REST API with unique suffix
async function createTaskViaApi(
  title: string,
  opts: Record<string, unknown> = {},
): Promise<{ id: string; title: string; phase: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: uniqueTitle, ...opts }),
  })
  if (!res.ok) throw new Error(`API call failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string; title: string; phase: string } }
  return body.task
}

// Helper: update task phase via API
async function updateTaskPhase(
  id: string,
  phase: string,
): Promise<{ id: string; phase: string; status: string }> {
  const res = await fetch(`${API}/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase }),
  })
  if (!res.ok) throw new Error(`API call failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string; phase: string; status: string } }
  return body.task
}

// Helper: navigate to "All" tab in the todo panel so all tasks are visible
async function showAllTasks(page: import('@playwright/test').Page) {
  // Default tab is ★ (Starred) which hides non-starred tasks.
  // Click "All" category tab to show everything.
  // Use .todo-panel-tabs container to distinguish from source filter "All" button.
  const allTab = page.locator('.todo-panel-tabs .todo-panel-tab', { hasText: 'All' })
  await allTab.click()
  // Wait for task list to update
  await page.waitForTimeout(500)
}

// ── Phase icon rendering ──

test('seeded TODO task shows hollow circle icon', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  // Find "Playwright test task" which is seeded as TODO
  const taskItem = page.locator('.todo-panel-item', { hasText: 'Playwright test task' })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  // Status button should have phase class
  const statusBtn = taskItem.locator('.task-status-btn')
  await expect(statusBtn).toBeVisible()

  // The button should contain ○ (hollow circle) for TODO
  await expect(statusBtn).toContainText('○')
})

test('seeded IN_PROGRESS task shows filled circle icon', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  const taskItem = page.locator('.todo-panel-item', { hasText: 'In progress phase task' })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  const statusBtn = taskItem.locator('.task-status-btn')
  // The button should contain ● (filled circle) for IN_PROGRESS
  await expect(statusBtn).toContainText('●')
})

test('seeded AGENT_COMPLETE task shows check icon', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  const taskItem = page.locator('.todo-panel-item', { hasText: 'Agent complete phase task' })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  const statusBtn = taskItem.locator('.task-status-btn')
  // The button should contain ✓ for AGENT_COMPLETE
  await expect(statusBtn).toContainText('✓')
})

// ── Sprint pill ──

test('Plugin task with sprint shows sprint pill', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  // "PluginA synced task" has sprint: "Feb 2 - Feb 13"
  const taskItem = page.locator('.todo-panel-item', { hasText: 'PluginA synced task' })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  const sprintPill = taskItem.locator('.todo-item-sprint-pill')
  await expect(sprintPill).toBeVisible()
  await expect(sprintPill).toContainText('Feb 2 - Feb 13')
})

test('task without sprint does not show sprint pill', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  // "Playwright test task" has no sprint
  const taskItem = page.locator('.todo-panel-item', { hasText: 'Playwright test task' })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  const sprintPill = taskItem.locator('.todo-item-sprint-pill')
  await expect(sprintPill).toHaveCount(0)
})

// ── Phase cycling via click ──

test('clicking status button opens phase picker and selects phase', async ({ page }) => {
  // Create a fresh task so we don't mutate shared seeded data
  const task = await createTaskViaApi('Phase picker test', { category: 'Work', project: 'Walnut' })

  // Navigate after task creation — page will fetch all tasks including the new one
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  // Wait for task list to include the new task (may arrive via initial fetch or WS)
  const taskItem = page.locator('.todo-panel-item', { hasText: task.title })
  // If not visible after initial load, WS task:created event should render it
  await expect(taskItem).toBeVisible({ timeout: 15000 })
  await taskItem.scrollIntoViewIfNeeded()

  // It should start as TODO (○)
  const statusBtn = taskItem.locator('.task-status-btn')
  await expect(statusBtn).toContainText('○')

  // Click the status button — dropdown should appear
  await statusBtn.click()
  const menu = taskItem.locator('.phase-picker-menu')
  await expect(menu).toBeVisible({ timeout: 3000 })

  // Menu should have 7 phase items
  const items = menu.locator('.phase-picker-item')
  await expect(items).toHaveCount(7)

  // Current phase (TODO) should have the active class and checkmark
  const todoItem = items.first()
  await expect(todoItem).toHaveClass(/active/)
  await expect(todoItem.locator('.phase-picker-check')).toBeVisible()

  // Click "In Progress" item
  const inProgressItem = menu.locator('.phase-picker-item', { hasText: 'In Progress' })
  await inProgressItem.click()

  // Dropdown should close
  await expect(menu).not.toBeVisible({ timeout: 2000 })

  // Icon should change to ● (filled circle for IN_PROGRESS)
  await expect(statusBtn).toContainText('●', { timeout: 3000 })

  // Verify via API that phase is IN_PROGRESS
  const res = await fetch(`${API}/api/tasks/${task.id}`)
  const body = (await res.json()) as { task: { phase: string; status: string } }
  expect(body.task.phase).toBe('IN_PROGRESS')
  expect(body.task.status).toBe('in_progress')
})

test('clicking outside phase picker closes it', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  // Use the seeded "Playwright test task" which is always TODO
  const taskItem = page.locator('.todo-panel-item', { hasText: 'Playwright test task' })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  const statusBtn = taskItem.locator('.task-status-btn')
  await statusBtn.click()

  const menu = taskItem.locator('.phase-picker-menu')
  await expect(menu).toBeVisible({ timeout: 3000 })

  // Click outside the menu
  await page.locator('.todo-panel-header').click()

  // Menu should close
  await expect(menu).not.toBeVisible({ timeout: 2000 })

  // Re-click to open again, then pick same phase (TODO) — should close without API call
  await statusBtn.click()
  await expect(menu).toBeVisible({ timeout: 3000 })
  const todoItem = menu.locator('.phase-picker-item', { hasText: 'To Do' })
  await todoItem.click()
  await expect(menu).not.toBeVisible({ timeout: 2000 })
})

// ── Task detail page shows phase badge ──

test('task detail page shows phase badge', async ({ page }) => {
  const task = await createTaskViaApi('Detail page phase test')
  await updateTaskPhase(task.id, 'PEER_CODE_REVIEW')

  await page.goto(`/tasks/${task.id}`)
  await page.waitForLoadState('networkidle')

  // The StatusBadge should show phase text
  const badge = page.locator('.badge-phase-peer_code_review')
  await expect(badge).toBeVisible({ timeout: 5000 })
  await expect(badge).toContainText('Peer Code Review')
})

// ── New task gets phase=TODO ──

test('new task created via quick-add gets phase=TODO', async ({ page }) => {
  const uniqueTitle = `Quick-add phase test ${Date.now()}`

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  // Type in quick-add
  const input = page.locator('input[aria-label="New task title"]')
  await input.fill(uniqueTitle)
  await page.locator('.todo-panel-add button').click()

  // Task should appear with TODO icon
  const taskItem = page.locator('.todo-panel-item', { hasText: uniqueTitle })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  const statusBtn = taskItem.locator('.task-status-btn')
  await expect(statusBtn).toContainText('○') // TODO = hollow circle
})

// ── Task detail page shows sprint ──

test('task detail page shows sprint for plugin tasks', async ({ page }) => {
  // The seeded "PluginA synced task" has sprint
  await page.goto('/tasks/pw-task-plugina-synced')
  await page.waitForLoadState('networkidle')

  // Should show sprint text somewhere in the metadata
  const sprintText = page.locator('text=Sprint: Feb 2 - Feb 13')
  await expect(sprintText).toBeVisible({ timeout: 5000 })
})
