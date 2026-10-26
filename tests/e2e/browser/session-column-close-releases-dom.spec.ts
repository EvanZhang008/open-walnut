/**
 * A closed session column lets go of its DOM.
 *
 * Measured 2026-10-25 against the live console in Chromium: every session
 * column that left the strip stayed in memory with its whole chat (about 1,400
 * DOM nodes a switch; 20 switches left 35k nodes for a 4.5k-node page). The
 * holder was @formkit/auto-animate, which animates the strip. It keeps three
 * things per child: an IntersectionObserver on its position, which a pending
 * position update set up again after the column was removed; for the children
 * present when the strip mounted, a 2 s position poll (a live interval) and a
 * ResizeObserver observation. Each keeps the element alive, and a child polled
 * twice had its first interval replaced in the map, so nothing could stop it.
 * web/patches/ fixes the library: a child that left the document drops all of it.
 *
 * Measured in WebKit (the Mac app) the same switching showed no detached DOM,
 * so the check runs in Chromium, where the CDP node count makes it measurable.
 */
import { test, expect, type Page, type CDPSession } from '@playwright/test'

/** Seeded, stopped sessions from test-server.ts, restored as columns at load. */
const SIDS = ['pw-normal-session', 'pw-vscode-session', 'pw-plan-session-completed']
/** Two more, opened later through the finder by their titles. */
const LATER = [
  { id: 'pw-service-session', query: 'Service preview' },
  { id: 'pw-idref-session', query: 'Task id refs' },
]

async function openColumnsOnHome(page: Page) {
  await page.addInitScript((ids) => {
    try {
      sessionStorage.setItem(
        'open-walnut-home-session-columns',
        JSON.stringify((ids as string[]).map((id) => ({ id, locked: false }))),
      )
    } catch { /* ignore */ }
  }, SIDS)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
}

/** Nodes alive in the renderer minus nodes in the document, after a full GC. */
async function detachedNodes(page: Page, cdp: CDPSession): Promise<number> {
  for (let i = 0; i < 3; i++) {
    await cdp.send('HeapProfiler.collectGarbage')
    await page.waitForTimeout(200)
  }
  const { metrics } = await cdp.send('Performance.getMetrics')
  const alive = metrics.find((m) => m.name === 'Nodes')!.value
  const attached = await page.evaluate(() => {
    let n = 1
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL)
    while (walker.nextNode()) n++
    return n
  })
  return alive - attached
}

/** Open a session as a home column through the finder (Cmd+Shift+O, type, click). */
async function openViaFinder(page: Page, query: string, sid: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('ControlOrMeta+Shift+O')
  const finder = page.locator('.session-search-panel')
  await expect(finder).toBeVisible()
  await finder.locator('.session-search-input').fill(query)
  const result = finder.locator('.session-search-result').filter({ has: page.locator('.session-search-title', { hasText: query }) })
  await expect(result).toHaveCount(1, { timeout: 10_000 })
  await result.click()
  await expect(page.locator(`.main-page-session-column[data-column-id="${sid}"] .session-history`)).toBeVisible({ timeout: 30_000 })
}

const closeFirstColumn = async (page: Page) => {
  const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
  const n = await columns.count()
  await columns.first().getByRole('button', { name: 'Close session panel' }).click()
  await expect(columns).toHaveCount(n - 1)
  // Past the 320 ms exit animation, auto-animate's position debounce and one
  // tick of its 2 s position poll, which is what lets a removed child go.
  await page.waitForTimeout(2600)
}

test('closing session columns releases their DOM', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'needs the CDP node count')
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1800, height: 1000 })
  await openColumnsOnHome(page)
  const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
  await expect(columns.first().locator('.session-history')).toBeVisible({ timeout: 30_000 })
  const restored = await columns.count()
  expect(restored).toBeGreaterThanOrEqual(2)
  const perColumn = Math.min(...await columns.evaluateAll((els) => els.map((el) => el.querySelectorAll('*').length)))
  expect(perColumn).toBeGreaterThan(50)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const before = await detachedNodes(page, cdp)

  // Columns restored at load (auto-animate polls those) ...
  for (let i = 0; i < restored; i++) await closeFirstColumn(page)
  // ... and columns opened later (its position observer watches those).
  const CYCLES = 4
  for (let i = 0; i < CYCLES; i++) {
    for (const s of LATER) {
      await openViaFinder(page, s.query, s.id)
      await closeFirstColumn(page)
    }
  }

  const after = await detachedNodes(page, cdp)
  const closed = restored + CYCLES * LATER.length
  console.log(`[column-dom] detached nodes ${before} -> ${after} after ${closed} closes (smallest column ${perColumn})`)
  // Before the fix every closed column stayed whole: at least closed * perColumn.
  expect(after - before, `detached nodes ${before} -> ${after}; ${closed} columns closed, the smallest had ${perColumn}`)
    .toBeLessThan(3 * perColumn)
})
