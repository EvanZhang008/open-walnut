/**
 * Settings → Devices QR pairing.
 *
 * Regression guard for 2026-07-28 ("how do I connect my phone? the QR used to
 * be here"): the QR is only rendered AFTER minting, and it used to embed
 * `server=http://localhost:3456` — an address that resolves to the phone
 * itself. Asserts the section is reachable by real clicks and that whatever
 * address the QR carries is never loopback.
 */
import { test, expect } from '@playwright/test'

test.describe('Settings → Devices pairing', () => {
  test('Devices section is reachable and its QR never points at loopback', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    // Real-user navigation into Settings (no page.goto to /settings).
    await page.getByRole('link', { name: /settings/i }).first().click()
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()

    // The nav entry the user remembered must exist, and clicking it must land
    // on a visible Devices section.
    const devicesNav = page.locator('.settings-nav-item', { hasText: /^Devices$/ })
    await expect(devicesNav).toHaveCount(1)
    await devicesNav.click()

    const section = page.locator('#devices')
    await expect(section).toBeVisible()
    await expect(section).toContainText(/Pair one by scanning a QR code/i)

    // Pair a device through the UI exactly as a user would.
    const name = `pw-iphone-${Date.now()}`
    await section.getByPlaceholder(/Device name/i).fill(name)
    const pairBtn = section.getByRole('button', { name: /Pair new device/i })
    await expect(pairBtn).toBeEnabled()
    await pairBtn.click()

    // The QR block appears with a real image. Generous timeout: pairing now
    // does a server round-trip (and a cloud-target pairing mints on the cloud
    // box), and this Mac routinely sits at load >40, where fixture requests
    // that take 150ms idle take seconds.
    const qr = section.locator('.devices-qr-block img')
    await expect(qr).toBeVisible({ timeout: 60_000 })
    const src = await qr.getAttribute('src')
    expect(src).toMatch(/^data:image\/png;base64,/)

    // THE REGRESSION: the pairing address must never be loopback. The UI
    // echoes it under the QR, so assert on what the user is actually told.
    const hint = await section.locator('.devices-qr-hint').innerText()
    expect(hint).not.toMatch(/localhost|127\.0\.0\.1/)

    // Dismiss, then clean up the device we created.
    await section.getByRole('button', { name: /^Done$/ }).click()
    await expect(section.locator('.devices-qr-block')).toHaveCount(0)

    page.once('dialog', (d) => void d.accept())
    const row = section.locator('.devices-row', { hasText: name })
    await row.getByRole('button', { name: /Revoke/i }).click()
    await expect(section.locator('.devices-row', { hasText: name })).toHaveCount(0)
  })
})
