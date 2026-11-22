/**
 * A divider stays under the pointer while it is dragged (2026-11-22).
 *
 * useResizablePanel turned a drag's px into % of the WINDOW, but Home's session area draws its
 * `${pct}%` as a share of the content row beside the task panel: with the task panel open the
 * divider moved about row/window of the pointer's distance and slid out from under it. The task
 * panel (a share of the window less the rail) was ~4% short, and the session chat column (a share
 * of its split) was off by split/window. Each now measures a drag against what its 100% is
 * (`basis`); here each divider is dragged N px and must have moved N px, within 2 px.
 * Chromium; the math is engine-free (tests/web/use-resizable-panel-basis.test.ts).
 */
import { test, expect, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SHOT_DIR = process.env.PW_SCREENSHOT_DIR ?? 'test-results/home-divider-follows-pointer'

test.use({ viewport: { width: 1512, height: 920 } })

/** Load Home with Quick question open or closed (the session divider only shows beside it) and
 *  every width at its default. */
async function boot(page: Page, baseURL: string, chatOpen: boolean) {
  await page.addInitScript((open) => {
    try {
      localStorage.setItem('open-walnut-home-chat-visible', String(open))
      for (const k of ['open-walnut-todo-width', 'walnut-session-panel-width-v2', 'open-walnut-split-chat-w3']) {
        localStorage.removeItem(k); localStorage.removeItem(`${k}:dragged`)
      }
    } catch { /* storage off */ }
  }, chatOpen)
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await page.waitForLoadState('networkidle')
}

test.afterEach(async ({ page }) => {
  await page.mouse.up()
})

/** Open the fixture session as a Home column (real clicks). */
async function openSessionColumn(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}

/** The divider's x: the handle is a zero-width box (its ±3 px hot zone is a ::before). */
async function dividerX(handle: Locator): Promise<number> {
  const box = await handle.boundingBox()
  expect(box, 'the divider has a layout box').not.toBeNull()
  return box!.x + box!.width / 2
}

/** Drag the divider by dx px; returns how far it moved mid-drag and after release. */
async function dragBy(page: Page, handle: Locator, dx: number): Promise<{ mid: number; released: number }> {
  const x0 = await dividerX(handle)
  const box = (await handle.boundingBox())!
  const y = box.y + Math.min(200, box.height / 2)
  await page.mouse.move(x0, y)
  await page.mouse.down()
  await page.mouse.move(x0 + dx, y, { steps: 12 })
  // The gesture coalesces moves per frame: let the last one draw.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const mid = (await dividerX(handle)) - x0
  await page.mouse.up()
  const released = (await dividerX(handle)) - x0
  return { mid, released }
}

test('Home: with the task panel open, the session divider and the task panel divider follow the pointer', async ({ page, baseURL }) => {
  await boot(page, baseURL!, true)
  await openSessionColumn(page)
  await expect(page.locator('.main-page-todo')).not.toHaveClass(/collapsed/)
  await expect(page.locator('.main-page-chat')).not.toHaveClass(/collapsed/)

  const sessionHandle = page.locator('.session-resize-handle')
  // Narrower (right), then wider (left): both directions, from a non-default start the second time.
  // The fixture's Quick question is empty, so the area starts at its graduated 65%, a few % under the
  // 70% the drag stops at: narrower first leaves the wider drag its room.
  for (const dx of [80, -120]) {
    const moved = await dragBy(page, sessionHandle, dx)
    expect(Math.abs(moved.mid - dx), `session divider mid-drag moved ${moved.mid} for ${dx}`).toBeLessThanOrEqual(2)
    expect(Math.abs(moved.released - dx), `session divider released moved ${moved.released} for ${dx}`).toBeLessThanOrEqual(2)
  }
  await page.screenshot({ path: `${SHOT_DIR}/session-divider-after-drag.png` })

  const todoHandle = page.locator('.todo-resize-handle')
  for (const dx of [90, -50]) {
    const moved = await dragBy(page, todoHandle, dx)
    expect(Math.abs(moved.mid - dx), `task panel divider mid-drag moved ${moved.mid} for ${dx}`).toBeLessThanOrEqual(2)
    expect(Math.abs(moved.released - dx), `task panel divider released moved ${moved.released} for ${dx}`).toBeLessThanOrEqual(2)
  }
  await page.screenshot({ path: `${SHOT_DIR}/todo-divider-after-drag.png` })
})

test("a session's chat splitter follows the pointer in a Home column", async ({ page, baseURL }) => {
  // Quick question closed: the column takes the row, so the chat's 30% clears its 280 px floor.
  await boot(page, baseURL!, false)
  const panel = await openSessionColumn(page)
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  const handle = panel.locator('.session-panel-chat-resize')
  await expect(handle).toBeVisible()

  for (const dx of [-100, 60]) {
    const moved = await dragBy(page, handle, dx)
    expect(Math.abs(moved.mid - dx), `chat splitter mid-drag moved ${moved.mid} for ${dx}`).toBeLessThanOrEqual(2)
    expect(Math.abs(moved.released - dx), `chat splitter released moved ${moved.released} for ${dx}`).toBeLessThanOrEqual(2)
  }
  await page.screenshot({ path: `${SHOT_DIR}/chat-splitter-after-drag.png` })
})

// 2026-11-22 audit: with nothing open beside it, Home's empty pane kept two thirds of the row while
// long titles wrapped in the task panel. The panel now takes the room up to a readable line, with a
// width of its own for that layout: a drag there follows the pointer and leaves the width it has
// beside a session alone.
test('Home with nothing open: the task panel takes the room, its divider follows the pointer, the width beside a session is kept', async ({ page, baseURL }) => {
  await boot(page, baseURL!, false)
  await expect(page.getByTestId('home-empty-pane')).toBeVisible()
  const todo = page.locator('.main-page-todo')
  // The width beside a session as this browser has it (synced view prefs can carry an earlier
  // test's drag back after boot clears it): the alone drags below must leave it as it is.
  const shared = () => page.evaluate(() => localStorage.getItem('open-walnut-todo-width'))
  const sharedBefore = await shared()
  // 1512 less the 56 px rail, less the empty pane's 400 px, capped at the readable 880 px.
  await expect.poll(async () => Math.round((await todo.boundingBox())!.width)).toBe(880)
  const handle = page.locator('.todo-resize-handle')
  for (const dx of [-120, 60]) {
    const moved = await dragBy(page, handle, dx)
    expect(Math.abs(moved.mid - dx), `task panel divider mid-drag moved ${moved.mid} for ${dx}`).toBeLessThanOrEqual(2)
    expect(Math.abs(moved.released - dx), `task panel divider released moved ${moved.released} for ${dx}`).toBeLessThanOrEqual(2)
  }
  await page.screenshot({ path: `${SHOT_DIR}/todo-alone-after-drag.png` })
  expect(await shared(), 'an alone drag leaves the width beside a session').toBe(sharedBefore)
  // A session opened: the task panel is back at its own width beside a session (25% by default).
  await openSessionColumn(page)
  const pct = sharedBefore === null ? 25 : Number(sharedBefore)
  await expect.poll(async () => Math.round((await todo.boundingBox())!.width)).toBe(Math.round((1512 - 56) * pct / 100))
})

// 2026-11-22 audit: an empty Quick question took half the row beside a session with a long history.
test('Home: an empty Quick question keeps the smaller share beside a session', async ({ page, baseURL }) => {
  await boot(page, baseURL!, true)
  await openSessionColumn(page)
  const slot = page.locator('.main-page-chat')
  const area = page.locator('.main-page-sessions-area')
  // The fixture has no quick question yet: the slot shows a new question's composer.
  await expect(slot.locator('[data-testid="ask-walnut-draft"], [data-testid="ask-walnut-main-draft"]').first()).toBeVisible()
  const row = page.locator('.main-page-content-row')
  await expect.poll(async () => {
    const [a, r] = [(await area.boundingBox())!.width, (await row.boundingBox())!.width]
    return Math.round((a / r) * 100)
  }).toBeGreaterThanOrEqual(63)
  await page.screenshot({ path: `${SHOT_DIR}/empty-quick-question.png` })
})
