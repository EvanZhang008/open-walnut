/**
 * A write sent as the page goes is not cancelled by it (2026-11-01: a reload of the Org page in
 * WebKit logged "Fetch API cannot load /api/page-visits due to access control checks", WebKit's
 * words for a request the unload cut, and the visit was lost). The visit batch waits a few
 * seconds before it goes, so a reload inside that window sends it from the page's exit edge:
 * it must reach the server, every round, with no page error.
 */
import { expect, test, type APIRequestContext } from '@playwright/test'
import { loadHome } from './draft-helpers'

async function orgCount(request: APIRequestContext): Promise<number> {
  const res = await request.get('/api/page-visits')
  expect(res.ok()).toBe(true)
  const store = (await res.json()) as { keys: Record<string, { count: number }> }
  return store.keys['page:org']?.count ?? 0
}

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
