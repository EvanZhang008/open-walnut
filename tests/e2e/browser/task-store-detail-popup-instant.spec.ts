/**
 * One browser, one task store: the task details POPUP on Home.
 *
 * The popup (TaskDetailModal -> TaskDetailPane, with TaskDetailEdits) is the one place a task's
 * details are edited since the separate task page went away (utils/task-path.ts). That page kept
 * its own private task copy and wrote every field with a direct REST call, so the board row learned
 * about an edit only from the WebSocket echo; on a stalled server the page showed the new value
 * while the row kept the old one for seconds. The popup's edits must not bring that back: every
 * write the store carries goes through its optimistic mutators, and the board row behind the popup
 * moves in the same frame.
 *
 * The write is HELD at the network layer for HOLD_MS, so any propagation that still rode the
 * server round-trip (or its echo) fails the sub-second assertions.
 */
import { expect, test } from './shortcut-test-fixture'
import { type Locator, type Page } from '@playwright/test'

const TASK_ID = 'pw-task-store-sync'
const TITLE = 'Store sync fixture task'
/** Each write is held this long. Deliberately under the API client's own 15s
 *  request timeout: past that the client aborts and retries, and the retry — not
 *  the hold — would be what the assertions saw. */
const HOLD_MS = 10_000
/** How long a same-frame update may take to reach the other surface. Far below
 *  HOLD_MS, so passing proves the update did not wait for the server. */
const INSTANT_MS = 700

/** Real UI route to the popup: the board row's menu, then Details. */
async function openDetails(page: Page, row: Locator): Promise<Locator> {
  await row.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').getByText('Details', { exact: true }).click()
  const modal = page.locator('.task-detail-modal')
  await expect(modal).toBeVisible()
  await expect(modal.locator('.todo-detail-title')).toHaveText(TITLE)
  return modal
}

test('an edit in the task details popup reaches the board row before the server answers', async ({ page, request }) => {
  // Three writes are each held for HOLD_MS and the run has to outlive all of them.
  test.setTimeout(120_000)
  const reset = await request.patch(`/api/tasks/${TASK_ID}`, {
    data: { title: TITLE, phase: 'IN_PROGRESS', due_date: '' },
  })
  expect(reset.ok()).toBe(true)

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('#home-task-navigation .todo-search-input').click()
  await page.locator('.todo-search-input').fill(TITLE)
  const boardRow = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(boardRow).toBeVisible()

  const modal = await openDetails(page, boardRow)
  // The popup sits over Home: the row stays mounted behind it.
  await expect(boardRow).toHaveCount(1)

  // Hold every write for this task at the network layer: the server does not even
  // see the request until the hold ends, so no echo can arrive before it.
  // Counted per endpoint AND asserted as a DELTA around each action, so "not
  // answered yet" is a statement about the write just made, never about a
  // neighbour's hold that happened to expire.
  let patchesAnswered = 0
  let togglesAnswered = 0
  await page.route(`**/api/tasks/${TASK_ID}`, async (route) => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return }
    await new Promise((r) => setTimeout(r, HOLD_MS))
    patchesAnswered++
    await route.continue()
  })
  await page.route(`**/api/tasks/${TASK_ID}/toggle-complete`, async (route) => {
    await new Promise((r) => setTimeout(r, HOLD_MS))
    togglesAnswered++
    await route.continue()
  })

  // 1. Set the due date from the popup's rail → the board row's due pill appears
  //    in the same frame.
  const due = modal.locator('.tdp-rail .tdp-fact').filter({ has: page.locator('.tdp-fact-k', { hasText: /^Due\s*$/ }) })
  await due.locator('.dp-trigger').click()
  const dayPill = page.locator('.dp-content .dp-pills').nth(1).locator('.dp-pill').first()
  const picked = await dayPill.getAttribute('data-date')
  expect(picked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  const patchesBefore = patchesAnswered
  await dayPill.click()
  await expect(boardRow.locator('.todo-item-due-pill')).toHaveAttribute('title', `Due: ${picked}`, { timeout: INSTANT_MS })
  await expect(due.locator('.dp-trigger')).not.toHaveText('Set date', { timeout: INSTANT_MS })
  expect(patchesAnswered).toBe(patchesBefore)

  // 2. Complete from the popup's header → the row's phase flips, and so does the button.
  const rowPhase = boardRow.locator('.task-phase-icon-btn')
  const completeButton = modal.getByTestId('task-detail-complete')
  await expect(rowPhase).toHaveAttribute('title', 'Click to complete')
  await expect(completeButton).toHaveText('Complete')
  const completeBefore = togglesAnswered
  await completeButton.click()
  await expect(rowPhase).toHaveAttribute('title', 'Done: click to reopen', { timeout: INSTANT_MS })
  await expect(completeButton).toHaveText('Reopen', { timeout: INSTANT_MS })
  expect(togglesAnswered).toBe(completeBefore)

  // 3. Reopen (a completed row leaves the board after a 3s grace, and the
  //    fixture must not be left done for the next spec).
  const reopenBefore = togglesAnswered
  await completeButton.click()
  await expect(rowPhase).toHaveAttribute('title', 'Click to complete', { timeout: INSTANT_MS })
  await expect(completeButton).toHaveText('Complete', { timeout: INSTANT_MS })
  expect(togglesAnswered).toBe(reopenBefore)

  // 4. Close the popup while the reopen from step 3 is STILL held: the board the
  //    user is back on shows the reopened row from the store, not from a server
  //    confirmation that has not happened. (The earlier writes' holds may well
  //    have expired by now, so only the write just made is used as the guard.)
  //    Escape, not the close button: under load a toast can sit over the chrome.
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-detail-modal')).toHaveCount(0)
  await expect(boardRow).toBeVisible()
  await expect(rowPhase).toHaveAttribute('title', 'Click to complete')
  await expect(boardRow.locator('.todo-item-due-pill')).toHaveAttribute('title', `Due: ${picked}`)
  expect(togglesAnswered).toBe(reopenBefore)

  // 5. Let the held writes land. The echoes must not undo what the user did.
  await expect.poll(() => patchesAnswered + togglesAnswered, { timeout: HOLD_MS * 4 })
    .toBeGreaterThanOrEqual(3)
  await page.waitForTimeout(1000)
  await expect(boardRow.locator('.todo-item-due-pill')).toHaveAttribute('title', `Due: ${picked}`)
  await expect(rowPhase).toHaveAttribute('title', 'Click to complete')

  const server = await request.get(`/api/tasks/${TASK_ID}`)
  const body = await server.json() as { task: { due_date?: string; phase: string } }
  expect(body.task.due_date).toBe(picked)
  expect(body.task.phase).not.toBe('COMPLETE')
})
