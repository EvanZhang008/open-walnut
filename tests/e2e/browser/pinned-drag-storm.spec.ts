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
 * This spec replicates the crash conditions: drag held with the panel filtered
 * to one project while a PATCH storm churns the task store, including
 * cross-tier hovers. The frozen model is observed directly: the storm renames
 * pinned filler cards, and their titles must hold still until the drop.
 */
import { test, expect, type Page } from '@playwright/test'
import { selectProject, showAllSections } from './todo-panel-helpers'

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

// selectProject comes from todo-panel-helpers — this file used to carry its own
// copy, which meant every panel-markup change had to be made twice.

/** PATCH filler tasks in a loop — emulates the session-status / task:updated
 *  storm from the crash console ("transition accepted" x2352, bulk refetch).
 *  Each PATCH renames a filler, because a title is what a pinned card draws
 *  from the render model the drag freezes. */
function startChurnStorm(taskIds: string[], intervalMs: number): { stop: () => Promise<number> } {
  let running = true
  let count = 0
  const loop = (async () => {
    while (running) {
      const id = taskIds[count % taskIds.length]
      await fetch(`${API}/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `Storm filler churn ${count}` }),
      }).catch(() => {})
      count += 1
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    return count
  })()
  return { stop: async () => { running = false; return loop } }
}

test('pinned drag survives task-churn storm on a non-All chip (no React #185)', async ({ page }) => {
  test.setTimeout(90_000)
  const proj = `DragProj${Date.now().toString(36)}`

  // Seed: one card per tier the drag crosses, plus pinned Satellite fillers the
  // storm renames while the drag is live.
  const focusTask = await createTaskViaApi('Storm focus', { project: proj })
  const satTask = await createTaskViaApi('Storm satellite', { project: proj })
  const waitTask = await createTaskViaApi('Storm wait', { project: proj })
  const fillers: string[] = []
  for (let i = 0; i < 8; i++) {
    const t = await createTaskViaApi(`Storm filler ${i}`, { project: proj })
    fillers.push(t.id)
  }
  const seeded = [focusTask.id, satTask.id, waitTask.id, ...fillers]
  try {
    await pinTaskViaApi(focusTask.id, 'focus')
    await pinTaskViaApi(satTask.id, 'satellite')
    await pinTaskViaApi(waitTask.id, 'wait')
    for (const id of fillers) await pinTaskViaApi(id, 'satellite')

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
    // Crash precondition: the panel filtered to one project.
    await selectProject(page, proj)

    const tierScope = page.locator('#home-task-navigation .todo-pinned-section:not(.todo-pinned-section-recent)')
    // Wait starts folded out of the box, and a folded tier draws no cards to hover.
    const waitHeading = page.locator('#home-task-navigation [data-navigation-id="wait"] .navigation-heading-open')
    if ((await waitHeading.getAttribute('aria-expanded')) !== 'true') await waitHeading.click()
    const focusCard = tierScope.locator(`[data-task-id="${focusTask.id}"]`)
    const satCard = tierScope.locator(`[data-task-id="${satTask.id}"]`)
    const waitCard = tierScope.locator(`[data-task-id="${waitTask.id}"]`)
    await expect(focusCard).toBeVisible({ timeout: 10_000 })
    await expect(waitCard).toBeVisible()
    await expect(tierScope.locator(`[data-task-id="${fillers[fillers.length - 1]}"]`)).toBeVisible()
    const grip = focusCard.locator('.todo-pinned-title')

    const fillerTitles = () => page.evaluate((ids) => ids.map((id) =>
      document.querySelector(`#home-task-navigation .todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${id}"] .todo-pinned-title`)?.textContent ?? null,
    ), fillers)
    const hover = async (target: typeof satCard) => {
      await target.scrollIntoViewIfNeeded()
      const box = await target.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 10 })
    }

    // Start the storm, then drag while it runs.
    const storm = startChurnStorm(fillers, 60)
    try {
      const srcBox = await grip.boundingBox()
      expect(srcBox).not.toBeNull()
      await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2)
      await page.mouse.down()
      await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2 + 8)
      const titlesAtDragStart = await fillerTitles()
      expect(titlesAtDragStart.every((t) => t !== null)).toBe(true)
      // Cross-tier hovers with holds — the crash scenario ("drag task in the
      // pinned area" during churn). Holds give the storm time to land re-renders
      // mid-drag; steps exercise collision recomputation. Each hover re-acquires its
      // target: the cross-tier preview moves cards in real time and a hold near the
      // scroller's edge auto-scrolls it.
      await hover(satCard)
      await page.waitForTimeout(1500)
      await hover(waitCard)
      await page.waitForTimeout(1500)
      await hover(satCard)
      await page.waitForTimeout(1500)

      // Mid-drag invariants:
      // 1. Frozen render model: the storm renamed the fillers dozens of times on the
      //    server, and not one pinned card changed its title while the drag is live.
      expect(await fillerTitles(), 'pinned cards re-rendered from live data mid-drag: render model not frozen').toEqual(titlesAtDragStart)
      // 2. At most one TIER card for the dragged id.
      await expect(tierScope.locator(`[data-task-id="${focusTask.id}"]`)).toHaveCount(1)
      // 3. No crash signals so far.
      expect(crashes, `crash signals mid-drag:\n${crashes.join('\n')}`).toEqual([])

      // Release on the Satellite HEADING, which a card preview never slides under, so
      // the drop deterministically lands in Satellite whatever auto-scroll did during
      // the holds. Follow it for a few frames until the preview settles (as
      // home-navigation-drag.spec.ts does).
      const satHeading = page.locator('#home-task-navigation [data-navigation-id="satellite"]')
      await hover(satHeading)
      for (let step = 0; step < 5; step++) {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const box = await satHeading.boundingBox()
        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
      }
      await page.mouse.up()
    } finally {
      await storm.stop()
    }

    // AFTER the drag ends the model converges to live data (freeze released).
    const renamed = `Storm filler converged ${Date.now()}`
    await fetch(`${API}/api/tasks/${fillers[0]}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: renamed }),
    })
    await expect(tierScope.locator(`[data-task-id="${fillers[0]}"] .todo-pinned-title`)).toHaveText(renamed, { timeout: 10_000 })

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
  } finally {
    // Pinned cards left in the shared fixture push later specs' drag targets out of view.
    for (const id of seeded) {
      await fetch(`${API}/api/focus/tasks/${id}`, { method: 'DELETE' }).catch(() => {})
      await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => {})
    }
  }
})
