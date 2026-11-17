/**
 * A plugin's App under the notice stack (corner-stack-room.spec.ts walks Walnut's own pages; the
 * shared fixture installs no plugin). An App's route fills the content area and its box
 * (.plugin-native-app) is the page's scroller, so it asks for the stack's room after the App's own
 * content like every other scroller beside the rail: what the stack covers scrolls out from under
 * it, and nothing in the App moves when a notice comes or goes.
 *
 * Its own server with the Quick Note fixture plugin linked (plugin-mic-server.ts, an App with a
 * row on the rail).
 */
import { expect, test } from '@playwright/test'
import { usePluginFixture } from './plugin-fixture'
import { returningVisitorStorage } from './pw-storage'
import { closeToast, hideScrollbars, markLayout, movedSince, raiseToast, routeSocket, unreachableUnderStack as unreachable } from './corner-stack-room'

const fixture = usePluginFixture('mic')
test.use({
  baseURL: async ({}, use) => { await use(fixture.base()) },
  storageState: async ({}, use) => { await use(returningVisitorStorage(fixture.base())) },
})
test.describe.configure({ mode: 'default', timeout: 120_000 })

const APP_PATH = '/apps/plugin-mic-fixture~main'

for (const height of [800, 560]) {
  test(`a plugin's App keeps what the stack covers reachable and still (1280x${height})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height })
    await page.route('**/api/quiet*', (r) => r.fulfill({ json: { quiet: false } }))
    await hideScrollbars(page)
    const sock = await routeSocket(page)
    await page.goto('/')
    await expect(page.locator('.todo-panel').first()).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => sock() !== null, { timeout: 30_000 }).toBe(true)
    // Its row on the rail, as a person opens it.
    const entry = page.locator(`.app-shell > .sidebar a[href="${APP_PATH}"]`).first()
    await expect(entry).toBeAttached({ timeout: 60_000 })
    await entry.click()
    await expect(page.getByTestId('mic-fixture-app')).toBeVisible({ timeout: 30_000 })

    await markLayout(page)
    const toast = await raiseToast(page, sock, `plugin ${height}`)
    let under = await unreachable(page)
    await expect.poll(async () => (under = await unreachable(page)).checked.some((n) => n.startsWith('div.plugin-native-app'))).toBe(true)
    expect(under.bad).toEqual([])
    expect(await movedSince(page), 'nothing in the App moves when a notice comes').toEqual([])
    await closeToast(page, toast)
    expect(await movedSince(page), 'nor when it goes').toEqual([])
  })
}
