/**
 * The Org page's own settings (web/src/components/org/OrgSettingsMenu.tsx): the gear beside
 * "Org chart" opens a panel with the org's switches, the same values Settings → Org shows.
 *   - turning it off in the panel marks the gear "Off" and Settings → Org reads off;
 *   - turning it on in Settings → Org shows on in the panel again;
 *   - Escape closes the panel and "All Org settings" opens Settings → Org;
 *   - on a phone the gear and its panel fit the screen.
 * The fixture is shared with other specs, so the switch itself is held in this page: its
 * settings route answers from a value kept here, never the fixture's config (an org turned off
 * for every spec would stop their VPs). The server side of the switch is pinned by
 * tests/e2e/org-autostart.test.ts.
 */
import { expect, test, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

test.setTimeout(120_000)
// A settings read still in flight when a test ends is dropped, never an error.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

async function holdOrgSwitch(page: Page): Promise<{ writes: boolean[] }> {
  const state = { enabled: true, writes: [] as boolean[] }
  await page.route('**/api/v1/org/settings', async (route) => {
    const req = route.request()
    const res = await route.fetch({ method: 'GET' })
    const base = await res.json() as Record<string, unknown>
    if (req.method() === 'PUT') {
      const body = req.postDataJSON() as { enabled?: boolean }
      if (typeof body.enabled === 'boolean') { state.enabled = body.enabled; state.writes.push(body.enabled) }
    }
    await route.fulfill({ json: { ...base, enabled: state.enabled } })
  })
  return state
}

test('the Org page opens the org switch in place, and Settings → Org shows the same value', async ({ page }) => {
  await isolateUiPrefs(page)
  const held = await holdOrgSwitch(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()

  const gear = page.getByTestId('org-settings')
  await gear.click()
  const panel = page.getByTestId('org-settings-menu')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('org-settings-stops')).toContainText('Turning it off stops')
  // Inside the window.
  const box = (await panel.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height)

  // Off from the Org page.
  const toggle = panel.locator('#org-settings-enabled')
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(panel.getByTestId('org-settings-stops')).toContainText('Off now')
  await expect(gear).toContainText('Off')
  await expect.poll(() => held.writes).toEqual([false])

  // Escape closes it; the gear keeps saying Off.
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(gear).toContainText('Off')

  // "All Org settings" opens Settings → Org, which reads off too.
  await gear.click()
  await page.getByTestId('org-settings-all').click()
  await expect(page).toHaveURL(/\/settings/)
  const row = page.getByTestId('org-enabled-row')
  await expect(row).toBeVisible()
  await expect(page.locator('#org-enabled')).not.toBeChecked()

  // On again in Settings; the Org page's panel shows it on.
  await page.locator('#org-enabled').click()
  await expect(page.locator('#org-enabled')).toBeChecked()
  await expect.poll(() => held.writes).toEqual([false, true])
  await page.getByTestId('sidebar-org').click()
  await expect(gear).not.toContainText('Off')
  await gear.click()
  await expect(page.getByTestId('org-settings-menu').locator('#org-settings-enabled')).toBeChecked()
  // "Refuse their 4th command" is there too, off by default, as in Settings → Org.
  await expect(page.getByTestId('org-settings-menu').locator('#org-settings-block-own')).not.toBeChecked()
})

test('on a phone the gear and its panel fit the screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 })
  await isolateUiPrefs(page)
  await holdOrgSwitch(page)
  await loadHome(page)
  // The phone's sidebar is a drawer behind the top bar's Menu.
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByTestId('sidebar-org').click()
  await expect(page).toHaveURL(/\/org/)
  const gear = page.getByTestId('org-settings')
  await expect(gear).toBeVisible()
  const title = (await page.getByTestId('org-name').boundingBox())!
  expect(title.width).toBeGreaterThan(30)
  await gear.click()
  const box = (await page.getByTestId('org-settings-menu').boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(375)
  expect(box.y + box.height).toBeLessThanOrEqual(700)
})
