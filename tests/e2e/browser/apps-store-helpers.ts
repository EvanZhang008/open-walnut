/**
 * The Apps page is a store: one card per plugin, and a detail page per card that holds
 * the switch, the settings, the parts, where the code comes from and Update. These open a
 * plugin's (or a built-in app's) detail page the way a person does, by clicking its card.
 */
import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Open the Apps page the way a person does: its own row in the side bar. Settings holds no
 * row for it (2026-11-05, the user: "app is not in seting, app it just app").
 */
export async function openApps(page: Page, timeout = 30_000): Promise<void> {
  await page.getByTestId('sidebar-core-app-apps').click()
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout })
  await expect(page.locator('#plugin-store')).toBeVisible({ timeout })
}

/** Click a plugin's card on the Apps page (already open) and wait for its detail page. */
export async function openPluginDetail(page: Page, pluginId: string): Promise<void> {
  // A plugin a built-in app's card holds (Calendar, Mail) is opened from that card.
  const open = page.getByTestId(`plugin-card-${pluginId}-details`)
    .or(page.locator(`[data-plugin="${pluginId}"] > .apps-card-top .apps-card-main`))
  await expect(open).toBeVisible({ timeout: 60_000 })
  await open.scrollIntoViewIfNeeded()
  await open.click()
  await expect(page.getByTestId('plugin-detail')).toHaveAttribute('data-plugin-id', pluginId, { timeout: 30_000 })
  await expect(page.getByTestId(`plugin-row-${pluginId}`)).toBeVisible()
}

/** Open a part's page (`slack-mcp` of Slack) from its parent's detail page. */
export async function openPartDetail(page: Page, partId: string): Promise<void> {
  await page.getByTestId(`plugin-part-open-${partId}`).click()
  await expect(page.getByTestId('plugin-detail')).toHaveAttribute('data-plugin-id', partId, { timeout: 30_000 })
}

/** Click a built-in app's card and wait for its detail page. */
export async function openBuiltinDetail(page: Page, id: string): Promise<void> {
  await page.getByTestId(`apps-builtin-${id}-details`).click()
  await expect(page.getByTestId('builtin-detail')).toHaveAttribute('data-builtin-id', id, { timeout: 30_000 })
}

/** Back to the card grid from a detail page. */
export async function backToApps(page: Page): Promise<void> {
  await page.getByTestId('plugin-detail-back').click()
  await expect(page.getByTestId('plugin-detail')).toHaveCount(0)
  await expect(page.getByTestId('builtin-detail')).toHaveCount(0)
  await expect(page.getByTestId('apps-plugins')).toBeVisible()
}

/**
 * Open an App the way a person does (`trigger`: its card's Open, a tile, a rail row) and wait
 * until the shell has drawn it, which is when it counts as opened (useTrackOpenedApp,
 * web/src/apps/hooks.ts). Never only until the URL moves: the router moves the URL at once and
 * draws the route in a transition, and a click away before that transition lands merges with
 * it, so the App is never drawn and never recorded (2026-11-17: apps-page.spec.ts clicked Home
 * about 200 ms after the URL moved, and on a busy host the App's Open row was missing in 2 runs
 * of 4). tests/web/browser-spec-app-drawn-guard.test.ts fails on a spec that leaves right after a
 * URL wait. Returns the App's path (`/apps/<id>`).
 */
export async function openApp(page: Page, trigger: Locator): Promise<string> {
  await trigger.click()
  await expect(page).toHaveURL(/\/apps\/[^/?#]+/)
  const appPath = /^\/apps\/[^/?#]+/.exec(new URL(page.url()).pathname)![0]
  await expect(page.locator(`main[data-app-path="${appPath}"]`)).toHaveCount(1)
  return appPath
}
