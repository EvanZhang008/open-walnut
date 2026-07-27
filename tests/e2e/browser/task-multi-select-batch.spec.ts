/**
 * Multi-select batch actions — "complete N tasks" / "delete N tasks" from the
 * Todo panel's selection bar.
 *
 * REPRO of the reported bug: entering multi-select (kebab → "Select…", then
 * clicking rows) showed a selection bar whose only verbs were Group, priority, pin
 * and date. There was NO Complete and NO Delete anywhere in the batch dropdown, so
 * a user who had picked 10 tasks could not complete or delete them — the feature
 * looked broken because the actions genuinely did not exist.
 *
 * Every interaction below is a real UI click (no page.goto navigation, no direct
 * API mutation for the action under test) so the whole chain is exercised:
 * checkbox → selection bar → batch dropdown → REST batch endpoint → WS → row state.
 */
import { test, expect, type Page } from '@playwright/test'
import { showEverything } from './todo-panel-helpers'

const API = 'http://localhost:3457'

// Serial: every test here mutates the ONE shared fixture task list (and the Reopen
// test flips the panel's "Show completed" pref, which round-trips through
// /api/ui-prefs). Under the config's fullyParallel default, a sibling's completes/
// deletes re-render the list from under an in-flight click — a harness interference
// artifact, not a product bug. Same reason the codex-* specs run serial.
test.describe.configure({ mode: 'serial' })

/** Seed a task via REST (setup only — never the action under test). */
async function seedTask(title: string): Promise<{ id: string; title: string }> {
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, category: 'Work', project: 'Marina' }),
  })
  if (!res.ok) throw new Error(`seed failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string; title: string } }
  return body.task
}

async function fetchTask(id: string): Promise<{ phase: string; status: string } | null> {
  const res = await fetch(`${API}/api/tasks/${id}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`)
  const body = (await res.json()) as { task: { phase: string; status: string } }
  return body.task
}

function row(page: Page, title: string) {
  return page.locator('.todo-panel-item', { hasText: title }).first()
}

/** Enter multi-select via the row kebab's "Select…" entry, then pick more rows. */
async function selectRows(page: Page, titles: string[]) {
  const first = row(page, titles[0])
  await expect(first).toBeVisible({ timeout: 15_000 })
  await first.locator('.task-kebab-btn').click()
  await page.locator('.task-kebab-menu').getByText('Select…').click()
  // Select mode: a plain click on any row toggles it into the selection.
  for (const title of titles.slice(1)) {
    await row(page, title).click()
  }
  await expect(page.locator('.task-selection-bar')).toBeVisible()
  await expect(page.locator('.task-selection-count')).toHaveText(`${titles.length} selected`)
}

/** Open the selection bar's batch dropdown (the ▾ half of the Group split button). */
async function openBatchMenu(page: Page) {
  await page.locator('.task-batch-caret').click()
  await expect(page.locator('.task-batch-dropdown')).toBeVisible()
}

async function setup(page: Page, titles: string[]) {
  const tasks = []
  for (const title of titles) tasks.push(await seedTask(title))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showEverything(page)
  await page.waitForTimeout(500)
  return tasks
}

test('batch dropdown offers Complete and Delete for a multi-selection', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const titles = [`Batch menu A ${stamp}`, `Batch menu B ${stamp}`]
  await setup(page, titles)

  await selectRows(page, titles)
  await openBatchMenu(page)

  // The two verbs that were entirely missing before this fix.
  const menu = page.locator('.task-batch-dropdown')
  await expect(menu.getByText(/^Complete/)).toBeVisible()
  await expect(menu.getByText(/^Delete/)).toBeVisible()
})

test('multi-select completes every selected task', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const titles = [`Batch done A ${stamp}`, `Batch done B ${stamp}`, `Batch done C ${stamp}`]
  const tasks = await setup(page, titles)

  await selectRows(page, titles)
  await openBatchMenu(page)
  await page.locator('.task-batch-dropdown').getByText(/^Complete/).click()

  // Selection bar closes — the action was the user's intent, so select mode exits.
  await expect(page.locator('.task-selection-bar')).toBeHidden({ timeout: 10_000 })

  // Server truth: all three are COMPLETE.
  await expect.poll(async () => {
    const phases = await Promise.all(tasks.map(async (t) => (await fetchTask(t.id))?.phase))
    return phases.join(',')
  }, { timeout: 15_000 }).toBe('COMPLETE,COMPLETE,COMPLETE')
})

test('multi-select deletes every selected task after confirming', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const titles = [`Batch del A ${stamp}`, `Batch del B ${stamp}`, `Batch del C ${stamp}`]
  const tasks = await setup(page, titles)

  await selectRows(page, titles)
  await openBatchMenu(page)
  await page.locator('.task-batch-dropdown').getByText(/^Delete/).click()

  // Destructive → the app's own confirm dialog (never window.confirm).
  const dialog = page.locator('.app-modal-overlay[role="dialog"]').first()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await expect(dialog).toContainText('3 tasks')
  await dialog.getByRole('button', { name: 'Delete' }).click()

  await expect(page.locator('.task-selection-bar')).toBeHidden({ timeout: 10_000 })

  // All three are gone server-side.
  await expect.poll(async () => {
    const results = await Promise.all(tasks.map((t) => fetchTask(t.id)))
    return results.filter(Boolean).length
  }, { timeout: 15_000 }).toBe(0)

  // And their rows are gone from the list.
  for (const title of titles) {
    await expect(page.locator('.todo-panel-item', { hasText: title })).toHaveCount(0)
  }
})

test('cancelling the delete confirm keeps every task', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const titles = [`Batch keep A ${stamp}`, `Batch keep B ${stamp}`]
  const tasks = await setup(page, titles)

  await selectRows(page, titles)
  await openBatchMenu(page)
  await page.locator('.task-batch-dropdown').getByText(/^Delete/).click()

  const dialog = page.locator('.app-modal-overlay[role="dialog"]').first()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await dialog.getByRole('button', { name: /Cancel/i }).click()

  // Nothing deleted — the tasks still exist.
  for (const t of tasks) {
    expect(await fetchTask(t.id)).not.toBeNull()
  }
})

test('a done selection offers Reopen instead of Complete', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const titles = [`Batch reopen A ${stamp}`, `Batch reopen B ${stamp}`]
  const tasks = await setup(page, titles)

  // Complete them through the UI first.
  await selectRows(page, titles)
  await openBatchMenu(page)
  await page.locator('.task-batch-dropdown').getByText(/^Complete/).click()
  await expect.poll(async () => (await fetchTask(tasks[0].id))?.phase, { timeout: 15_000 }).toBe('COMPLETE')

  // Show done rows, re-select them, and the menu should now offer Reopen.
  await page.getByRole('button', { name: 'View options' }).click()
  await page.locator('.vd-check input[type="checkbox"]').check()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  await selectRows(page, titles)
  await openBatchMenu(page)
  const menu = page.locator('.task-batch-dropdown')
  await expect(menu.getByText(/^Reopen/)).toBeVisible()
  await expect(menu.getByText(/^Complete/)).toHaveCount(0)

  await menu.getByText(/^Reopen/).click()
  await expect.poll(async () => {
    const phases = await Promise.all(tasks.map(async (t) => (await fetchTask(t.id))?.phase))
    return phases.join(',')
  }, { timeout: 15_000 }).toBe('TODO,TODO')

  // Restore "Show completed" — it persists via /api/ui-prefs on the shared fixture,
  // so leaving it on changes what later specs (here and in other files) see.
  await page.getByRole('button', { name: 'View options' }).click()
  await page.locator('.vd-check input[type="checkbox"]').uncheck()
  await page.keyboard.press('Escape')
})

// ── Second surface: the /tasks page (TaskList cards) ──
// TodoPanel and TaskList each own their OWN selection bar, so a fix to one does not
// fix the other. Before this change the /tasks bar had ONLY "Group" — same bug.

test('/tasks page selection bar can complete and delete a multi-selection', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const titles = [`Cards batch A ${stamp}`, `Cards batch B ${stamp}`]
  const tasks = []
  for (const title of titles) tasks.push(await seedTask(title))

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Real UI navigation: expand the sidebar "Other" group, then click Tasks.
  await page.getByRole('button', { name: /Other/ }).click()
  await page.getByRole('link', { name: 'Tasks' }).click()
  await expect(page).toHaveURL(/\/tasks/)
  await page.waitForLoadState('networkidle')

  const card = (title: string) => page.locator('.task-card', { hasText: title }).first()
  await expect(card(titles[0])).toBeVisible({ timeout: 15_000 })

  // Modifier-click builds the selection on this surface.
  await card(titles[0]).click({ modifiers: ['Meta'] })
  await card(titles[1]).click({ modifiers: ['Meta'] })

  const bar = page.locator('.task-selection-bar')
  await expect(bar).toBeVisible()
  await expect(page.locator('.task-selection-count')).toHaveText('2 selected')

  // Complete — the verb that did not exist on this surface either.
  await bar.getByRole('button', { name: /Complete/ }).click()
  await expect.poll(async () => {
    const phases = await Promise.all(tasks.map(async (t) => (await fetchTask(t.id))?.phase))
    return phases.join(',')
  }, { timeout: 15_000 }).toBe('COMPLETE,COMPLETE')
})
