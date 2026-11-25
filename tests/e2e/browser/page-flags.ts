/**
 * Experimental flags pinned on one page, never set on the shared test server.
 *
 * The flags are the server's own config, and specs in other workers set and put back their own
 * meanwhile: a spec that turned ack_means_known on for its whole run made thread-groups-folds'
 * Closed card land in Acknowledged (2026-11-25), and one putting the groups back took them off
 * another's rail. A flag that only chooses what the page draws is pinned on the page's config reads
 * instead; only a flag the server itself acts on is set there.
 */
import type { Page } from '@playwright/test'

export async function pinPageFlags(page: Page, flags: readonly string[]): Promise<void> {
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const body = await res.json() as { config?: { experimental?: Record<string, boolean> } }
    body.config = { ...body.config, experimental: { ...body.config?.experimental, ...Object.fromEntries(flags.map((f) => [f, true])) } }
    await route.fulfill({ response: res, json: body })
  })
}
