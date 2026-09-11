/**
 * The task kebab (⋮) menu is LEAN by default. Each rule here removed a row the
 * user called noise on 2026-09-10:
 *
 *  1. No "Unread" row. Opening the task marks it read; the red dot on the row
 *     already says it is unread.
 *  2. No "Unpin" row. The highlighted tier pill IS the pin: clicking it again
 *     unpins. Same rule in the session panel's kebab, which now renders the same
 *     shared block (TaskActionMenuItems).
 *  3. Start / Due are collapsed rows; the calendar appears only when clicked.
 *     Two always-open calendars were most of the menu's height.
 *  4. Priority is hidden until Settings → Tasks → "Show task priority" is on
 *     (`ui.show_priority`). Most people never use the four levels.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

test.setTimeout(120_000)
test.describe.configure({ mode: 'serial' })

const litter: string[] = []

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all' })
})

test.afterEach(async () => {
  for (const id of litter.splice(0)) {
    await fetch(`${API}/api/focus/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  }
  // Leave the shared fixture config the way the other specs expect it.
  await setShowPriority(false)
})

async function createTask(title: string): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: uniqueTitle, source: 'local' }),
  })
  if (!res.ok) throw new Error(`task create failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string; title: string } }
  litter.push(body.task.id)
  return body.task
}

async function pinToFocus(taskId: string): Promise<void> {
  const pin = await fetch(`${API}/api/focus/tasks/${taskId}`, { method: 'POST' })
  if (!pin.ok) throw new Error(`pin failed: ${pin.status} ${await pin.text()}`)
  const res = await fetch(`${API}/api/focus/tasks/${taskId}/tier`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'focus' }),
  })
  if (!res.ok) throw new Error(`tier failed: ${res.status} ${await res.text()}`)
}

async function pinnedIds(): Promise<string[]> {
  const res = await fetch(`${API}/api/focus/tasks`)
  return ((await res.json()) as { pinned_tasks: string[] }).pinned_tasks
}

async function setShowPriority(on: boolean): Promise<void> {
  // GET /api/config wraps the file under `config`; merge the rest of `ui` so
  // sibling keys (session_panels) survive the write.
  const body = (await (await fetch(`${API}/api/config`)).json()) as { config?: { ui?: Record<string, unknown> } }
  const res = await fetch(`${API}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ui: { ...(body.config?.ui ?? {}), show_priority: on } }),
  })
  if (!res.ok) throw new Error(`config write failed: ${res.status} ${await res.text()}`)
}

async function taskDueDate(taskId: string): Promise<string | undefined> {
  const res = await fetch(`${API}/api/tasks/${taskId}`)
  return ((await res.json()) as { task: { due_date?: string } }).task.due_date || undefined
}

/** Open the board row's ⋮ menu; returns the visible menu. */
async function openRowKebab(page: Page, task: { id: string; title: string }): Promise<Locator> {
  await page.locator('.todo-search-input').fill(task.title)
  const row = page.locator(`.todo-panel-item[data-task-id="${task.id}"]`)
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu).toBeVisible()
  return menu
}

test('no unread row, no unpin row, no priority, dates collapsed until clicked', async ({ page }) => {
  const task = await createTask('Lean kebab')
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const menu = await openRowKebab(page, task)

  await expect(menu.getByText('Unread', { exact: false })).toHaveCount(0)
  await expect(menu.getByText('Unpin', { exact: true })).toHaveCount(0)
  await expect(menu.locator('.task-kebab-priority')).toHaveCount(0)

  // The tier pills are still there (4 built-ins, plus any custom tier another
  // spec left in the shared fixture): pinning is one click, unpinning the same pill.
  expect(await menu.locator('.task-kebab-tier-btn').count()).toBeGreaterThanOrEqual(4)

  const toggles = menu.locator('.task-kebab-date-toggle')
  await expect(toggles).toHaveCount(2)
  await expect(toggles.nth(0)).toContainText('Start')
  await expect(toggles.nth(1)).toContainText('Due')
  await expect(menu.locator('.dp-content')).toHaveCount(0)

  // Click Due: its calendar opens (and only its calendar).
  await toggles.nth(1).click()
  await expect(menu.locator('.dp-content')).toHaveCount(1)
  await expect(toggles.nth(1)).toHaveAttribute('aria-expanded', 'true')
  await expect(toggles.nth(0)).toHaveAttribute('aria-expanded', 'false')

  // Picking a quick pill still writes the date and closes the menu.
  await menu.locator('.dp-content .dp-pill', { hasText: '2h' }).click()
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  await expect.poll(() => taskDueDate(task.id), { timeout: 10_000 }).toBeTruthy()

  // The collapsed row now carries the date, so the value is visible without expanding.
  const again = await openRowKebab(page, task)
  await expect(again.locator('.task-kebab-date-toggle').nth(1)).toContainText('Due:')
  await expect(again.locator('.dp-content')).toHaveCount(0)
})

test('the lit tier pill is the pin: clicking it again unpins', async ({ page }) => {
  const task = await createTask('Pill unpin')
  await pinToFocus(task.id)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const menu = await openRowKebab(page, task)

  await expect(menu.locator('.task-kebab-tier-label')).toHaveText('Pinned')
  const lit = menu.locator('.task-kebab-tier-btn.active')
  await expect(lit).toHaveCount(1)
  await expect(lit).toHaveAttribute('title', /^Unpin from Focus/)

  await lit.click()
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  await expect.poll(async () => (await pinnedIds()).includes(task.id), { timeout: 10_000 }).toBe(false)

  // Reopened: nothing lit, label back to "Pin to", still no separate Unpin row.
  const again = await openRowKebab(page, task)
  await expect(again.locator('.task-kebab-tier-label')).toHaveText('Pin to')
  await expect(again.locator('.task-kebab-tier-btn.active')).toHaveCount(0)
  await expect(again.getByText('Unpin', { exact: true })).toHaveCount(0)
})

test('priority comes back when ui.show_priority is on', async ({ page }) => {
  const task = await createTask('Priority setting')
  await setShowPriority(true)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const menu = await openRowKebab(page, task)
  await expect(menu.locator('.task-kebab-priority')).toHaveCount(1)
  await expect(menu.locator('.task-kebab-priority .badge')).toHaveCount(4)
})
