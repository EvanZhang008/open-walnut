/**
 * Playwright regression tests for drag-to-resize handles (Files panel divider,
 * session↔chat splitter).
 *
 * THE BUG (two independent root causes, both in the shared drag pattern):
 *
 *  1. STUCK DRAG. Handles attached raw `mousemove`/`mouseup` to `document`.
 *     Mouse events go to the document of whatever element is under the cursor,
 *     so as soon as the cursor crossed the Files panel's HTML-preview
 *     `<iframe class="fv-html-preview">` — which sits DIRECTLY right of the
 *     tree divider — the page stopped receiving `mousemove` (drag looked
 *     frozen/laggy) and NEVER received `mouseup`. The gesture stayed armed:
 *     `body.cursor`/`user-select` remained set and moving the mouse afterwards
 *     kept resizing, with no button held.
 *
 *  2. LAG. Five call sites persisted to localStorage from a `useEffect` keyed
 *     on the per-frame drag state — a synchronous disk write on every single
 *     mousemove.
 *
 * The fix is `useDragGesture` (pointer capture + rAF coalescing + persist on
 * release only). These tests drag ACROSS the iframe on purpose — that crossing
 * is the whole regression, so a test that avoids it would pass against the old
 * broken code.
 */
import { test, expect, type Page, type Locator } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = 'test-results/panel-resize-drag'

/** Open the fixture session's panel from the homepage (real UI clicks, no page.goto). */
async function openSessionPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  // The kebab's session entry is the session-status row, whose LABEL depends on
  // the task's live phase ("Session idle" / "Needs your attention" / "AI is
  // working..." / "Session error"). Match any of them: a phase drift must not
  // turn this drag regression test into a false failure about menu wording.
  await page.locator('.task-kebab-menu:visible')
    .locator('.task-kebab-item')
    .filter({ hasText: /Session idle|Needs your attention|AI is working|Session error/ })
    .first()
    .click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}

/** Files tab + the HTML fixture selected, so the preview really is an iframe. */
async function openFilesPanelWithIframePreview(page: Page) {
  const panel = await openSessionPanel(page)
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })

  await explorer.locator('.sfe-name', { hasText: 'drag-fixture.html' }).click()
  // THE hazard: an iframe covering the area the drag crosses.
  const frame = explorer.locator('iframe.fv-html-preview')
  await expect(frame).toBeVisible({ timeout: 10_000 })
  return { panel, explorer, frame }
}

async function treeWidth(explorer: Locator): Promise<number> {
  return explorer.locator('.session-file-explorer-tree').evaluate(
    (el) => el.getBoundingClientRect().width)
}

/** Body styles the old code leaked when mouseup was swallowed by the iframe. */
async function bodyDragState(page: Page) {
  return page.evaluate(() => ({
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
    dragClass: document.body.classList.contains('walnut-dragging'),
  }))
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('Files divider: drag ACROSS the preview iframe resizes, and release really releases', async ({ page }) => {
  const { explorer, frame } = await openFilesPanelWithIframePreview(page)

  const startWidth = await treeWidth(explorer)
  const divider = explorer.locator('.sfe-divider')
  const dBox = (await divider.boundingBox())!
  const fBox = (await frame.boundingBox())!
  const startX = dBox.x + dBox.width / 2
  const y = dBox.y + dBox.height / 2

  // Target a point WELL INSIDE the iframe — this is the crossing that used to
  // kill the drag. Clamp so we stay within the tree's 600px max.
  const targetX = Math.min(fBox.x + fBox.width / 2, startX + 120)

  await page.mouse.move(startX, y)
  await page.mouse.down()
  // Several steps so intermediate moves land over the iframe, not just the end.
  await page.mouse.move(targetX, y, { steps: 12 })

  // Mid-drag the resize must have tracked the pointer even though the cursor is
  // over the iframe (the old code froze here).
  const draggedWidth = await treeWidth(explorer)
  expect(draggedWidth).toBeGreaterThan(startWidth + 40)
  expect(await bodyDragState(page)).toMatchObject({ cursor: 'col-resize', dragClass: true })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/step1-mid-drag-over-iframe.png` })

  await page.mouse.up()

  // ── THE regression assertion ──
  // Release must actually release. Previously mouseup was delivered to the
  // iframe's document, so the gesture stayed armed.
  expect(await bodyDragState(page)).toEqual({ cursor: '', userSelect: '', dragClass: false })

  const releasedWidth = await treeWidth(explorer)
  // Moving the mouse far away with NO button held must not resize anything.
  await page.mouse.move(targetX + 200, y, { steps: 10 })
  await page.mouse.move(targetX - 250, y + 60, { steps: 10 })
  expect(await treeWidth(explorer)).toBeCloseTo(releasedWidth, 0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/step2-after-release-no-drift.png` })
})

test('Files divider: width persists once on release, not once per frame', async ({ page }) => {
  const { explorer, frame } = await openFilesPanelWithIframePreview(page)

  // Count localStorage.setItem calls for the width key during the drag. The old
  // code wrote synchronously on EVERY mousemove — a blocking disk write per
  // frame, which is what made the drag feel laggy.
  //
  // Wrap the OWN property, not Storage.prototype: ui-prefs-sync.ts installs its
  // own `localStorage.setItem` at boot and captured the prototype method by
  // then, so a prototype patch here would never see app writes at all (it would
  // silently count zero and the test would pass for the wrong reason).
  await page.evaluate(() => {
    const w = window as unknown as { __setItemCalls: number }
    w.__setItemCalls = 0
    const orig = localStorage.setItem.bind(localStorage)
    localStorage.setItem = (k: string, v: string) => {
      if (k === 'open-walnut-file-explorer-tree-width2') w.__setItemCalls++
      orig(k, v)
    }
  })

  const divider = explorer.locator('.sfe-divider')
  const dBox = (await divider.boundingBox())!
  const fBox = (await frame.boundingBox())!
  const startX = dBox.x + dBox.width / 2
  const y = dBox.y + dBox.height / 2

  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(Math.min(fBox.x + fBox.width / 2, startX + 100), y, { steps: 25 })
  const duringDrag = await page.evaluate(() => (window as unknown as { __setItemCalls: number }).__setItemCalls)
  await page.mouse.up()
  const afterRelease = await page.evaluate(() => (window as unknown as { __setItemCalls: number }).__setItemCalls)

  // Zero writes across 25 move steps; exactly one on release.
  expect(duringDrag).toBe(0)
  expect(afterRelease).toBe(1)
})

test('Files divider: Escape mid-drag releases the gesture', async ({ page }) => {
  const { explorer, frame } = await openFilesPanelWithIframePreview(page)

  const divider = explorer.locator('.sfe-divider')
  const dBox = (await divider.boundingBox())!
  const fBox = (await frame.boundingBox())!
  const y = dBox.y + dBox.height / 2
  const startX = dBox.x + dBox.width / 2

  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(Math.min(fBox.x + fBox.width / 2, startX + 80), y, { steps: 8 })
  expect(await bodyDragState(page)).toMatchObject({ dragClass: true })

  await page.keyboard.press('Escape')

  // Escape is a real release path — no leaked body styles / armed gesture.
  //
  // This must be asserted with the pointer still DOWN: that is the whole point
  // (release without a mouseup). It also has to be checked on `document.body`
  // rather than by dragging further, because Escape ALSO unfocuses the task
  // (MainPage's Escape handler), which closes this session column — pre-existing
  // app behavior, unrelated to the gesture.
  expect(await bodyDragState(page)).toEqual({ cursor: '', userSelect: '', dragClass: false })

  await page.mouse.up()
  // A mouseup arriving after an already-released gesture must be a no-op, not a
  // second release that re-leaks state.
  expect(await bodyDragState(page)).toEqual({ cursor: '', userSelect: '', dragClass: false })
})

test('session↔chat splitter: drag over the Files iframe resizes and releases', async ({ page }) => {
  const { panel, frame } = await openFilesPanelWithIframePreview(page)

  const handle = panel.locator('.session-panel-chat-resize')
  await expect(handle).toBeVisible()
  const chatCol = panel.locator('.session-panel-chat-col')
  const startWidth = await chatCol.evaluate((el) => el.getBoundingClientRect().width)

  const hBox = (await handle.boundingBox())!
  const fBox = (await frame.boundingBox())!
  const startX = hBox.x + hBox.width / 2
  const y = hBox.y + hBox.height / 2

  // Drag LEFT into the iframe — for this handle that widens the chat column.
  const targetX = Math.max(fBox.x + 20, startX - 120)
  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(targetX, y, { steps: 12 })

  const dragged = await chatCol.evaluate((el) => el.getBoundingClientRect().width)
  expect(dragged).toBeGreaterThan(startWidth + 40)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/step3-chat-splitter-mid-drag.png` })

  await page.mouse.up()
  expect(await bodyDragState(page)).toEqual({ cursor: '', userSelect: '', dragClass: false })

  const released = await chatCol.evaluate((el) => el.getBoundingClientRect().width)
  await page.mouse.move(targetX + 220, y + 40, { steps: 10 })
  expect(await chatCol.evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(released, 0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/step4-chat-splitter-released.png` })
})
