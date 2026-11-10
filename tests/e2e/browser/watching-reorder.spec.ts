/**
 * Watching's rows drag to the user's own order (2026-11-09, the user: "I want this watch to be able
 * to reorder by drag"). The order is each task's `watched_at` (status-sections.ts watchReorder), so
 * a drop is one write the server keeps: it survives a reload and reaches every device. A new watch
 * lands at the bottom; a plain click still opens the row; the row menu never drags it.
 */
import { test, expect } from './shortcut-test-fixture'
import type { Locator, Page } from '@playwright/test'
import { isolateUiPrefs, selectSection } from './todo-panel-helpers'
import { presetPanelDesign, statusSectionRows, type PanelDesign } from './status-section-helpers'

const made: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
})

async function seed(page: Page, title: string, watchedAt: string): Promise<string> {
  const res = await page.request.post('/api/tasks', { data: { title, source: 'local', project: 'Orchard' } })
  expect(res.ok(), await res.text()).toBe(true)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  made.push(id)
  expect((await page.request.patch(`/api/tasks/${id}`, { data: { watched_at: watchedAt } })).ok()).toBe(true)
  return id
}

/** The ids Watching shows, top down, of the ones this spec made. */
const order = (rows: Locator, ids: string[]) => rows.locator('[data-task-id]').evaluateAll(
  (els, mine) => els.map((e) => e.getAttribute('data-task-id')!).filter((id) => mine.includes(id)), ids)
/** The order the server keeps: its watched_at, oldest first. */
async function serverOrder(page: Page, ids: string[]): Promise<string[]> {
  const rows = await Promise.all(ids.map(async (id) => {
    const t = ((await (await page.request.get(`/api/tasks/${id}`)).json()) as { task: { watched_at: string } }).task
    return { id, at: Date.parse(t.watched_at) }
  }))
  return rows.sort((a, b) => a.at - b.at).map((r) => r.id)
}
/** A real pointer drag: press on the row's title, move in steps past the target's middle, release. */
async function drag(page: Page, from: Locator, to: Locator, where: 'above' | 'below') {
  const a = (await from.locator('.todo-pinned-title').boundingBox())!
  const b = (await to.boundingBox())!
  await page.mouse.move(a.x + 20, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + 20, a.y + a.height / 2 + (where === 'above' ? -8 : 8), { steps: 4 })
  const y = where === 'above' ? b.y + b.height * 0.25 : b.y + b.height * 0.75
  await page.mouse.move(a.x + 20, y, { steps: 12 })
  await page.mouse.up()
}

for (const design of ['status', 'project'] as PanelDesign[]) {
  test(`${design === 'status' ? 'Flat' : 'By project'}: Watching rows drag to a new order that the server keeps across a reload`, async ({ page }) => {
    test.setTimeout(120_000)
    await isolateUiPrefs(page)
    await presetPanelDesign(page, design)
    const stamp = Date.now()
    const base = Date.now() - 3600_000
    const ids = [
      await seed(page, `watch one ${stamp}`, new Date(base).toISOString()),
      await seed(page, `watch two ${stamp}`, new Date(base + 60_000).toISOString()),
      await seed(page, `watch three ${stamp}`, new Date(base + 120_000).toISOString()),
    ]
    await page.goto('/')
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    const rows = statusSectionRows(panel, 'watching')
    const card = (id: string) => rows.locator(`[data-task-id="${id}"]`)
    await expect(card(ids[2])).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => order(rows, ids)).toEqual(ids)

    // The third dragged to the top.
    await drag(page, card(ids[2]), card(ids[0]), 'above')
    await expect.poll(() => order(rows, ids)).toEqual([ids[2], ids[0], ids[1]])
    await expect.poll(() => serverOrder(page, ids)).toEqual([ids[2], ids[0], ids[1]])
    // The drop opened nothing.
    await expect(panel.locator('.todo-pinned-card-active')).toHaveCount(0)

    // The (now) first dragged to the bottom.
    await drag(page, card(ids[2]), card(ids[1]), 'below')
    await expect.poll(() => order(rows, ids)).toEqual([ids[0], ids[1], ids[2]])
    await expect.poll(() => serverOrder(page, ids)).toEqual([ids[0], ids[1], ids[2]])

    // The middle one up by one, and a reload keeps it.
    await drag(page, card(ids[1]), card(ids[0]), 'above')
    await expect.poll(() => serverOrder(page, ids)).toEqual([ids[1], ids[0], ids[2]])
    await page.reload()
    await selectSection(page, 'All')
    await expect(card(ids[0])).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => order(rows, ids)).toEqual([ids[1], ids[0], ids[2]])

    // A new watch lands at the bottom.
    const fresh = await seed(page, `watch four ${stamp}`, new Date().toISOString())
    await expect(card(fresh)).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => order(rows, [...ids, fresh])).toEqual([ids[1], ids[0], ids[2], fresh])

    // A plain click still opens the row and moves nothing.
    await card(ids[0]).locator('.todo-pinned-title').click()
    await expect(card(ids[0])).toHaveClass(/todo-pinned-card-active/)
    expect(await serverOrder(page, ids)).toEqual([ids[1], ids[0], ids[2]])
  })
}
