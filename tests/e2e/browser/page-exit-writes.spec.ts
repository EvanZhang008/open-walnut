/**
 * A write sent as the page goes is not cancelled by it (2026-11-01: a reload of the Org page in
 * WebKit logged "Fetch API cannot load /api/page-visits due to access control checks", WebKit's
 * words for a request the unload cut, and the visit was lost). The visit batch waits a few
 * seconds before it goes, so a reload inside that window sends it from the page's exit edge:
 * it must reach the server, every round, with no page error.
 */
import { expect, test, type APIRequestContext } from '@playwright/test'
import { loadHome } from './draft-helpers'

async function visitCount(request: APIRequestContext, key: string): Promise<number> {
  const res = await request.get('/api/page-visits')
  expect(res.ok()).toBe(true)
  const store = (await res.json()) as { keys: Record<string, { count: number }> }
  return store.keys[key]?.count ?? 0
}
const orgCount = (request: APIRequestContext) => visitCount(request, 'page:org')

test('a visit recorded right before a reload reaches the server, round after round', async ({ page, request }) => {
  test.setTimeout(120_000)
  const problems: string[] = []
  // WebKit reports every request a reload cuts as a page error ("... due to access control
  // checks"); a read cut that way is refetched by the new page, so only the visit's own counts.
  // Chromium says ERR_ABORTED for a keepalive request the page let go, so the server's count is
  // the proof that it arrived.
  page.on('pageerror', (e) => { if (/page-visits/.test(e.message)) problems.push(`pageerror: ${e.message}`) })
  page.on('console', (m) => { if (m.type() === 'error' && /page-visits/.test(m.text())) problems.push(`console: ${m.text()}`) })
  // A test window's visits are not counted (the route answers testRun); this fixture's data is
  // throwaway, so the page runs as a plain window and its visits count.
  await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }) })
  for (let round = 1; round <= 3; round++) {
    await loadHome(page)
    const before = await orgCount(request)
    // Org records its visit now; the batch would go 4 s later, but the reload comes first.
    await page.getByTestId('sidebar-org').click()
    await expect(page.getByTestId('org-page')).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('org-page')).toBeVisible({ timeout: 30_000 })
    // The reloaded page records Org again and sends it 4 s on; the count we check is the one
    // its exit edge sent, so read before that batch can arrive.
    await expect.poll(() => orgCount(request), { timeout: 3_000 }).toBeGreaterThanOrEqual(before + 1)
    await page.waitForTimeout(4_500) // let the reloaded page's own batch go before the next round
  }
  expect(problems).toEqual([])
})

// 2026-11-06, CI: under load the visit batch its timer sent waited in the client's connection
// queue behind a full pool, the reload came first, and JS stopped before the queue drained, so the
// visit never reached the server. A write still waiting there when the page goes is sent at once.
test('a visit batch still waiting for a connection when the page reloads reaches the server', async ({ page, request }) => {
  test.setTimeout(90_000)
  await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }) })
  // Reads to this path are held open: the page's own client fills its six slots, its low lane and
  // a deep queue with them, as a busy page does (a short queue can drain in the reload's own aborts).
  await page.route('**/api/held-read/**', async (route) => {
    await new Promise((r) => setTimeout(r, 25_000))
    await route.fulfill({ json: {} }).catch(() => undefined)
  })
  await loadHome(page)
  // A key of this run alone, so no other page's visits (the test above, a reloaded page) count.
  const key = `page:exitq${Date.now().toString(36)}`
  // A string, so the import reaches the browser as written: the app's own module instances
  // (the fixture serves the SPA through Vite in dev mode).
  const inFlight = await page.evaluate(`(async () => {
    const client = await import('/src/api/client.ts')
    for (let i = 0; i < 2; i++) client.apiGet('/api/held-read/low' + i, undefined, { priority: 'low' }).catch(() => undefined)
    for (let i = 0; i < 40; i++) client.apiGet('/api/held-read/' + i).catch(() => undefined)
    const visits = await import('/src/api/page-visits.ts')
    visits.recordVisit(${JSON.stringify(key)})
    return client.getFetchQueueStats().inFlight
  })()`) as number
  expect(inFlight).toBeGreaterThanOrEqual(6)
  // The batch's timer fired and the batch waits in the low lane behind the held reads: proven,
  // so the reload below tests the queued write and not the exit edge's own flush. The held
  // routes take no real browser connection; this pins the client's own queue.
  await expect.poll(() => page.evaluate(`import('/src/api/client.ts').then((c) => c.queuedFetchLabels())`), { timeout: 15_000 }).toContain('POST /api/page-visits')
  expect(await visitCount(request, key)).toBe(0)
  await page.reload()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => visitCount(request, key), { timeout: 10_000 }).toBe(1)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})
