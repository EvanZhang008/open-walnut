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
import { test, expect, type Page } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

async function selectCategory(page: Page, category: string): Promise<void> {
  if (!await page.locator('.vd-panel').isVisible()) {
    await page.getByRole('button', { name: 'View options' }).click()
  }
  await page.locator('.vd-cat').filter({
    has: page.locator('.vd-cat-name').filter({ hasText: new RegExp(`^${category}$`) }),
  }).click()
  await page.keyboard.press('Escape')
}

async function showAllTasks(page: Page): Promise<void> {
  await selectCategory(page, 'All')
}

// Helper: create task via REST API with unique suffix for parallel safety
async function createTaskViaApi(
  title: string,
  opts: Record<string, string> = {},
): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: uniqueTitle, source: 'local', ...opts }),
  })
  if (!res.ok) throw new Error(`API call failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string; title: string } }
  return body.task
}

async function pinTaskViaApi(taskId: string, tier = 'focus'): Promise<void> {
  const pinRes = await fetch(`${API}/api/focus/tasks/${taskId}`, { method: 'POST' })
  if (!pinRes.ok) throw new Error(`Pin API call failed: ${pinRes.status} ${await pinRes.text()}`)

  const tierRes = await fetch(`${API}/api/focus/tasks/${taskId}/tier`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier }),
  })
  if (!tierRes.ok) throw new Error(`Tier API call failed: ${tierRes.status} ${await tierRes.text()}`)
}

async function groupTasksViaApi(taskIds: string[]): Promise<void> {
  const res = await fetch(`${API}/api/tasks/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_ids: taskIds, label: 'Search filter drag test' }),
  })
  if (!res.ok) throw new Error(`Group API call failed: ${res.status} ${await res.text()}`)
}

// ── App loads ──

test('app loads and shows main page elements', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await expect(page.locator('.main-page')).toBeVisible()

  // Todo panel should be visible
  await expect(page.locator('.todo-panel')).toBeVisible()

  // Chat input should exist
  await expect(page.locator('.chat-input-textarea')).toBeVisible()
})

test('todo panel shows seeded test task', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  // The test server seeds "Playwright test task"
  const taskItem = page.locator('.todo-panel-item', { hasText: 'Playwright test task' })
  await expect(taskItem).toBeVisible({ timeout: 5000 })
})

test('search and filters apply across pinned, recent, and task sections', async ({ page }) => {
  const query = `shared-query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const matchingPinned = await createTaskViaApi(`Pinned ${query} match`, {
    category: 'Work',
    priority: 'immediate',
  })
  const priorityMismatch = await createTaskViaApi(`Pinned ${query} priority mismatch`, {
    category: 'Work',
    priority: 'important',
  })
  const searchMismatch = await createTaskViaApi('Pinned unrelated search target', {
    category: 'Work',
    priority: 'immediate',
  })
  const unpinnedMatch = await createTaskViaApi(`Unpinned ${query} match`, {
    category: 'Work',
    priority: 'immediate',
  })
  await pinTaskViaApi(matchingPinned.id)
  await pinTaskViaApi(priorityMismatch.id)
  await pinTaskViaApi(searchMismatch.id)
  await groupTasksViaApi([matchingPinned.id, priorityMismatch.id, searchMismatch.id])

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  const pinnedHeader = page.locator('.todo-pinned-label').filter({ hasText: /^Pinned$/ }).locator('..')
  const pinnedSection = pinnedHeader.locator('..')
  const pinnedCard = (taskId: string) => pinnedSection.locator(`[data-task-id="${taskId}"]`)
  const pinnedCount = pinnedHeader.locator('.todo-pinned-count')
  const recentHeader = page.locator('.todo-pinned-label').filter({ hasText: /^Recent$/ }).locator('..')
  const recentSection = recentHeader.locator('..')
  const recentCard = (taskId: string) => recentSection.locator(`[data-task-id="${taskId}"]`)
  const recentCount = recentHeader.locator('.todo-pinned-count')
  const taskList = page.locator('.todo-panel-list')
  const searchInput = page.locator('.todo-search-input')

  await expect(pinnedCard(matchingPinned.id)).toBeVisible({ timeout: 5000 })
  await expect(pinnedCard(priorityMismatch.id)).toBeVisible()
  await expect(pinnedCard(searchMismatch.id)).toBeVisible()
  await expect(recentCard(searchMismatch.id)).toBeVisible()

  // Hold the semantic response so the assertions below exercise the urgent local pass.
  let releaseServerSearch!: () => void
  let markServerSearchStarted!: () => void
  const serverSearchStarted = new Promise<void>((resolve) => { markServerSearchStarted = resolve })
  const serverSearchRelease = new Promise<void>((resolve) => { releaseServerSearch = resolve })
  await page.route('**/api/search?**', async (route) => {
    markServerSearchStarted()
    await serverSearchRelease
    await route.fulfill({ json: { results: [] } })
  })

  await searchInput.pressSequentially(query)
  await expect(searchInput).toHaveValue(query)
  await expect(pinnedCard(matchingPinned.id)).toBeVisible()
  await expect(pinnedCard(priorityMismatch.id)).toBeVisible()
  await expect(pinnedCard(searchMismatch.id)).toBeHidden()
  await expect(pinnedCount).toHaveText('2')
  await expect(recentCard(matchingPinned.id)).toBeVisible()
  await expect(recentCard(priorityMismatch.id)).toBeVisible()
  await expect(recentCard(unpinnedMatch.id)).toBeVisible()
  await expect(recentCard(searchMismatch.id)).toBeHidden()
  await expect(recentCount).toHaveText('3')
  await expect(taskList.locator('.todo-panel-item', { hasText: unpinnedMatch.title })).toBeVisible()

  await serverSearchStarted
  releaseServerSearch()
  await expect(page.locator('.todo-search-spinner')).toBeHidden()
  await expect(pinnedCard(matchingPinned.id)).toBeVisible()
  await expect(pinnedCard(priorityMismatch.id)).toBeVisible()
  await expect(recentCard(unpinnedMatch.id)).toBeVisible()

  await page.getByRole('button', { name: 'View options' }).click()
  await page.locator('.vd-field').filter({ hasText: /^Priority/ }).locator('select').selectOption('immediate')
  await page.keyboard.press('Escape')

  await expect(pinnedCard(matchingPinned.id)).toBeVisible()
  await expect(pinnedCard(priorityMismatch.id)).toBeHidden()
  await expect(pinnedCard(searchMismatch.id)).toBeHidden()
  await expect(pinnedCount).toHaveText('1')
  await expect(recentCard(matchingPinned.id)).toBeVisible()
  await expect(recentCard(priorityMismatch.id)).toBeHidden()
  await expect(recentCard(searchMismatch.id)).toBeHidden()
  await expect(recentCard(unpinnedMatch.id)).toBeVisible()
  await expect(recentCount).toHaveText('2')
  await expect(taskList.locator('.todo-panel-item', { hasText: unpinnedMatch.title })).toBeVisible()

  await page.getByTitle('Clear search (Esc)').click()
  await expect(pinnedCard(matchingPinned.id)).toBeVisible()
  await expect(pinnedCard(priorityMismatch.id)).toBeHidden()
  await expect(pinnedCard(searchMismatch.id)).toBeVisible()
  await expect(recentCard(matchingPinned.id)).toBeVisible()
  await expect(recentCard(priorityMismatch.id)).toBeHidden()
  await expect(recentCard(searchMismatch.id)).toBeVisible()

  const sourceHandle = pinnedCard(matchingPinned.id).locator('.todo-pinned-drag-handle')
  const targetCard = pinnedCard(searchMismatch.id)
  const sourceBox = await sourceHandle.boundingBox()
  const targetBox = await targetCard.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2 + 8)
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 8 })
  await page.mouse.up()

  await expect.poll(async () => {
    const res = await fetch(`${API}/api/focus/tasks`)
    const body = (await res.json()) as { pinned_tasks: string[] }
    return body.pinned_tasks.filter((id) =>
      id === matchingPinned.id || id === priorityMismatch.id || id === searchMismatch.id
    )
  }).toEqual([searchMismatch.id, priorityMismatch.id, matchingPinned.id])
})

// ── Create task ──

test('create task via quick-add form', async ({ page }) => {
  const uniqueTitle = `Browser created task ${Date.now()}`

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  // Type in the quick-add input
  const input = page.locator('input[aria-label="New task title"]')
  await input.fill(uniqueTitle)

  // Click Add button
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  // Verify task appears in the todo list (match exact unique title)
  const taskItem = page.locator('.todo-panel-item', { hasText: uniqueTitle })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  // Input should be cleared
  await expect(input).toHaveValue('')
})

// ── Toggle task complete ──

test('complete task via phase picker', async ({ page }) => {
  // Create a fresh task via API with unique name
  const task = await createTaskViaApi('Toggle test task')

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  // Find the task item by its unique title
  const taskItem = page.locator('.todo-panel-item', { hasText: task.title })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  // Complete the task through the current phase picker.
  await taskItem.getByRole('button', { name: 'To Do', exact: true }).click()
  await taskItem.getByRole('button', { name: 'Complete', exact: true }).click()

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
  await showAllTasks(page)

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
  await showAllTasks(page)

  // Wait for the task to appear
  const taskItem = page.locator('.todo-panel-item', { hasText: task.title })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  // Click the row padding to focus it without entering inline title editing.
  await taskItem.click({ position: { x: 4, y: 4 } })

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
  await showAllTasks(page)

  // Both should be visible in "All" tab
  await expect(page.locator('.todo-panel-item', { hasText: workTask.title })).toBeVisible({ timeout: 3000 })
  await expect(page.locator('.todo-panel-item', { hasText: lifeTask.title })).toBeVisible({ timeout: 3000 })

  await selectCategory(page, 'Work')
  await expect(page.locator('.todo-panel-item', { hasText: workTask.title })).toBeVisible()
  await expect(page.locator('.todo-panel-item', { hasText: lifeTask.title })).toBeHidden()
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
