import { expect, test, type Page } from '@playwright/test'

/**
 * "Sign in a browser" with more than one address (BrowserAccessGroup.tsx): the
 * code's QR opens a host server's always-on tunnel first (it keeps working while
 * this computer sleeps), the person can switch to this computer's own tunnel,
 * and the link and QR follow the choice. An older server's one-link answer still
 * renders one QR.
 *
 * The server half (which addresses exist) is pinned in
 * tests/web/routes/browser-code-addresses.test.ts; the shared fixture runs no
 * host server, so this spec answers the code request itself.
 */

const pause = (page: Page, ms = 1500) => (process.env.PW_VIDEO ? page.waitForTimeout(ms) : Promise.resolve())

test.use({
  viewport: { width: 1280, height: 800 },
  ...(process.env.PW_VIDEO ? { video: { mode: 'on', size: { width: 1280, height: 800 } } } : {}),
})

async function openDevices(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-devices').click()
  const group = page.getByTestId('browser-access')
  await expect(group).not.toContainText('Loading...', { timeout: 30_000 })
  await page.getByTestId('browser-access-make-code').scrollIntoViewIfNeeded()
  return group
}

test.setTimeout(120_000)

test('the QR opens the host server first, and follows a switch to this computer', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('**/api/devices/browser-code', (route) => route.fulfill({
    json: {
      code: 'ABCD-EFGH', expiresAt: Date.now() + 600_000,
      url: 'https://mac.example.test', link: 'https://mac.example.test/#pair=ABCD-EFGH',
      addresses: [
        { where: 'this-computer', label: 'This computer', url: 'https://mac.example.test', link: 'https://mac.example.test/#pair=ABCD-EFGH', alwaysOn: false },
        { where: 'devbox', label: 'Dev box', url: 'https://devbox.example.test', link: 'https://devbox.example.test/#pair=ABCD-EFGH', alwaysOn: true },
      ],
    },
  }))
  const group = await openDevices(page)
  await pause(page)
  await page.getByTestId('browser-access-make-code').click()
  await expect(page.getByTestId('browser-access-code-value')).toHaveText('ABCD-EFGH')
  await expect(page.getByTestId('browser-access-link')).toHaveText('devbox.example.test/#pair=ABCD-EFGH')
  await expect(page.getByTestId('browser-access-address-note')).toContainText('connects through Dev box: it reaches this computer from there, and keeps working while this computer sleeps')
  await expect(page.getByTestId('browser-access-address-devbox')).toHaveText('Dev box (always on)')
  // The QR is the way in; the link and the typed code wait under "Can't scan it?".
  await expect(page.getByTestId('browser-access-code-value')).toBeHidden()
  await expect(page.getByTestId('browser-access-qr')).toBeVisible()
  await page.getByTestId('browser-access-code').scrollIntoViewIfNeeded()
  const hostQr = await page.getByTestId('browser-access-qr').getAttribute('src')
  await pause(page)
  await group.screenshot({ path: `/tmp/plugin-install-link/${test.info().project.name}-qr-host.png` })

  await page.getByTestId('browser-access-address-this-computer').click()
  await expect(page.getByTestId('browser-access-link')).toHaveText('mac.example.test/#pair=ABCD-EFGH')
  await expect(page.getByTestId('browser-access-address-note')).toContainText("this computer's own tunnel")
  await page.getByTestId('browser-access-manual').locator('summary').click()
  await expect(page.getByTestId('browser-access-code-value')).toBeVisible()
  await page.getByTestId('browser-access-code').scrollIntoViewIfNeeded()
  await expect(page.getByTestId('browser-access-manual')).toContainText('open mac.example.test and type ABCD-EFGH')
  expect(await page.getByTestId('browser-access-qr').getAttribute('src')).not.toBe(hostQr)
  await pause(page)
  await group.screenshot({ path: `/tmp/plugin-install-link/${test.info().project.name}-qr-mac.png` })
  expect(errors).toEqual([])
})

test('an older server that sends one link still gets one QR, with no switch', async ({ page }) => {
  await page.route('**/api/devices/browser-code', (route) => route.fulfill({
    json: { code: 'WXYZ-2345', expiresAt: Date.now() + 600_000, url: 'https://mac.example.test', link: 'https://mac.example.test/#pair=WXYZ-2345' },
  }))
  await openDevices(page)
  await page.getByTestId('browser-access-make-code').click()
  await expect(page.getByTestId('browser-access-link')).toHaveText('mac.example.test/#pair=WXYZ-2345')
  await expect(page.getByTestId('browser-access-qr')).toBeVisible()
  await expect(page.getByTestId('browser-access-address-this-computer')).toHaveCount(0)
  await pause(page)
})
