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
 * 2026-11-09: the last column closed stayed alive whole, held by the last press
 * on its Close button: utils/selection-echo.ts kept the last mousedown event and
 * utils/find-scope.ts the last pointerdown target, each until the next press. Any
 * holder of that kind keeps one removed subtree at a time, so this counts the
 * nodes of each closed column that are still alive, by weak references taken just
 * before its close, rather than the page's detached node total: that total also
 * moves with whatever else the page renders (another spec's tasks and sessions on
 * the shared fixture server read as thousands of nodes in CI), and the old bound,
 * three times the smallest column, sat right at what one held column costs.
 *
 * The page keeps its own panel count and layout prefs: both live on the shared
 * fixture server, and another spec changing them took columns off this strip.
 *
 * Measured in WebKit (the Mac app) the same switching showed no detached DOM,
 * so the check runs in Chromium, where a forced GC makes it measurable.
 */
import { test, expect, type Page, type CDPSession, type Locator } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { patchClientConfig } from './draft-helpers'

/** Seeded, stopped sessions from test-server.ts, restored as columns at load. */
const SIDS = ['pw-normal-session', 'pw-vscode-session', 'pw-plan-session-completed']
/** Two more, opened later through the finder by their titles. */
const LATER = [
  { id: 'pw-service-session', query: 'Service preview' },
  { id: 'pw-idref-session', query: 'Task id refs' },
]

async function openColumnsOnHome(page: Page) {
  await isolateUiPrefs(page)
  // Every restored session gets a column (fewer panels would minimize one to the taskbar).
  await patchClientConfig(page, { sessionPanels: String(SIDS.length) })
  await page.addInitScript((ids) => {
    (window as unknown as { __closedColumns: unknown[] }).__closedColumns = []
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

async function collectGarbage(page: Page, cdp: CDPSession) {
  for (let i = 0; i < 3; i++) {
    await cdp.send('HeapProfiler.collectGarbage')
    await page.waitForTimeout(200)
  }
}

/** Nodes alive in the renderer minus nodes in the document, after a full GC (logged for context). */
async function detachedNodes(page: Page, cdp: CDPSession): Promise<number> {
  await collectGarbage(page, cdp)
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

/** Weak references to the column and every node in it, taken before it closes, once its
 *  chat stopped growing (a column still loading would be counted short). Returns its size. */
async function trackColumn(column: Locator): Promise<number> {
  let last = -1
  await expect.poll(async () => {
    const n = await column.evaluate((el) => el.querySelectorAll('*').length)
    const settled = n === last
    last = n
    return settled
  }, { intervals: [250], timeout: 15_000 }).toBe(true)
  return column.evaluate((el) => {
    const refs = [el, ...Array.from(el.querySelectorAll('*'))].map((n) => new WeakRef(n))
    ;(window as unknown as { __closedColumns: unknown[] }).__closedColumns.push({ id: el.getAttribute('data-column-id'), refs })
    return refs.length
  })
}

/** Per closed column: its size and how many of its nodes are still alive outside the document, after a full GC. */
async function keptNodes(page: Page, cdp: CDPSession): Promise<Array<{ id: string; size: number; kept: number }>> {
  await collectGarbage(page, cdp)
  return page.evaluate(() => (window as unknown as { __closedColumns: Array<{ id: string; refs: WeakRef<Node>[] }> })
    .__closedColumns.map((c) => ({
      id: c.id,
      size: c.refs.length,
      kept: c.refs.filter((r) => { const n = r.deref(); return !!n && !n.isConnected }).length,
    })))
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
  await trackColumn(columns.first())
  await columns.first().getByRole('button', { name: 'Close session panel' }).click()
  await expect(columns).toHaveCount(n - 1)
  // Past the 320 ms exit animation, auto-animate's position debounce and one
  // tick of its 2 s position poll, which is what lets a removed child go.
  await page.waitForTimeout(2600)
}

test('closing session columns releases their DOM', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'needs a forced GC (CDP)')
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1800, height: 1000 })
  await openColumnsOnHome(page)
  const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
  await expect(columns).toHaveCount(SIDS.length, { timeout: 30_000 })
  for (let i = 0; i < SIDS.length; i++) await expect(columns.nth(i).locator('.session-history')).toBeVisible({ timeout: 30_000 })

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const before = await detachedNodes(page, cdp)

  // Columns restored at load (auto-animate polls those) ...
  for (let i = 0; i < SIDS.length; i++) await closeFirstColumn(page)
  // ... and columns opened later (its position observer watches those).
  const CYCLES = 4
  for (let i = 0; i < CYCLES; i++) {
    for (const s of LATER) {
      await openViaFinder(page, s.query, s.id)
      await closeFirstColumn(page)
    }
  }

  const report = await keptNodes(page, cdp)
  const after = await detachedNodes(page, cdp)
  expect(report).toHaveLength(SIDS.length + CYCLES * LATER.length)
  const smallest = Math.min(...report.map((c) => c.size))
  expect(smallest).toBeGreaterThan(50)
  const kept = report.reduce((sum, c) => sum + c.kept, 0)
  const lines = report.map((c) => `${c.id} ${c.kept}/${c.size}`).join(', ')
  console.log(`[column-dom] ${report.length} closes, closed-column nodes still alive: ${kept} (${lines}); page detached nodes ${before} -> ${after}`)
  // Before the auto-animate fix every closed column stayed whole; with the last
  // press held, the last one did. Together they now keep less than the smallest
  // of them had: not one column's worth survives.
  expect(kept, `closed-column nodes still alive: ${lines}`).toBeLessThan(smallest)
})
