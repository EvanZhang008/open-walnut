import type { Page } from '@playwright/test'

/**
 * End a test's fakes without letting the page write past them.
 *
 * A spec that answers the page's writes itself (a fake `/api/config`, a stubbed save) and drops
 * those routes in `afterEach` leaves the page open for a moment with nothing in front of the
 * server. Whatever it still sends then lands on the fixture every spec of the shard shares: a
 * Settings save reads the config before it writes (useSettingsConfig's queue), so a switch
 * clicked as a test ends sends its PUT after the routes are gone. On 2026-11-04 a fake-backed
 * test's last click turned the fixture's permission prompts off this way, and C77, later on the
 * same server, found the switch it needs disabled.
 *
 * So the fakes go, reads reach the server as before, and every write the page still makes is
 * answered here and stored nowhere. Requests made through `page.request` (a spec's own cleanup)
 * are not routed and still reach the server. The page closes right after, with the test.
 */
export async function dropFakes(page: Page, opts: { wait?: boolean } = {}): Promise<void> {
  await page.unrouteAll({ behavior: opts.wait ? 'wait' : 'ignoreErrors' }).catch(() => {})
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const method = route.request().method()
    try {
      if (method === 'GET' || method === 'HEAD') await route.fallback()
      else await route.fulfill({ json: { ok: true } })
    } catch {
      // The page closed with the request in flight.
    }
  }).catch(() => {})
}
