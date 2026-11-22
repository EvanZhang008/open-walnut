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
  // Wider (left), then narrower (right): both directions, from a non-default start the second time.
  for (const dx of [-120, 80]) {
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
