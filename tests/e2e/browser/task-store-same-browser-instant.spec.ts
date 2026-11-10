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
  // Click the row's title: the task menu has no open-session row.
  await row.locator('.todo-item-title').click()
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
  // Each step checks its OWN write is still held when the other surface has
  // flipped: the hold starts when that step sends it, so time a slow runner spends
  // before a step's click lands (Playwright waiting for the row to be stable and
  // not covered) cannot use up the budget, as one count for all three steps did
  // on CI (two writes already answered when step 3 checked).
  let patchesAnswered = 0
  const patches: Array<{ answered: boolean }> = []
  await page.route(`**/api/tasks/${TASK_ID}`, async (route) => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return }
    const patch = { answered: false }
    patches.push(patch)
    await new Promise((r) => setTimeout(r, HOLD_MS))
    patch.answered = true
    patchesAnswered++
    await route.continue()
  })
  /** The step's write (the nth PATCH) has not been answered, or not even sent. */
  const heldOrUnsent = (n: number) => !(patches[n]?.answered ?? false)

  // 1. Rename in the session header → board row, same frame.
  const renamed = 'Renamed from the session header'
  await headerTitle.click()
  const input = panel.locator('.session-panel-title-input')
  await input.fill(renamed)
  await input.press('Enter')
  await expect(rowTitle).toHaveText(renamed, { timeout: INSTANT_MS })
  await expect(headerTitle).toHaveText(renamed, { timeout: INSTANT_MS })
  expect(heldOrUnsent(0)).toBe(true)

  // 2. Complete from the session header's phase badge → board row flips, same frame.
  const headerPhase = panel.locator('.session-panel-title-area .task-quick-phase-btn')
  const rowPhase = row.locator('.task-phase-icon-btn')
  await expect(headerPhase).toHaveAttribute('title', 'Click to complete')
  await headerPhase.click()
  await expect(rowPhase).toHaveAttribute('title', 'Done: click to reopen', { timeout: INSTANT_MS })
  expect(heldOrUnsent(1)).toBe(true)

  // 3. Reopen from the BOARD row → session header flips, same frame.
  await rowPhase.click()
  await expect(headerPhase).toHaveAttribute('title', 'Click to complete', { timeout: INSTANT_MS })
  expect(heldOrUnsent(2)).toBe(true)

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
