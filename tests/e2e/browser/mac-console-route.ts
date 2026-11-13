import type { Page } from '@playwright/test'

/**
 * Answer /api/config as a Mac console's (`macAccess` true). Settings lists macOS Access only where
 * the server has macOS permissions to show (web/src/components/settings/settings-pane-gates.ts),
 * so on a Linux runner its nav entry is not drawn and a spec that clicks it waits out its timeout
 * (2026-11-01 and 2026-11-13, CI). For a spec whose /api/permissions report is a Mac's.
 */
export async function routeMacConsole(page: Page): Promise<void> {
  await page.route((url) => url.pathname === '/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { ...body, macAccess: true } })
  })
}
