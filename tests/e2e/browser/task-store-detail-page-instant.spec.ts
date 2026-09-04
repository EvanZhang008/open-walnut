/**
 * One browser, one task store — the `/tasks/:id` detail PAGE.
 *
 * That page kept its own private task copy and wrote every field with a direct
 * REST call, so the home board (which stays MOUNTED behind it: App.tsx renders
 * StableMainPage outside <Routes> and only CSS-hides it) learned about the edit
 * from the WebSocket echo. On a stalled server the page showed the new value
 * while the board row kept the old one for seconds, and coming back home showed
 * the stale row.
 *
 * Every write the store carries now goes through the store's optimistic
 * mutators; the private detail copy is only the donor for what a detail read
 * alone carries (note, description, dependencies, children).
 *
 * The write is HELD at the network layer for HOLD_MS, so any propagation that
 * still rode the server round-trip (or its echo) fails the sub-second assertions.
 */
import { expect, test, type Page } from '@playwright/test'

const TASK_ID = 'pw-task-store-sync'
const TITLE = 'Store sync fixture task'
/** Each write is held this long. Deliberately under the API client's own 15s
 *  request timeout: past that the client aborts and retries, and the retry — not
 *  the hold — would be what the assertions saw. */
const HOLD_MS = 10_000
/** How long a same-frame update may take to reach the other surface. Far below
 *  HOLD_MS, so passing proves the update did not wait for the server. */
const INSTANT_MS = 700

/** Real UI route to the detail page: sidebar → Tasks table → the row's title. */
async function openDetailPage(page: Page): Promise<void> {
  if ((await page.locator('.sidebar.collapsed').count()) > 0) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
  await page.locator('.sidebar a[href="/tasks"]').click()
  await expect(page.getByTestId('tasks-table')).toBeVisible()
  // The table windows its rows, so narrow it to this one before clicking.
  await page.locator('.tp-search').fill(TITLE)
  await page.locator(`.tp-row[data-task-id="${TASK_ID}"] .tp-row-title`).click()
  await expect(page).toHaveURL(new RegExp(`/tasks/${TASK_ID}$`))
  await expect(page.locator('.tdv2-title')).toHaveText(TITLE)
}

test('a write on /tasks/:id reaches the mounted home board row before the server answers', async ({ page, request }) => {
  // Three writes are each held for HOLD_MS and the run has to outlive all of them.
  test.setTimeout(120_000)
  const reset = await request.patch(`/api/tasks/${TASK_ID}`, {
    data: { title: TITLE, phase: 'IN_PROGRESS', due_date: '' },
  })
  expect(reset.ok()).toBe(true)

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Bring the row onto the board FIRST, so what is asserted later is a mounted
  // (merely hidden) surface rather than one that remounted on the way back.
  await page.locator('.todo-search-input').fill(TITLE)
  const boardRow = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(boardRow).toBeVisible()

  await openDetailPage(page)
  // Home is hidden, not unmounted — the row is still in the DOM.
  await expect(page.locator('.main-page-wrapper-hidden')).toHaveCount(1)
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

  // 1. Set the due date from the detail page's right rail → the hidden board
  //    row's due pill appears in the same frame.
  const dueTrigger = page.locator('.tdv2-side button.dp-trigger[title="Set due"]')
  await dueTrigger.click()
  const dayPill = page.locator('.dp-popover .dp-pills').nth(1).locator('.dp-pill').first()
  const picked = await dayPill.getAttribute('title')
  expect(picked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  const patchesBefore = patchesAnswered
  await dayPill.click()
  await expect(boardRow.locator('.todo-item-due-pill')).toHaveAttribute('title', `Due: ${picked}`, { timeout: INSTANT_MS })
  expect(patchesAnswered).toBe(patchesBefore)

  // 2. Complete from the detail page header → the hidden row's phase flips.
  const rowPhase = boardRow.locator('.task-phase-icon-btn')
  await expect(rowPhase).toHaveAttribute('title', 'Click to complete')
  const completeBefore = togglesAnswered
  await page.locator('.tdv2-head .btn-primary').click()
  await expect(rowPhase).toHaveAttribute('title', 'Done — click to reopen', { timeout: INSTANT_MS })
  expect(togglesAnswered).toBe(completeBefore)

  // 3. Reopen (a completed row leaves the board after a 3s grace, and the
  //    fixture must not be left done for the next spec).
  const reopenBefore = togglesAnswered
  await page.locator('.tdv2-head .btn-primary').click()
  await expect(rowPhase).toHaveAttribute('title', 'Click to complete', { timeout: INSTANT_MS })
  expect(togglesAnswered).toBe(reopenBefore)

  // 4. Straight back home through the real UI, while the reopen from step 3 is
  //    STILL held: the board the user lands on shows the reopened row from the
  //    store, not from a server confirmation that has not happened. (The earlier
  //    writes' holds may well have expired by now — walk time is not a proof, so
  //    only the write just made is used as the guard.) Back lands on the Tasks
  //    table this spec came from, so Home is one more real click.
  await page.locator('.tdv2-back').click()
  await expect(page.getByTestId('tasks-table')).toBeVisible()
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(page).toHaveURL(/localhost:\d+\/$/)
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
