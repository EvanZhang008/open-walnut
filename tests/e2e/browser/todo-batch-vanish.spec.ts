/**
 * Completion grace window is a SHARED batch deadline, not per-task timers.
 *
 * Completing task B while task A is still inside its 3s post-completion grace
 * window must extend A's visibility to B's deadline (latest completion +
 * GRACE_MS) so the whole batch vanishes together. Per-task timers made rows
 * disappear one by one under the user's cursor while they were still checking
 * off the rest of the list.
 */
import { test, expect, type Page } from '@playwright/test'
import { showEverything } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

async function createTaskViaApi(title: string): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: uniqueTitle, source: 'local' }),
  })
  if (!res.ok) throw new Error(`API call failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string; title: string } }
  return body.task
}

async function completeTask(page: Page, title: string): Promise<void> {
  const item = page.locator('.todo-panel-item', { hasText: title })
  await item.getByRole('button', { name: 'Mark complete' }).click()
  // Done styling confirms the completion round-tripped before we start timing.
  await expect(item).toHaveClass(/todo-panel-item-done/, { timeout: 5000 })
}

test('completing a second task extends the first one\'s grace window — both vanish together', async ({ page }) => {
  const taskA = await createTaskViaApi('Batch vanish A')
  const taskB = await createTaskViaApi('Batch vanish B')

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showEverything(page)

  const itemA = page.locator('.todo-panel-item', { hasText: taskA.title })
  const itemB = page.locator('.todo-panel-item', { hasText: taskB.title })
  await expect(itemA).toBeVisible({ timeout: 5000 })
  await expect(itemB).toBeVisible()

  await completeTask(page, taskA.title)
  // Complete B mid-way through A's 3.15s grace window.
  await page.waitForTimeout(1800)
  await completeTask(page, taskB.title)

  // A's solo deadline (~3.15s after its completion) has now passed, but B's
  // completion pushed the SHARED deadline forward — A must still be visible.
  await page.waitForTimeout(1800)
  await expect(itemA).toBeVisible()
  await expect(itemB).toBeVisible()

  // …and at the shared deadline (B + 3.15s) both leave together.
  await expect(itemA).toBeHidden({ timeout: 4000 })
  await expect(itemB).toBeHidden({ timeout: 500 })
})

test('a single completed task still vanishes after ~3s', async ({ page }) => {
  const task = await createTaskViaApi('Solo vanish')

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showEverything(page)

  const item = page.locator('.todo-panel-item', { hasText: task.title })
  await expect(item).toBeVisible({ timeout: 5000 })

  await completeTask(page, task.title)

  // Grace hold: still visible right after completing…
  await page.waitForTimeout(1000)
  await expect(item).toBeVisible()
  // …gone once the 3.15s window closes.
  await expect(item).toBeHidden({ timeout: 4000 })
})
