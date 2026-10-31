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
 *   cd web && bun x vite build    (builds SPA to dist/web/static/)
 *   npx playwright test          (runs these tests)
 */
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs, selectProject, selectSection, showEverything } from './todo-panel-helpers'
import { openTierInlineAdd } from './status-section-helpers'
import { addFilter } from './filter-bar-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

/**
 * Make every task visible: the "All" PROJECT chip (so no project scoping) plus the
 * "All" SECTION tab (so the main task list and the pinned tiers are all mounted).
 * These are two independent axes: the panel defaults to the Focus section tab, in
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
    // Unpinned: these tests look for the row in the task list. A create is born on
    // the pinned board unless it says otherwise (ddda11ac4, newTaskPinDefault).
    body: JSON.stringify({ title: uniqueTitle, source: 'local', pinned: false, ...opts }),
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

// The home panel toggles (Todo collapse below) are synced layout preferences; isolate
// ui-prefs so a collapse left behind by a failed run never reaches the shared fixture.
test.beforeEach(async ({ page }) => { await isolateUiPrefs(page) })

// ── App loads ──

test('app loads and shows main page elements', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await expect(page.locator('.main-page')).toBeVisible()

  // Todo panel should be visible
  await expect(page.locator('.todo-panel')).toBeVisible()

  // The chat slot starts hidden here (isolateUiPrefs seeds it closed, as a returning
  // user's layout): the sidebar's Ask Walnut opens it with its composer.
  await page.getByRole('group', { name: 'Home panels' }).getByRole('button', { name: 'Ask Walnut', exact: true }).click()
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

  // Date lives in the Filter popover's Date row (Any date).
  await addFilter(page, 'date', '')
  await expect(pinnedCard(futurePinned.id)).toBeVisible({ timeout: 5000 })
  await expect(pinnedCard(currentPinned.id)).toBeVisible()

  // Date lives in the Filter popover's Date row (Available now).
  await addFilter(page, 'date', 'now')
  await expect(pinnedCard(futurePinned.id)).toBeHidden()
  await expect(pinnedCard(currentPinned.id)).toBeVisible()
})

// "search and filters apply across pinned, recent, and task sections" was deleted
// 2026-10-31: it read the retired `.todo-pinned-label` headings and a Recent feed
// that All no longer draws. todo-search-pinned-recent.spec.ts and
// todo-search-and-filters.spec.ts cover search over the pin area and the filters.

// ── Create task ──

test('create task via quick-add form', async ({ page }) => {
  const uniqueTitle = `Browser created task ${Date.now()}`

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  // The old always-visible quick-add input was retired; adding is now the
  // InlineAdd row (title input → Enter). A tier that holds tasks draws no standing
  // "+ Add to Focus…" row: the Focus tier's "+" → New task opens it. In All that is
  // the Focus sub-heading; a lone tier draws no heading, so use the Focus view then.
  const focusHeading = page.locator('.todo-pinned-subgroup-heading').filter({ has: page.locator('[data-navigation-id="focus"]') })
  const heading = (await focusHeading.count()) > 0
    ? focusHeading.first()
    : (await selectSection(page, 'Focus'), page.getByTestId('tier-view-bar'))
  const input = await openTierInlineAdd(page, heading)
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

test('click task opens it on Home', async ({ page }) => {
  const task = await createTaskViaApi('Detail nav task', { project: 'Work' })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showAllTasks(page)

  // Wait for the task to appear
  const taskItem = page.locator('.todo-panel-item', { hasText: task.title })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  // Click the row padding to focus it without entering inline title editing.
  await taskItem.click({ position: { x: 4, y: 4 } })

  // A task opens on Home with its row selected and named in the URL, never the
  // separate task page (2026-10-26).
  await expect(page).toHaveURL(new RegExp(`[?&]task=${task.id}`))
  await expect(page.locator(`[data-task-id="${task.id}"].task-focused, [data-task-id="${task.id}"].todo-pinned-card-active`).first()).toBeVisible()
  await expect(page).not.toHaveURL(/\/tasks\//)
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

// "pinned + recent stay visible across project chips" was deleted 2026-10-31: it
// guarded the old project chips, which scoped only the list. The Filter bar
// (67ee2a38d, 2026-10-02) has one hit test for every surface, so a Project filter
// narrows the pin area too, by design (filter-predicate.ts).

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
