/**
 * One browser, one task store: the Undo (mod+z) of a task just created from the draft column.
 * The create shows no toast (its row is on screen; the UI standard's toast rule), so mod+z is
 * its Undo.
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
import { draftComposer, draftPanels, openDraft } from './draft-helpers'

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

test('mod+z after "Save as todo" drops the board row before the DELETE is answered', async ({ page, request }) => {
  // The 5 s Undo window, stretched: this test is about how fast the row goes, not the window.
  await page.addInitScript(() => {
    const original = window.setTimeout.bind(window)
    window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) =>
      original(fn, delay === 5000 ? 120_000 : delay, ...args)) as typeof window.setTimeout
  })
  const title = `Quick capture ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // Deterministic parse: the draft's AI back-fill is not what this spec is about.
  await page.route('**/api/tasks/quick-parse', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ title }),
  }))

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // The draft column is the one place a task is created; "Save as task"
  // is its no-session path.
  const panel = await openDraft(page)
  await draftComposer(page).fill(title)
  await panel.locator('.draft-later-btn').click()
  await expect(draftPanels(page)).toHaveCount(0, { timeout: 10_000 })

  const taskId = await findTaskId(request, title)
  // A new task is born pinned, so its row may be in the Pinned section: any row of it.
  const row = page.locator(`#home-task-navigation [data-task-id="${taskId}"]`)
  await expect(row.first()).toBeVisible({ timeout: 30_000 })

  // Hold the DELETE: the server does not see it until the hold ends.
  let deletesAnswered = 0
  await page.route(`**/api/tasks/${taskId}`, async (route) => {
    if (route.request().method() !== 'DELETE') { await route.continue(); return }
    await new Promise((r) => setTimeout(r, HOLD_MS))
    deletesAnswered++
    await route.continue()
  })

  await expect(page.locator('.notification-toast', { hasText: 'Task created' })).toHaveCount(0)
  // Outside any text box, so the key is the app's Undo and not the composer's.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('ControlOrMeta+z')
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
