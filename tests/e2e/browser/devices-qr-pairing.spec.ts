/**
 * Settings → Phones & Cloud QR pairing.
 *
 * Regression guard for 2026-07-28 ("how do I connect my phone? the QR used to
 * be here"): the QR is only rendered AFTER minting, and it used to embed
 * `server=http://localhost:3456` — an address that resolves to the phone
 * itself. Asserts the section is reachable by real clicks and that whatever
 * address the QR carries is never loopback.
 */
import { test, expect } from '@playwright/test'
import { backToDevices, qrDialog } from './devices-ways-helpers'

test.describe('Settings → Phones & Cloud pairing', () => {
  test('All devices tab is reachable and its QR never points at loopback', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    // Real-user navigation into Settings (no page.goto to /settings).
    await page.getByRole('link', { name: /settings/i }).first().click()
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()

    // The nav entry the user remembered must exist; clicking it opens Phones &
    // Cloud. Its All devices tab holds the phones and, with no companion and no
    // Tailscale address (the fixture server), the pairing on this Wi-Fi.
    const devicesNav = page.getByTestId('settings-nav-devices')
    await expect(devicesNav).toHaveCount(1)
    await expect(devicesNav).toContainText('Phones & Cloud')
    await devicesNav.click()
    await expect(devicesNav).toHaveAttribute('aria-current', 'page')

    const section = await backToDevices(page)
    await expect(page.getByTestId('pc-tab-devices-phones')).toHaveAttribute('aria-current', 'page')
    await expect(devicesNav).toHaveAttribute('aria-current', 'page')
    const pairGroup = section.getByTestId('way-pair-all')
    await expect(pairGroup).toContainText('Pair a phone on this Wi-Fi')

    // Pair a device through the UI exactly as a user would.
    const name = `pw-iphone-${Date.now()}`
    await pairGroup.locator('#devices-new-name').fill(name) // N25: the placeholder is an example, not the label
    const pairBtn = pairGroup.getByRole('button', { name: 'Pair phone' })
    await expect(pairBtn).toBeEnabled()
    await pairBtn.click()

    // The QR block appears with a real image. Generous timeout: pairing now
    // does a server round-trip (and a cloud-target pairing mints on the cloud
    // box), and this Mac routinely sits at load >40, where fixture requests
    // that take 150ms idle take seconds.
    const qr = qrDialog(page).locator('img')
    await expect(qr).toBeVisible({ timeout: 60_000 })
    const src = await qr.getAttribute('src')
    expect(src).toMatch(/^data:image\/png;base64,/)

    // THE REGRESSION: the pairing address must never be loopback. The UI
    // echoes it under the QR, so assert on what the user is actually told.
    const hint = await qrDialog(page).innerText()
    expect(hint).not.toMatch(/localhost|127\.0\.0\.1/)

    // Dismiss, then clean up the device we created.
    await qrDialog(page).getByTestId('devices-qr-done').click()
    await expect(qrDialog(page)).toHaveCount(0)

    // Remove is two-step in place (no browser dialog): the first click asks on the
    // row, with the warning, and the named confirm removes it.
    const dialogs: string[] = []
    page.on('dialog', (d) => { dialogs.push(d.type()); void d.dismiss() })
    const row = section.locator(`.devices-row[data-device-name="${name}"]`)
    const remove = row.getByTestId('devices-remove')
    await expect(remove).toHaveText('Remove')
    await remove.click()
    await expect(row.getByRole('alert')).toContainText(`Removing ${name} signs it out of this Walnut on every way`)
    await expect(row.getByTestId('devices-remove-confirm')).toHaveText(`Remove ${name}`)
    await expect(section.locator(`.devices-row[data-device-name="${name}"]`)).toHaveCount(1)
    await row.getByTestId('devices-remove-confirm').click()
    await expect(section.locator(`.devices-row[data-device-name="${name}"]`)).toHaveCount(0)
    expect(dialogs).toEqual([])
  })
})
