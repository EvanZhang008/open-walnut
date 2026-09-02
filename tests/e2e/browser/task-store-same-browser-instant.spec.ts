/**
 * One browser, one task store: a task edit made in a session panel header
 * shows up on the board row (and the other way round) in the same frame,
 * without waiting for the server.
 *
 * Regression guarded (2026-09-02): the session header renamed its task with a
 * direct REST call and kept a private copy of the task, so the board only
 * learned about the new title from the WebSocket echo. When the server's event
 * loop stalled (a PATCH measured 7.2s that day) the header showed the new title
 * while the board kept the old one for seconds. Now every surface reads the
 * shared task store and writes through its optimistic mutators; the REST
 * round-trip only confirms.
 *
 * The PATCH is held for HOLD_MS at the network layer, so any propagation that
 * still rode the server round-trip would fail the sub-second assertions.
 */
import { expect, test, type Page } from '@playwright/test'

const SESSION_ID = 'pw-store-sync-session'
const TASK_ID = 'pw-task-store-sync'
const HOLD_MS = 3000
/** How long a same-frame update may take to reach the other surface. Far below
 *  HOLD_MS, so passing proves the update did not wait for the server. */
const INSTANT_MS = 700

async function openHomepageSession(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const row = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'More actions' }).click()
  // First kebab item = the session row (its label is live state, so positional).
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return { panel, row }
}

test('a task edit in the session header reaches the board row before the server has answered, and back', async ({ page, request }) => {
  const original = 'Store sync fixture task'
  const reset = await request.patch(`/api/tasks/${TASK_ID}`, { data: { title: original, phase: 'IN_PROGRESS' } })
  expect(reset.ok()).toBe(true)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const { panel, row } = await openHomepageSession(page)

  const headerTitle = panel.locator('.session-panel-title')
  const rowTitle = row.locator('.todo-item-title')
  await expect(headerTitle).toHaveText(original)
  await expect(rowTitle).toHaveText(original)

  // Hold every PATCH for this task at the network layer. The server does not
  // even see the request until the hold ends, so no WS echo can arrive before it.
  let patchesAnswered = 0
  await page.route(`**/api/tasks/${TASK_ID}`, async (route) => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return }
    await new Promise((r) => setTimeout(r, HOLD_MS))
    patchesAnswered++
    await route.continue()
  })

  // 1. Rename in the session header → board row, same frame.
  const renamed = 'Renamed from the session header'
  await headerTitle.click()
  const input = panel.locator('.session-panel-title-input')
  await input.fill(renamed)
  await input.press('Enter')
  await expect(rowTitle).toHaveText(renamed, { timeout: INSTANT_MS })
  await expect(headerTitle).toHaveText(renamed, { timeout: INSTANT_MS })
  expect(patchesAnswered).toBe(0)

  // 2. Complete from the session header's phase badge → board row flips, same frame.
  const headerPhase = panel.locator('.session-panel-title-area .task-quick-phase-btn')
  const rowPhase = row.locator('.task-phase-icon-btn')
  await expect(headerPhase).toHaveAttribute('title', 'Click to complete')
  await headerPhase.click()
  await expect(rowPhase).toHaveAttribute('title', 'Done — click to reopen', { timeout: INSTANT_MS })
  expect(patchesAnswered).toBe(0)

  // 3. Reopen from the BOARD row → session header flips, same frame.
  await rowPhase.click()
  await expect(headerPhase).toHaveAttribute('title', 'Click to complete', { timeout: INSTANT_MS })
  expect(patchesAnswered).toBe(0)

  // 4. Let the held requests land. The echoes must not undo what the user did:
  //    the title stays renamed and the task stays reopened on both surfaces.
  await expect.poll(() => patchesAnswered, { timeout: HOLD_MS * 3 }).toBe(3)
  await page.waitForTimeout(1000)
  await expect(rowTitle).toHaveText(renamed)
  await expect(headerTitle).toHaveText(renamed)
  await expect(rowPhase).toHaveAttribute('title', 'Click to complete')
  await expect(headerPhase).toHaveAttribute('title', 'Click to complete')

  const server = await request.get(`/api/tasks/${TASK_ID}`)
  const body = await server.json() as { task: { title: string; phase: string } }
  expect(body.task.title).toBe(renamed)
  expect(body.task.phase).not.toBe('COMPLETE')
})
