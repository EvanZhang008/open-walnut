/**
 * Regression test for the pinned-area drag React #185 crash.
 *
 * Root cause (2026-07-23): during a pinned drag, the pinned-area render model
 * (visibleTaskIds membership filter, recentTasks sort, pinnedTasks resolution)
 * was NOT frozen — external task churn (WS task:updated echoes, refetches,
 * last_session_update touches) reordered/remounted cards mid-drag, so dnd-kit's
 * useRect saw a new element identity on every commit and its layout-effect
 * setState looped past React's 50-nested-update guard (error #185).
 *
 * This spec replicates the crash conditions: drag held on a NON-All category
 * tab (the crash URL had cat=personal — pinned cards are only visible there
 * because of the cross-category focus view) while a PATCH storm churns the
 * task store, including cross-tier hovers.
 */
import { test, expect, type Page } from '@playwright/test'
import { showAllSections } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

async function createTaskViaApi(
  title: string,
  opts: Record<string, string> = {},
): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: uniqueTitle, source: 'local', ...opts }),
  })
  if (!res.ok) throw new Error(`API call failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string; title: string } }
  return body.task
}

async function pinTaskViaApi(taskId: string, tier = 'focus'): Promise<void> {
  const pinRes = await fetch(`${API}/api/focus/tasks/${taskId}`, { method: 'POST' })
  if (!pinRes.ok) throw new Error(`Pin failed: ${pinRes.status} ${await pinRes.text()}`)
  const tierRes = await fetch(`${API}/api/focus/tasks/${taskId}/tier`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier }),
  })
  if (!tierRes.ok) throw new Error(`Tier failed: ${tierRes.status} ${await tierRes.text()}`)
}

async function selectCategory(page: Page, category: string): Promise<void> {
  if (!await page.locator('.vd-panel').isVisible()) {
    await page.getByRole('button', { name: 'View options' }).click()
  }
  await page.locator('.vd-cat').filter({
    has: page.locator('.vd-cat-name').filter({ hasText: new RegExp(`^${category}$`) }),
  }).click()
  await page.keyboard.press('Escape')
}

/** PATCH filler tasks in a loop — emulates the session-status / task:updated
 *  storm from the crash console ("transition accepted" x2352, bulk refetch). */
function startChurnStorm(taskIds: string[], intervalMs: number): { stop: () => Promise<number> } {
  let running = true
  let count = 0
  const loop = (async () => {
    while (running) {
      const id = taskIds[count % taskIds.length]
      await fetch(`${API}/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: `churn ${count}` }),
      }).catch(() => {})
      count += 1
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    return count
  })()
  return { stop: async () => { running = false; return loop } }
}

test('pinned drag survives task-churn storm on a non-All tab (no React #185)', async ({ page }) => {
  test.setTimeout(60_000)
  const cat = `DragCat${Date.now().toString(36)}`

  // Seed: 3 pinned across tiers + filler tasks that dominate the Recent feed so
  // churn PATCHes re-sort Recent (top-50 by updated_at/last_session_update).
  const focusTask = await createTaskViaApi('Storm focus', { category: cat })
  const satTask = await createTaskViaApi('Storm satellite', { category: cat })
  const waitTask = await createTaskViaApi('Storm wait', { category: cat })
  const fillers: string[] = []
  for (let i = 0; i < 12; i++) {
    const t = await createTaskViaApi(`Storm filler ${i}`, { category: cat })
    fillers.push(t.id)
  }
  await pinTaskViaApi(focusTask.id, 'focus')
  await pinTaskViaApi(satTask.id, 'satellite')
  await pinTaskViaApi(waitTask.id, 'wait')

  // Collect every signal the crash produced: React error boundary console lines
  // and uncaught page errors.
  const crashes: string[] = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return
    const text = msg.text()
    if (/Maximum update depth|error #185|Minified React error #185|error-boundary|render error caught/i.test(text)) {
      crashes.push(text.slice(0, 300))
    }
  })
  page.on('pageerror', (err) => { crashes.push(`pageerror: ${String(err).slice(0, 300)}`) })

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // This spec drags ACROSS tiers (focus → satellite → wait), so all three must be
  // mounted at once — that's the "All" SECTION tab. A single-tier tab renders one
  // tier only, and there'd be no cross-tier target to drop on.
  await showAllSections(page)

  // Crash precondition: a NON-All category tab (cross-category focus view keeps
  // the pinned cards visible there).
  await selectCategory(page, cat)

  // Tier cards: focus tier uses .todo-focus-card, satellite/wait use
  // .todo-pinned-card. Scope to the non-Recent pinned section — a pinned task
  // ALSO renders a (non-draggable) card in the Recent feed with the same
  // data-task-id.
  const tierScope = page.locator('.todo-pinned-section:not(.todo-pinned-section-recent)')
  const focusCard = tierScope.locator(`.todo-focus-card[data-task-id="${focusTask.id}"]`)
  await expect(focusCard).toBeVisible({ timeout: 5000 })
  const handle = focusCard.locator('.todo-pinned-drag-handle')
  const satCard = tierScope.locator(`.todo-pinned-card[data-task-id="${satTask.id}"]`)
  const waitCard = tierScope.locator(`.todo-pinned-card[data-task-id="${waitTask.id}"]`)

  const srcBox = await handle.boundingBox()
  const satBox = await satCard.boundingBox()
  const waitBox = await waitCard.boundingBox()
  expect(srcBox).not.toBeNull()
  expect(satBox).not.toBeNull()
  expect(waitBox).not.toBeNull()

  // The #185 crash itself is timing-dependent (needs production-scale layout
  // thrash to push >50 nested commits), so this spec asserts the structural
  // invariant that FEEDS the crash loop instead: while a pinned drag is active,
  // external task churn must NOT reshape the pinned-area render model. The
  // observable proxy is the Recent feed — it sorts by updated_at, so on the
  // unfrozen (buggy) model the churn PATCHes visibly re-sort it mid-drag.
  const recentOrder = () => page.$$eval(
    '.todo-pinned-section-recent .todo-pinned-card',
    (els) => els.map((el) => el.getAttribute('data-task-id')).join(','),
  )

  // Start the storm, then drag while it runs.
  const storm = startChurnStorm(fillers, 60)
  try {
    await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2 + 8)
    const orderAtDragStart = await recentOrder()
    // Cross-tier hovers with holds — the crash scenario ("drag task in the
    // pinned area" during churn). Holds give the storm time to land re-renders
    // mid-drag; steps exercise collision recomputation.
    await page.mouse.move(satBox!.x + satBox!.width / 2, satBox!.y + satBox!.height / 2, { steps: 10 })
    await page.waitForTimeout(1500)
    await page.mouse.move(waitBox!.x + waitBox!.width / 2, waitBox!.y + waitBox!.height / 2, { steps: 10 })
    await page.waitForTimeout(1500)
    await page.mouse.move(satBox!.x + satBox!.width / 2, satBox!.y + satBox!.height / 2, { steps: 10 })
    await page.waitForTimeout(1500)

    // Mid-drag invariants:
    // 1. Frozen render model — Recent order identical to drag start despite
    //    ~75 churn PATCHes having re-sorted the underlying data.
    expect(await recentOrder(), 'Recent re-sorted mid-drag — render model not frozen').toBe(orderAtDragStart)
    // 2. At most one TIER card for the dragged id (it may render as
    //    .todo-focus-card or .todo-pinned-card depending on the hover tier).
    await expect(tierScope.locator(`[data-task-id="${focusTask.id}"]`)).toHaveCount(1)
    // 3. No crash signals so far.
    expect(crashes, `crash signals mid-drag:\n${crashes.join('\n')}`).toEqual([])

    await page.mouse.up()
  } finally {
    await storm.stop()
  }

  // AFTER the drag ends the model must converge to live data (freeze released):
  // touch one filler and it must float to the top of the Recent feed.
  await fetch(`${API}/api/tasks/${fillers[0]}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'post-drag convergence touch' }),
  })
  await expect.poll(async () => (await recentOrder()).split(',')[0], { timeout: 5000 }).toBe(fillers[0])

  // Post-drop: no crash, panel alive, drop persisted (task moved to satellite tier).
  await expect.poll(async () => {
    const res = await fetch(`${API}/api/focus/tasks`)
    const body = (await res.json()) as { satellite_tasks?: string[]; focus_tasks?: string[] }
    return body.satellite_tasks?.includes(focusTask.id)
      ?? !body.focus_tasks?.includes(focusTask.id)
  }, { timeout: 5000 }).toBe(true)
  expect(crashes, `crash signals:\n${crashes.join('\n')}`).toEqual([])

  // Panel still interactive after the storm (error boundary did not swallow it).
  await expect(satCard).toBeVisible()
})
