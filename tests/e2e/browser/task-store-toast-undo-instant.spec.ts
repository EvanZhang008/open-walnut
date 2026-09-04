/**
 * One browser, one task store — the "Task created" toast's Undo.
 *
 * Undo used to call the DELETE endpoint directly, bypassing the store's
 * optimistic removal, so the board row, the Focus Dock card and every task-ref
 * pill kept drawing a task the user had just taken back until the `task:deleted`
 * echo arrived. Undo now goes through the store's `deleteTask`.
 *
 * The DELETE is HELD at the network layer for HOLD_MS: the row has to be gone
 * long before the server is even asked.
 */
import { expect, test, type APIRequestContext } from '@playwright/test'

const HOLD_MS = 3000
const INSTANT_MS = 700

async function findTaskId(request: APIRequestContext, title: string): Promise<string> {
  let id: string | null = null
  await expect.poll(async () => {
    const response = await request.get('/api/tasks')
    const body = await response.json() as { tasks: { id: string; title: string }[] }
    id = body.tasks.find((t) => t.title === title)?.id ?? null
    return id
  }, { timeout: 15_000, message: 'the quick-added task never reached the server' }).not.toBeNull()
  return id!
}

test('Undo on the "Task created" toast drops the board row before the DELETE is answered', async ({ page, request }) => {
  const title = `Quick capture ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // Deterministic parse: the composer's AI back-fill is not what this spec is about.
  await page.route('**/api/tasks/quick-parse', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ title }),
  }))

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('.quick-access-pill').first().click()
  const composer = page.locator('.quick-task-composer')
  await expect(composer).toBeVisible()
  await page.locator('.qtc-input').fill(title)
  const panel = page.locator('.qtc-confirm-panel')
  await expect(panel.locator('.qtc-confirm-title')).toHaveValue(title)
  await panel.locator('.qtc-confirm-primary').click()

  // ONE locator for the toast: the 'sort' kind auto-dismisses, so two sequential
  // expects could straddle the dismissal.
  const toast = page
    .locator('.notification-toast--success', { hasText: 'Task created' })
    .filter({ has: page.locator('.notification-toast-action', { hasText: 'Undo' }) })
  await expect(toast).toBeVisible({ timeout: 20_000 })

  const taskId = await findTaskId(request, title)
  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(row).toBeVisible({ timeout: 10_000 })

  // Hold the DELETE: the server does not see it until the hold ends.
  let deletesAnswered = 0
  await page.route(`**/api/tasks/${taskId}`, async (route) => {
    if (route.request().method() !== 'DELETE') { await route.continue(); return }
    await new Promise((r) => setTimeout(r, HOLD_MS))
    deletesAnswered++
    await route.continue()
  })

  await toast.locator('.notification-toast-action', { hasText: 'Undo' }).click()
  await expect(row).toHaveCount(0, { timeout: INSTANT_MS })
  expect(deletesAnswered).toBe(0)

  // The held DELETE lands and the task is really gone (the optimistic removal
  // was a prediction, not a substitute for the write).
  await expect.poll(() => deletesAnswered, { timeout: HOLD_MS * 4 }).toBe(1)
  await expect.poll(async () => {
    const response = await request.get('/api/tasks')
    const body = await response.json() as { tasks: { title: string }[] }
    return body.tasks.filter((t) => t.title === title).length
  }, { timeout: 15_000 }).toBe(0)
  await expect(row).toHaveCount(0)
})
