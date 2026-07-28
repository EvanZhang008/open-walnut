/**
 * Every TodoPanel drag handle must fully RELEASE its gesture.
 *
 * Companion to panel-resize-drag.spec.ts (which covers the Files panel divider
 * and the session↔chat splitter, i.e. the handles that sit next to an iframe).
 * This spec covers the other side of the same fix: the three shared hooks the
 * home panel drives, which were migrated from raw `document` mouse listeners to
 * pointer capture (`useDragGesture`).
 *
 *   .todo-tier-resize-handle → useResizableHeight  (pixel height + scroll freeze)
 *   .todo-pinned-splitter    → useVerticalSplitter (flex ratio)
 *   .todo-resize-handle      → useResizablePanel   (% of viewport width)
 *
 * The old shape leaked `body.cursor` / `user-select` and left the gesture armed
 * whenever a `mouseup` was missed, so a later mouse move kept resizing with no
 * button held. The assertion here is deliberately about RELEASE state rather
 * than exact pixel deltas: each hook has its own clamps and layout constraints,
 * but every one of them must end a drag with a clean body.
 */
import { test, expect } from '@playwright/test'

const HANDLES = [
  { sel: '.todo-tier-resize-handle', dx: 0, dy: 90, cursor: 'row-resize', label: 'tier (useResizableHeight)' },
  { sel: '.todo-pinned-splitter', dx: 0, dy: -70, cursor: 'row-resize', label: 'pinned splitter (useVerticalSplitter)' },
  { sel: '.todo-resize-handle', dx: 80, dy: 0, cursor: 'col-resize', label: 'todo width (useResizablePanel)' },
] as const

test('every TodoPanel drag handle arms on press and fully releases on mouseup', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // The tier handle + pinned splitter only render on the stacked "All" tab WITH
  // pinned tasks present — seed pins through the focus-bar registry first.
  const list = await (await page.request.get('/api/tasks')).json()
  const tasks = (Array.isArray(list) ? list : list.tasks ?? []) as Array<{ id: string }>
  for (const t of tasks.slice(0, 3)) {
    await page.request.post('/api/focus/tasks', { data: { taskId: t.id, tier: 'focus' } }).catch(() => {})
  }

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1200)

  const allTab = page.locator('.todo-section-tab-all')
  await expect(allTab).toBeVisible()
  await allTab.click()
  await page.waitForTimeout(800)

  const bodyState = () => page.evaluate(() => ({
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
    dragClass: document.body.classList.contains('walnut-dragging'),
  }))

  let exercised = 0
  for (const { sel, dx, dy, cursor, label } of HANDLES) {
    const handle = page.locator(sel).first()
    // These handles are deliberately ZERO-WIDTH/HEIGHT (an invisible ±3px hot
    // zone drawn by ::before), so `isVisible()` is false by design — presence is
    // established by having a layout box.
    const box = (await handle.count()) ? await handle.boundingBox().catch(() => null) : null
    if (!box) continue
    exercised++

    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(cx + (dx * i) / 10, cy + (dy * i) / 10)
    await page.waitForTimeout(120)

    // Armed: the hook owns the cursor while the pointer is down.
    expect(await bodyState(), `${label} mid-drag`).toEqual({
      cursor, userSelect: 'none', dragClass: true,
    })

    await page.mouse.up()
    await page.waitForTimeout(150)

    // THE regression: released must mean released.
    expect(await bodyState(), `${label} after release`).toEqual({
      cursor: '', userSelect: '', dragClass: false,
    })

    // And no further resizing with the button up.
    const settled = await handle.evaluate((el) => {
      const s = el.previousElementSibling as HTMLElement | null
      return s ? Math.round(s.getBoundingClientRect().height) : null
    })
    await page.mouse.move(cx + 200, cy + 160, { steps: 8 })
    await page.mouse.move(cx - 180, cy - 120, { steps: 8 })
    const afterWander = await handle.evaluate((el) => {
      const s = el.previousElementSibling as HTMLElement | null
      return s ? Math.round(s.getBoundingClientRect().height) : null
    })
    expect(afterWander, `${label} drifted after release`).toBe(settled)
  }

  // Guard against the whole spec silently no-op'ing if the panel state changes.
  expect(exercised, 'no TodoPanel drag handles were found to exercise').toBeGreaterThan(0)
  expect(errors).toEqual([])
})
