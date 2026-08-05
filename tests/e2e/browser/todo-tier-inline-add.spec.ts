/**
 * Tier inline-add ("+ Add to Focus/Satellite/Wait…") — placement + it actually works.
 *
 * Two regressions, both reported together after the panel moved to horizontal
 * section tabs:
 *
 *  1. PLACEMENT. In a solo (single-tab) tier the drop zone was `flex: 1 1 auto`, so
 *     as a flex CHILD of the scroller it got squashed to the scroller's height while
 *     its cards still needed the full stack height. The overflow spilled out of the
 *     zone's box and the sibling "Add to …" row rendered ON TOP of the last cards
 *     instead of below them — the "weird placed" report.
 *
 *  2. IT SILENTLY DID NOTHING. Quick capture routes to the configured default
 *     category ('Inbox'), which is hard-reserved for local tasks by
 *     config.local.categories while store.categories still had it registered to a
 *     sync plugin from an old sync. Source resolution said the plugin, validation
 *     said local-only → permanent 409, the optimistic card rolled back, and the task
 *     "disappeared".
 *
 * The assertions are geometric + behavioral, not stylistic: the add row must sit
 * BELOW every card, and a typed title must end up as a real task in the tier.
 */

import { test, expect, type Page } from '@playwright/test'
import { selectSection, selectCategory } from './todo-panel-helpers'

// Pin membership is GLOBAL server state on one shared fixture dataset: the geometry
// test seeds 40 cards into Satellite while the per-tier tests add and then look for
// exactly one card in a tier. Run in parallel they race (a 40-card seed lands mid-
// assertion and buries / re-sorts the row under test). Serialize within this file.
test.describe.configure({ mode: 'serial' })

const TIERS = [
  { tab: 'Focus' as const, label: 'Add to Focus…', zone: 'focus-drop-zone' },
  { tab: 'Satellite' as const, label: 'Add to Satellite…', zone: 'satellite-drop-zone' },
  { tab: 'Backlog' as const, label: 'Add to Backlog…', zone: 'backlog-drop-zone' },
  { tab: 'Wait' as const, label: 'Add to Wait…', zone: 'wait-drop-zone' },
]

/** Seed enough pinned cards in `tier` to overflow the panel — the overlap only
 *  appeared once the card stack was taller than the scroller.
 *
 *  Creates are issued CONCURRENTLY: tasks.json writes serialize behind a write lock,
 *  so 3 sequential round-trips per card blew the 30s test budget on a loaded machine
 *  (the seed, not the product, was the slow part). */
async function seedTier(page: Page, tier: 'focus' | 'satellite' | 'backlog' | 'wait', n: number, stamp: number) {
  const ids = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const res = await page.request.post('/api/tasks', {
        data: { title: `inline-add probe ${tier} ${i} ${stamp}`, source: 'local', category: 'Work' },
      })
      if (!res.ok()) throw new Error(`seed create failed: ${res.status()} ${await res.text()}`)
      const id = ((await res.json()) as { task?: { id?: string } }).task?.id
      if (!id) throw new Error('seed create returned no task id')
      return id
    }),
  )
  await Promise.all(ids.map(async (id) => {
    const pin = await page.request.post(`/api/focus/tasks/${id}`)
    if (!pin.ok()) throw new Error(`seed pin failed: ${pin.status()}`)
  }))
  if (tier !== 'focus') {
    await Promise.all(ids.map(async (id) => {
      const move = await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier } })
      if (!move.ok()) throw new Error(`seed tier move failed: ${move.status()}`)
    }))
  }
}

test.describe('tier inline add', () => {
  test('the add row sits below every card in a full solo tier', async ({ page }) => {
    // Seeding 40 pinned cards + two reloads doesn't fit the 30s default on a loaded box.
    test.slow()
    const stamp = Date.now()
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 20_000 })
    // 40 cards comfortably overflows the panel at any test viewport.
    await seedTier(page, 'satellite', 40, stamp)
    await page.reload()
    await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })
    await selectCategory(page, 'All')

    await selectSection(page, 'Satellite')
    const zone = page.locator('[data-drop-zone="satellite-drop-zone"]')
    await expect(zone).toBeVisible()
    const addRow = page.locator('.focus-inline-add-trigger', { hasText: 'Add to Satellite…' })
    await expect(addRow).toBeVisible()

    // The contract: the add row starts at or below the bottom of the LAST card, and
    // overlaps no card at all. Before the fix the row cut across the last card.
    const geometry = await page.evaluate(() => {
      const z = document.querySelector('[data-drop-zone="satellite-drop-zone"]')!
      const add = document.querySelector('.focus-inline-add-trigger')!
      const a = add.getBoundingClientRect()
      const cards = [...z.querySelectorAll('[data-task-id]')]
      const lastBottom = Math.max(...cards.map((c) => c.getBoundingClientRect().bottom))
      const overlapping = cards.filter((c) => {
        const r = c.getBoundingClientRect()
        return r.top < a.bottom - 1 && r.bottom > a.top + 1
      }).length
      return { cardCount: cards.length, addTop: a.top, lastBottom, overlapping }
    })
    expect(geometry.cardCount).toBeGreaterThan(20)
    expect(geometry.overlapping).toBe(0)
    // 1px slack for sub-pixel rounding.
    expect(geometry.addTop).toBeGreaterThanOrEqual(geometry.lastBottom - 1)
  })

  for (const { tab, label } of TIERS) {
    test(`adding a task to ${tab} keeps it (no silent 409 rollback)`, async ({ page }) => {
      const title = `inline add ${tab} ${Date.now()}`
      await page.goto('/')
      await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })
      await selectCategory(page, 'All')
      await selectSection(page, tab)

      await page.locator('.focus-inline-add-trigger', { hasText: label }).click()
      const input = page.locator('.focus-inline-add input')
      await expect(input).toBeVisible()
      await input.fill(title)
      await input.press('Enter')

      // The card must still be there after the server round-trip settles. A failed
      // create rolls the optimistic row back, so a card that survives here proves
      // the task was really persisted.
      const card = page.locator(`.todo-pinned-wrapper [data-task-id]`, { hasText: title })
      await expect(card).toBeVisible({ timeout: 15_000 })
      await page.waitForTimeout(1_500)
      await expect(card).toBeVisible()

      // Server-side truth: the task exists AND is pinned in the right tier.
      const tiers = (await (await page.request.get('/api/focus/tasks')).json()) as {
        focus_tasks: string[]; satellite_tasks: string[]; backlog_tasks: string[]; wait_tasks: string[]
      }
      const created = ((await (await page.request.get('/api/tasks?fields=list')).json()) as
        { tasks: { id: string; title: string }[] }).tasks.find((t) => t.title === title)
      expect(created, 'created task must exist server-side').toBeTruthy()
      const inTier = {
        Focus: tiers.focus_tasks, Satellite: tiers.satellite_tasks, Backlog: tiers.backlog_tasks, Wait: tiers.wait_tasks,
      }[tab]
      expect(inTier).toContain(created!.id)

      // The row survives a reload — rules out "only ever an optimistic ghost".
      await page.reload()
      await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('.todo-pinned-wrapper [data-task-id]', { hasText: title }))
        .toBeVisible({ timeout: 15_000 })
    })
  }

  test('quick capture lands in the local-reserved default category', async ({ page }) => {
    // Guards the actual root cause of the disappearing task: the default capture
    // category is hard-reserved local, so the create must resolve to source=local
    // rather than 409'ing on a stale plugin registration.
    const title = `capture source probe ${Date.now()}`
    await page.goto('/')
    await expect(page.locator('.todo-section-tabs')).toBeVisible({ timeout: 20_000 })
    await selectCategory(page, 'All')
    await selectSection(page, 'Focus')

    await page.locator('.focus-inline-add-trigger', { hasText: 'Add to Focus…' }).click()
    const input = page.locator('.focus-inline-add input')
    await input.fill(title)
    await input.press('Enter')
    await expect(page.locator('.todo-pinned-wrapper [data-task-id]', { hasText: title }))
      .toBeVisible({ timeout: 15_000 })

    const created = ((await (await page.request.get('/api/tasks?fields=list')).json()) as
      { tasks: { title: string; source: string; category: string }[] })
      .tasks.find((t) => t.title === title)
    expect(created).toBeTruthy()
    expect(created!.source).toBe('local')

    // And no "Action failed" toast fired.
    await expect(page.locator('.notification-toast', { hasText: 'Action failed' })).toHaveCount(0)
  })
})
