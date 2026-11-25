/**
 * Every dialog can be resized by its edges (web/src/components/common/DialogResizeEdges.tsx; the
 * user, 2026-11-25: "I think every pop-up window can be resized"). Proven on the keyboard shortcuts
 * dialog, a plain `wn-dialog` that knows nothing of the edges: a drag on its right edge widens it on
 * both sides (it stays centred), the bottom-right corner sets both sizes, the size is kept for the
 * next time it opens, a double click forgets it, and a press on an edge never closes the dialog.
 *
 * loadHome is the initial load (the repo's sanctioned exception); every other step is a key or a drag.
 */
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { loadHome } from './draft-helpers'

test.use({ viewport: { width: 1280, height: 820 } })
test.setTimeout(90_000)

async function openShortcuts(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Shift+Slash')
  const dialog = page.locator('.shortcuts-help.wn-dialog')
  await expect(dialog).toBeVisible()
  // Settled: two frames with no movement (it fades and scales in).
  await expect.poll(() => dialog.evaluate((n) => new Promise<string>((done) => {
    const a = JSON.stringify(n.getBoundingClientRect())
    requestAnimationFrame(() => requestAnimationFrame(() => done(a === JSON.stringify(n.getBoundingClientRect()) ? 'still' : 'moving')))
  }))).toBe('still')
  return dialog
}

async function dragEdge(page: Page, side: string, dx: number, dy: number) {
  const edge = page.getByTestId(`dialog-resize-${side}`)
  await expect(edge).toBeVisible()
  const b = (await edge.boundingBox())!
  const x = b.x + b.width / 2, y = b.y + b.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 })
  await page.mouse.move(x + dx, y + dy, { steps: 4 })
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await page.addInitScript(() => { try { localStorage.removeItem('walnut:dialog-size') } catch { /* none */ } })
})

test('a dialog grows by its edges, keeps the size it was left at, and forgets it on a double click', async ({ page }) => {
  await loadHome(page)
  const dialog = await openShortcuts(page)
  const before = (await dialog.boundingBox())!
  const centre = before.x + before.width / 2

  // The right edge: 60 px out widens it by 120 (both sides), and it stays centred.
  await dragEdge(page, 'e', 60, 0)
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.width)).toBe(Math.round(before.width + 120))
  const wide = (await dialog.boundingBox())!
  expect(Math.abs(wide.x + wide.width / 2 - centre), 'still centred').toBeLessThan(2)
  // The press on the edge never closed it, and the strip moved with the edge it dragged.
  await expect(dialog).toBeVisible()
  await expect.poll(async () => Math.round((await page.getByTestId('dialog-resize-e').boundingBox())!.x - (wide.x + wide.width))).toBe(-3)

  // The corner sets both sizes.
  await dragEdge(page, 'se', -40, -30)
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.width)).toBe(Math.round(wide.width - 80))
  const sized = (await dialog.boundingBox())!

  // Closed and opened again: the size it was left at.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  const again = await openShortcuts(page)
  await expect.poll(async () => Math.round((await again.boundingBox())!.width)).toBe(Math.round(sized.width))
  expect(Math.round((await again.boundingBox())!.height)).toBe(Math.round(sized.height))

  // A double click on an edge: its own size again.
  await page.getByTestId('dialog-resize-e').dblclick()
  await expect.poll(async () => Math.round((await again.boundingBox())!.width)).toBe(Math.round(before.width))
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('dialog-resize-e')).toHaveCount(0)
})

test('a bottom edge keeps the width a side edge set, a click changes nothing, and Escape puts a drag back', async ({ page }) => {
  await loadHome(page)
  const dialog = await openShortcuts(page)
  await dragEdge(page, 'e', 50, 0)
  const wide = (await dialog.boundingBox())!
  await dragEdge(page, 's', 0, -40)
  const both = (await dialog.boundingBox())!
  expect(Math.round(both.width)).toBe(Math.round(wide.width))

  // Reopened: both the width and the height it was left at.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  const again = await openShortcuts(page)
  await expect.poll(async () => Math.round((await again.boundingBox())!.width)).toBe(Math.round(both.width))
  expect(Math.round((await again.boundingBox())!.height)).toBe(Math.round(both.height))

  // A click on an edge, no move: nothing changes.
  await page.getByTestId('dialog-resize-e').click()
  expect(Math.round((await again.boundingBox())!.width)).toBe(Math.round(both.width))

  // Escape in the middle of a drag: the size from before it, and the dialog stays open.
  const e = (await page.getByTestId('dialog-resize-e').boundingBox())!
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2)
  await page.mouse.down()
  await page.mouse.move(e.x + 80, e.y + e.height / 2, { steps: 5 })
  await expect.poll(async () => Math.round((await again.boundingBox())!.width)).toBeGreaterThan(Math.round(both.width) + 100)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(again).toBeVisible()
  await expect.poll(async () => Math.round((await again.boundingBox())!.width)).toBe(Math.round(both.width))
})

test('a drag never takes a dialog past the window, and no dialog means no edges', async ({ page }) => {
  await loadHome(page)
  await expect(page.getByTestId('dialog-resize-e')).toHaveCount(0)
  const dialog = await openShortcuts(page)
  await dragEdge(page, 'e', 2000, 0)
  const b = (await dialog.boundingBox())!
  expect(b.x).toBeGreaterThanOrEqual(0)
  expect(b.x + b.width).toBeLessThanOrEqual(1280 + 0.5)
  expect(Math.round(b.width)).toBe(1280 - 16)
})
