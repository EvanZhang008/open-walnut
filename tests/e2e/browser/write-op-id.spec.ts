/**
 * One op id per user action, kept across its retries (web/src/api/write-retry.ts,
 * docs/plan/walnut-replica-servers-impl.md section 3, "Op ids").
 *
 * A board row's done circle is clicked while the network drops the first
 * attempt: the retry carries the SAME `x-walnut-op-id`, the task completes
 * once, and the next click (another action) carries a new id. A host replica
 * and the Mac dedupe a write by this id, so a retry that minted a fresh one
 * could apply an action twice.
 */
import { expect, test } from '@playwright/test'

const OP_ID = /^op-[0-9a-f]{16}$/

test('a retried board write keeps its op id; the next action gets a new one', async ({ page, request }) => {
  const title = `Op id probe ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const made = await request.post('/api/tasks', { data: { title } })
  expect(made.ok()).toBe(true)
  const id = ((await made.json()) as { task: { id: string } }).task.id

  const seen: Array<{ path: string; opId: string | null; dropped: boolean }> = []
  let dropNext = true
  await page.route((url) => url.pathname === `/api/tasks/${id}` || url.pathname.startsWith(`/api/tasks/${id}/`), async (route) => {
    const req = route.request()
    if (req.method() === 'GET') { await route.continue(); return }
    const entry = { path: new URL(req.url()).pathname, opId: req.headers()['x-walnut-op-id'] ?? null, dropped: dropNext }
    seen.push(entry)
    if (dropNext) { dropNext = false; await route.abort('failed'); return }
    await route.continue()
  })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.todo-search-input').fill(title)
  const row = page.locator(`.todo-panel-item[data-task-id="${id}"]`)
  await expect(row).toBeVisible()
  const circle = row.locator('.task-phase-icon-btn')

  // 1. Complete: the first attempt is dropped, the retry gets through under the same id.
  await circle.click()
  await expect.poll(async () => {
    const res = await request.get(`/api/tasks/${id}`)
    return ((await res.json()) as { task: { phase: string } }).task.phase
  }, { timeout: 15_000 }).toBe('COMPLETE')
  const first = seen.slice()
  expect(first.length).toBeGreaterThanOrEqual(2)
  expect(first[0]!.dropped).toBe(true)
  expect(first[0]!.opId).toMatch(OP_ID)
  expect(new Set(first.map((s) => s.opId)).size).toBe(1)
  const firstOpId = first[0]!.opId

  // 2. Reopen is another action: a new id, sent once.
  const firstCount = seen.length
  await expect(circle).toHaveAttribute('title', 'Done: click to reopen')
  await circle.click()
  await expect.poll(async () => {
    const res = await request.get(`/api/tasks/${id}`)
    return ((await res.json()) as { task: { phase: string } }).task.phase
  }, { timeout: 15_000 }).not.toBe('COMPLETE')
  const second = seen.slice(firstCount)
  expect(second).toHaveLength(1)
  expect(second[0]!.opId).toMatch(OP_ID)
  expect(second[0]!.opId).not.toBe(firstOpId)
})
