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
import { selectProject, showEverything } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

/**
 * Make every task visible: the "All" PROJECT chip (so no project scoping) plus the
 * "All" SECTION tab (so the main task list and the pinned tiers are all mounted).
 * These are two independent axes — the panel defaults to the Focus section tab, in
 * which `.todo-panel-item` rows don't exist at all.
 */
async function showAllTasks(page: Page): Promise<void> {
  await showEverything(page)
}

// Helper: create task via REST API with unique suffix for parallel safety
async function createTaskViaApi(
  title: string,
  opts: Record<string, unknown> = {},
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

test('Date=Now hides future tasks from the pinned area', async ({ page }) => {
  // Now is START-date driven (2c4d557f): a future due date is a deadline and
  // never hides a task; only a future start_date defers it out of Now.
  const futurePinned = await createTaskViaApi('Future pinned date filter', {
    project: 'Work',
    start_date: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  })
  const currentPinned = await createTaskViaApi('Current pinned date filter', {
    project: 'Work',
  })
  await pinTaskViaApi(futurePinned.id)
  await pinTaskViaApi(currentPinned.id)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  const pinnedCard = (taskId: string) => page.locator(`.todo-focus-card[data-task-id="${taskId}"]`)

  await page.getByRole('button', { name: 'View options' }).click()
  // The Date filter renders as direct All/Now buttons in the "Quick filters"
  // rail section (the panel's landing section).
  await page.locator('.vd-rail-btn[data-rail-section="quick"]').click()
  await page.locator('.vd-panel .vd-seg-btn[data-date-value=""]').click()
  await page.keyboard.press('Escape')
  await expect(pinnedCard(futurePinned.id)).toBeVisible({ timeout: 5000 })
  await expect(pinnedCard(currentPinned.id)).toBeVisible()

  await page.getByRole('button', { name: 'View options' }).click()
  await page.locator('.vd-rail-btn[data-rail-section="quick"]').click()
  await page.locator('.vd-panel .vd-seg-btn[data-date-value="now"]').click()
  await page.keyboard.press('Escape')
  await expect(pinnedCard(futurePinned.id)).toBeHidden()
  await expect(pinnedCard(currentPinned.id)).toBeVisible()
})

test('search and filters apply across pinned, recent, and task sections', async ({ page }) => {
  const query = `shared-query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // The toolbar-filter leg below uses the legacy DATE filter (Priority and Tag
  // were retired from Quick filters 2026-08-23 — priority lives in the
  // canonical query rail, which search deliberately does NOT bypass).
  // filterMismatch is deferred (future start_date), so Date=Now hides it.
  const matchingPinned = await createTaskViaApi(`Pinned ${query} match`, {
    project: 'Work',
  })
  const filterMismatch = await createTaskViaApi(`Pinned ${query} deferred mismatch`, {
    project: 'Work',
    start_date: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  })
  const searchMismatch = await createTaskViaApi('Pinned unrelated search target', {
    project: 'Work',
  })
  const unpinnedMatch = await createTaskViaApi(`Unpinned ${query} match`, {
    project: 'Work',
  })
  await pinTaskViaApi(matchingPinned.id)
  await pinTaskViaApi(filterMismatch.id)
  await pinTaskViaApi(searchMismatch.id)
  await groupTasksViaApi([matchingPinned.id, filterMismatch.id, searchMismatch.id])

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  // Date defaults to Now, which would hide the deferred fixture from the very
  // first assertion — start from the neutral All view; the filter leg below
  // flips it to Now mid-search.
  await page.getByRole('button', { name: 'View options' }).click()
  await page.locator('.vd-rail-btn[data-rail-section="quick"]').click()
  await page.locator('.vd-panel .vd-seg-btn[data-date-value=""]').click()
  await page.keyboard.press('Escape')

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
  await expect(pinnedCard(filterMismatch.id)).toBeVisible()
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
  await expect(pinnedCard(filterMismatch.id)).toBeVisible()
  await expect(pinnedCard(searchMismatch.id)).toBeHidden()
  await expect(pinnedCount).toHaveText('2')
  await expect(recentCard(matchingPinned.id)).toBeVisible()
  await expect(recentCard(filterMismatch.id)).toBeVisible()
  await expect(recentCard(unpinnedMatch.id)).toBeVisible()
  await expect(recentCard(searchMismatch.id)).toBeHidden()
  await expect(recentCount).toHaveText('3')
  await expect(taskList.locator('.todo-panel-item', { hasText: unpinnedMatch.title })).toBeVisible()

  await serverSearchStarted
  releaseServerSearch()
  await expect(page.locator('.todo-search-spinner')).toBeHidden()
  await expect(pinnedCard(matchingPinned.id)).toBeVisible()
  await expect(pinnedCard(filterMismatch.id)).toBeVisible()
  await expect(recentCard(unpinnedMatch.id)).toBeVisible()

  await page.getByRole('button', { name: 'View options' }).click()
  // The Date buttons render in the "Quick filters" rail section of the panel.
  await page.locator('.vd-rail-btn[data-rail-section="quick"]').click()
  await page.locator('.vd-panel .vd-seg-btn[data-date-value="now"]').click()
  await page.keyboard.press('Escape')

  // Search ignores EVERY toolbar filter (user ruling 2026-08-09 — see
  // todo-search-ignores-filters.spec.ts): while the query is active, the
  // Date=Now filter must NOT hide a matching (deferred) card anywhere. It only
  // takes effect once the query is cleared (asserted below).
  await expect(pinnedCard(matchingPinned.id)).toBeVisible()
  await expect(pinnedCard(filterMismatch.id)).toBeVisible()
  await expect(pinnedCard(searchMismatch.id)).toBeHidden()
  await expect(pinnedCount).toHaveText('2')
  await expect(recentCard(matchingPinned.id)).toBeVisible()
  await expect(recentCard(filterMismatch.id)).toBeVisible()
  await expect(recentCard(searchMismatch.id)).toBeHidden()
  await expect(recentCard(unpinnedMatch.id)).toBeVisible()
  await expect(recentCount).toHaveText('3')
  await expect(taskList.locator('.todo-panel-item', { hasText: unpinnedMatch.title })).toBeVisible()

  await page.getByTitle('Clear search (Esc)').click()
  await expect(pinnedCard(matchingPinned.id)).toBeVisible()
  await expect(pinnedCard(filterMismatch.id)).toBeHidden()
  await expect(pinnedCard(searchMismatch.id)).toBeVisible()
  await expect(recentCard(matchingPinned.id)).toBeVisible()
  await expect(recentCard(filterMismatch.id)).toBeHidden()
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
      id === matchingPinned.id || id === filterMismatch.id || id === searchMismatch.id
    )
  }).toEqual([searchMismatch.id, filterMismatch.id, matchingPinned.id])
})

// ── Create task ──

test('create task via quick-add form', async ({ page }) => {
  const uniqueTitle = `Browser created task ${Date.now()}`

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  // The old always-visible quick-add input was retired; adding is now the
  // InlineAdd row ("+ Add to Focus…" trigger → title input → Enter).
  await page.locator('.focus-inline-add-trigger').first().click()
  const input = page.locator('.focus-inline-add input')
  await input.fill(uniqueTitle)
  await input.press('Enter')

  // The new task lands in the Focus tier area.
  const card = page.locator(`.todo-focus-card`, { hasText: uniqueTitle })
  await expect(card).toBeVisible({ timeout: 5000 })

  // Input stays open for rapid multi-add, but clears after a successful create.
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

  // Complete the task: the phase control is now a single circle button that
  // toggles To Do ↔ Complete (the multi-option picker was retired with the
  // two-state simplification).
  await taskItem.getByRole('button', { name: 'Mark complete' }).click()

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
  const task = await createTaskViaApi('WS update task', { project: 'Work', priority: 'immediate' })

  // Wait for the task to appear via WebSocket push (no page refresh)
  const taskItem = page.locator('.todo-panel-item', { hasText: task.title })
  await expect(taskItem).toBeVisible({ timeout: 5000 })
})

// ── Task detail navigation ──

test('click task navigates to detail page', async ({ page }) => {
  const task = await createTaskViaApi('Detail nav task', { project: 'Work' })

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

// ── Project chips ──

test('project chips filter tasks', async ({ page }) => {
  // Create tasks in different projects with unique names
  const workTask = await createTaskViaApi('Work project task', { project: 'Work' })
  const lifeTask = await createTaskViaApi('Life project task', { project: 'Life' })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  // Both should be visible in "All" tab
  await expect(page.locator('.todo-panel-item', { hasText: workTask.title })).toBeVisible({ timeout: 3000 })
  await expect(page.locator('.todo-panel-item', { hasText: lifeTask.title })).toBeVisible({ timeout: 3000 })

  await selectProject(page, 'Work')
  await expect(page.locator('.todo-panel-item', { hasText: workTask.title })).toBeVisible()
  await expect(page.locator('.todo-panel-item', { hasText: lifeTask.title })).toBeHidden()
})

test('pinned + recent stay visible across project chips (cross-project focus view)', async ({ page }) => {
  // Regression: a pinned task from another project must NOT vanish when the user
  // navigates to a different project chip. Pins are a cross-project focus view —
  // scoping the Pinned/Recent sections to the active chip made "all my focused tasks
  // disappeared" (they reappeared only on search, which bypasses the chip).
  const query = `xproj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const lifePinned = await createTaskViaApi(`Life pinned ${query}`, { project: 'Life' })
  const workTask = await createTaskViaApi(`Work list ${query}`, { project: 'Work' })
  await pinTaskViaApi(lifePinned.id)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  const pinnedCard = page.locator(`.todo-focus-card[data-task-id="${lifePinned.id}"]`)
  const recentCard = page.locator(`.todo-pinned-section-recent .todo-pinned-card[data-task-id="${lifePinned.id}"]`)
  await expect(pinnedCard).toBeVisible({ timeout: 5000 })

  // Navigate to the Work chip — the Life-project pin must remain visible in both the
  // Pinned tier and the Recent feed even though it belongs to a different project.
  // (No global pinned-count assertion: /api/focus/tasks is shared state and this suite
  // runs fully parallel, so other tests' pins would make an exact count flaky.)
  await selectProject(page, 'Work')
  await expect(page.locator('.todo-panel-item', { hasText: workTask.title })).toBeVisible()
  await expect(pinnedCard).toBeVisible()
  await expect(recentCard).toBeVisible()
  // The Work-project list item must NOT leak into the Pinned tier (it isn't pinned).
  await expect(page.locator(`.todo-focus-card[data-task-id="${workTask.id}"]`)).toHaveCount(0)
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
