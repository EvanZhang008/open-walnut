/**
 * Drag a task into another project's folder — the pinned tier gesture.
 *
 * Regression pins for the "drag does nothing" bug: dropping a card into another
 * project's run in a by-project tier used to persist only the pin reorder, then
 * the project cluster pass snapped the card straight back. Now the drop moves
 * the task's project, and a move that crosses a PROVIDER boundary confirms
 * first (the old remote twin gets archived server-side, which is destructive).
 *
 * Both scenarios seed purely over HTTP: a task created with an unknown source
 * (`fake-provider`) mints its project's registry row claimed by that source, so
 * no plugin install is needed, and the migration completes cleanly (old-source
 * cleanup is skipped for an unregistered plugin; the new source is local, so
 * the post-migration push is a no-op).
 *
 * Serialized: both tests drag inside the same Focus tier on the shared fixture
 * dataset.
 */

import { test, expect, type Page } from '@playwright/test'
import { selectSection } from './todo-panel-helpers'
import { presetTierViewModes } from './draft-surface-helpers'

test.describe.configure({ mode: 'serial' })

interface Seeded { id: string }

async function seedTask(page: Page, title: string, project: string, source?: string): Promise<string> {
  const res = await page.request.post('/api/tasks', {
    data: { title, project, ...(source ? { source } : {}) },
  })
  if (!res.ok()) throw new Error(`seed task failed: ${res.status()} ${await res.text()}`)
  const { task } = (await res.json()) as { task: Seeded }
  // Pin into the Focus tier so the card renders in the by-project pinned area.
  const pin = await page.request.post(`/api/focus/tasks/${task.id}`, { data: {} })
  if (!pin.ok()) throw new Error(`pin failed: ${pin.status()} ${await pin.text()}`)
  const tier = await page.request.put(`/api/focus/tasks/${task.id}/tier`, { data: { tier: 'focus' } })
  if (!tier.ok()) throw new Error(`set tier failed: ${tier.status()} ${await tier.text()}`)
  return task.id
}

async function taskState(page: Page, id: string): Promise<{ project: string; source?: string } | undefined> {
  const res = await page.request.get('/api/tasks')
  const { tasks } = (await res.json()) as { tasks: Array<{ id: string; project: string; source?: string }> }
  return tasks.find((t) => t.id === id)
}

async function cleanup(page: Page, ids: string[], projects: string[]): Promise<void> {
  for (const id of ids) {
    await page.request.delete(`/api/focus/tasks/${id}`).catch(() => {})
    await page.request.delete(`/api/tasks/${id}`).catch(() => {})
  }
  for (const name of projects) {
    await page.request.delete(`/api/projects/${encodeURIComponent(name)}`).catch(() => {})
  }
}

/** Real pointer drag: grab the card's drag handle, walk to the target card. */
async function dragCardOnto(page: Page, srcId: string, dstId: string): Promise<void> {
  const src = page.locator(`[data-task-id="${srcId}"]`).first()
  const dst = page.locator(`[data-task-id="${dstId}"]`).first()
  await src.scrollIntoViewIfNeeded()
  await src.hover()
  const handle = src.locator('.todo-pinned-drag-handle')
  const sb = await handle.boundingBox()
  const db = await dst.boundingBox()
  if (!sb || !db) throw new Error('missing bounding box for drag')
  const sx = sb.x + sb.width / 2, sy = sb.y + sb.height / 2
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  // PointerSensor activation (distance: 5), then walk to the target's center.
  await page.mouse.move(sx + 8, sy + 8, { steps: 3 })
  await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 15 })
  // Re-target the CURRENT position before release — the live preview shifts
  // layout, and releasing at stale coordinates lands on whatever slid under
  // the pointer (same trap custom-focus-tiers.spec.ts documents).
  const dbNow = await dst.boundingBox()
  if (dbNow) await page.mouse.move(dbNow.x + dbNow.width / 2, dbNow.y + dbNow.height / 2, { steps: 6 })
  await page.waitForTimeout(300)
  await page.mouse.up()
  // Then let dnd-kit's document listeners go. On mouseup the library keeps a
  // CAPTURE-phase `click` listener on the document and only removes it on a
  // setTimeout(..., 50), so any click dispatched inside that window is swallowed
  // before React's root delegation sees it. This drag opens a confirm dialog on
  // the same tick, so a caller that clicks Cancel the instant the modal appears
  // lands inside the window: the button takes focus from mousedown but its
  // handler never runs, and the dialog just stays open. Same mechanism
  // project-collapse-menu.spec.ts documents at its live-drag case.
  await page.waitForTimeout(250)
}

test('by-project tier drag: local→local moves the task, no dialog', async ({ page }) => {
  const stamp = Date.now().toString(36).slice(-5)
  const projA = `MoveSpec A ${stamp}`
  const projB = `MoveSpec B ${stamp}`
  await presetTierViewModes(page, { focus: 'project' })
  const a = await seedTask(page, `move-local ${stamp}`, projA)
  const b = await seedTask(page, `anchor-b ${stamp}`, projB)
  try {
    await page.goto('/')
    await page.locator('.todo-section-tabs').first().waitFor({ state: 'visible', timeout: 30_000 })
    await selectSection(page, 'Focus')
    await expect(page.locator(`[data-task-id="${a}"]`)).toBeVisible({ timeout: 15_000 })

    await dragCardOnto(page, a, b)

    // Server truth, not DOM order: the task's project changed…
    await expect.poll(async () => (await taskState(page, a))?.project, { timeout: 15_000 }).toBe(projB)
    // …and no cross-provider confirm ever appeared (local→local is silent).
    await expect(page.locator('.app-modal', { hasText: 'Move across providers?' })).toHaveCount(0)
  } finally {
    await cleanup(page, [a, b], [projA, projB])
  }
})

test('cross-provider drag: confirm gates the move; cancel keeps everything', async ({ page }) => {
  const stamp = Date.now().toString(36).slice(-5)
  const projRemote = `MoveSpec R ${stamp}`
  const projLocal = `MoveSpec L ${stamp}`
  await presetTierViewModes(page, { focus: 'project' })
  const r = await seedTask(page, `move-remote ${stamp}`, projRemote, 'fake-provider')
  const l = await seedTask(page, `anchor-l ${stamp}`, projLocal)
  try {
    await page.goto('/')
    await page.locator('.todo-section-tabs').first().waitFor({ state: 'visible', timeout: 30_000 })
    await selectSection(page, 'Focus')
    await expect(page.locator(`[data-task-id="${r}"]`)).toBeVisible({ timeout: 15_000 })

    // Round 1: cancel → nothing changes.
    await dragCardOnto(page, r, l)
    const modal = page.locator('.app-modal', { hasText: 'Move across providers?' })
    await modal.waitFor({ state: 'visible', timeout: 15_000 })
    await modal.locator('.app-modal-btn', { hasText: 'Cancel' }).click()
    await page.waitForTimeout(800)
    const afterCancel = await taskState(page, r)
    expect(afterCancel?.project).toBe(projRemote)
    expect(afterCancel?.source).toBe('fake-provider')

    // Round 2: confirm → project moves and the task migrates to local.
    await dragCardOnto(page, r, l)
    await modal.waitFor({ state: 'visible', timeout: 15_000 })
    await modal.locator('.app-modal-btn.primary').click()
    await expect.poll(async () => (await taskState(page, r))?.project, { timeout: 20_000 }).toBe(projLocal)
    expect((await taskState(page, r))?.source).toBe('local')
  } finally {
    await cleanup(page, [r, l], [projRemote, projLocal])
  }
})
