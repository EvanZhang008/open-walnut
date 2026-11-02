/**
 * Push / pop cost on the dense fixture (C38): no long task over 50ms while a
 * question page is pushed or popped along Q6 > Q17 > Q24 > Q28. Chromium only
 * (WebKit has no longtask entry type). Each step's long tasks are collected from
 * the click / Esc until two frames after the new page painted, each with the CPU
 * its main thread spent in it (Chrome's trace): the budget is judged on that CPU,
 * and on the wall time only when the machine has a core to spare. Judged on the
 * production bundle (production-bundle.ts: React's development build spends most
 * of such a task on its own debugging).
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { centreInHistory, DENSE_SESSION, openThreadsSession, resetThreadsFixture, test } from './threads-helpers'
import { chromiumCpuClock, longTaskBudget, machineQuiet, referenceDrawMs, traceTaskTimes, type TaskTime } from './cpu-reference'
import { serveProductionBundle } from './production-bundle'

const TASK = 'pw-task-threads-dense'
const READY = 'Walk me through part 6 of the storage notes.'

async function expectDepth(panel: Locator, depth: number): Promise<void> {
  await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', String(depth), { timeout: 15_000 })
}

async function centre(page: Page, panel: Locator, target: Locator): Promise<void> {
  await centreInHistory(page, panel, target, { maxStep: 600 })
}

/** Start collecting long tasks; `take()` returns the durations since, and their CPU. */
let stopTrace: (() => Promise<TaskTime[]>) | null = null
async function arm(page: Page): Promise<void> {
  stopTrace = await traceTaskTimes(page)
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[]; __obs?: PerformanceObserver }
    w.__long = []
    w.__obs?.disconnect()
    w.__obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) w.__long.push(Math.round(e.duration)) })
    w.__obs.observe({ type: 'longtask', buffered: false })
  })
}

async function take(page: Page): Promise<{ long: number[]; tasks: TaskTime[] }> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))))
  const tasks = stopTrace ? await stopTrace() : []
  stopTrace = null
  return { long: await page.evaluate(() => (window as unknown as { __long: number[] }).__long.slice()), tasks }
}

test.describe('Question stack push / pop cost', () => {
  test.setTimeout(240_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, DENSE_SESSION) })

  test('no long task over 50ms on push or pop along the dense four-level branch (C38)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'longtask entries are Chromium only')
    await serveProductionBundle(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openThreadsSession(page, DENSE_SESSION, TASK, READY)
    await page.waitForTimeout(1500)
    const steps: Array<{ step: string; long: number[]; tasks: TaskTime[] }> = []
    const chain: Array<string | RegExp> = ['Late flush risk', 'Reader skip cost', /point 24/i, /point 28/i]
    for (let i = 0; i < chain.length; i++) {
      const row = panel.locator('.thread-asked-row', { hasText: chain[i] }).first()
      await expect(row).toBeVisible()
      await centre(page, panel, row)
      await page.waitForTimeout(500)
      await arm(page)
      await row.click()
      await expectDepth(panel, i + 1)
      steps.push({ step: `push${i + 1}`, ...await take(page) })
    }
    for (let d = chain.length - 1; d >= 0; d--) {
      await page.waitForTimeout(500)
      const hb = (await panel.locator('.session-history').boundingBox())!
      await page.mouse.move(hb.x + hb.width * 0.7, hb.y + hb.height * 0.6)
      await arm(page)
      await page.keyboard.press('Escape')
      await expectDepth(panel, d)
      steps.push({ step: `pop${d}`, ...await take(page) })
    }
    const worst = Math.max(0, ...steps.flatMap((s) => s.long))
    const worstCpu = Math.max(0, ...steps.flatMap((s) => s.tasks.map((t) => t.cpu)))
    console.log('push/pop long tasks', JSON.stringify(steps))
    // Measured after the steps it judges; a slower machine's tasks are longer in proportion.
    const reference = await referenceDrawMs(page, await chromiumCpuClock(page))
    const budget = longTaskBudget(50, reference)
    const why = `long tasks per step: ${JSON.stringify(steps)} (budget ${budget} ms, reference ${reference} ms)`
    expect(worstCpu, why).toBeLessThanOrEqual(budget)
    if (machineQuiet()) expect(worst, why).toBeLessThanOrEqual(budget)
  })
})
