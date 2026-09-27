/**
 * Push / pop cost on the dense fixture (C38): no long task over 50ms while a
 * question page is pushed or popped along Q6 > Q17 > Q24 > Q28. Chromium only
 * (WebKit has no longtask entry type). Each step's long tasks are collected from
 * the click / Esc until two frames after the new page painted.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { centreInHistory, DENSE_SESSION, openThreadsSession, resetThreadsFixture } from './threads-helpers'

const TASK = 'pw-task-threads-dense'
const READY = 'Walk me through part 6 of the storage notes.'

async function expectDepth(panel: Locator, depth: number): Promise<void> {
  await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', String(depth), { timeout: 15_000 })
}

async function centre(page: Page, panel: Locator, target: Locator): Promise<void> {
  await centreInHistory(page, panel, target, { maxStep: 600 })
}

/** Start collecting long tasks; `take()` returns the durations since. */
async function arm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[]; __obs?: PerformanceObserver }
    w.__long = []
    w.__obs?.disconnect()
    w.__obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) w.__long.push(Math.round(e.duration)) })
    w.__obs.observe({ type: 'longtask', buffered: false })
  })
}

async function take(page: Page): Promise<number[]> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))))
  return page.evaluate(() => (window as unknown as { __long: number[] }).__long.slice())
}

test.describe('Question stack push / pop cost', () => {
  test.setTimeout(240_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, DENSE_SESSION) })

  test('no long task over 50ms on push or pop along the dense four-level branch (C38)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'longtask entries are Chromium only')
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openThreadsSession(page, DENSE_SESSION, TASK, READY)
    await page.waitForTimeout(1500)
    const steps: Array<{ step: string; long: number[] }> = []
    const chain: Array<string | RegExp> = ['Late flush risk', 'Reader skip cost', /point 24/i, /point 28/i]
    for (let i = 0; i < chain.length; i++) {
      const row = panel.locator('.thread-asked-row', { hasText: chain[i] }).first()
      await expect(row).toBeVisible()
      await centre(page, panel, row)
      await page.waitForTimeout(500)
      await arm(page)
      await row.click()
      await expectDepth(panel, i + 1)
      steps.push({ step: `push${i + 1}`, long: await take(page) })
    }
    for (let d = chain.length - 1; d >= 0; d--) {
      await page.waitForTimeout(500)
      const hb = (await panel.locator('.session-history').boundingBox())!
      await page.mouse.move(hb.x + hb.width * 0.7, hb.y + hb.height * 0.6)
      await arm(page)
      await page.keyboard.press('Escape')
      await expectDepth(panel, d)
      steps.push({ step: `pop${d}`, long: await take(page) })
    }
    const worst = Math.max(0, ...steps.flatMap((s) => s.long))
    console.log('push/pop long tasks', JSON.stringify(steps))
    expect(worst, `long tasks per step: ${JSON.stringify(steps)}`).toBeLessThanOrEqual(50)
  })
})
