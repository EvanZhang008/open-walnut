import { expect, test, type Page } from '@playwright/test'
import { openWay } from './devices-ways-helpers'

/**
 * "Open on your phone" with more than one address (BrowserAccessGroup.tsx): once the
 * tunnel is connected the ONE phone link is made by itself (nothing to press), and it
 * goes to a host server's always-on tunnel first (while this computer sleeps it still
 * opens that host's copy), else to this computer's own tunnel. No QR, no address
 * switch, no second link. Its text hides the code; the href and Copy carry the whole
 * link. The link is kept across visits to the page (no second mint). An older
 * server's one-link answer still gives that link, and an answer with no address
 * shows the code to type. A hidden provider option shows its field only when the
 * value saved for it no longer fits its pattern.
 *
 * The server half (which addresses exist) is pinned in
 * tests/web/routes/browser-code-addresses.test.ts; the shared fixture runs no
 * tunnel and no host server, so this spec answers /api/expose and the code request
 * itself.
 */

const pause = (page: Page, ms = 1500) => (process.env.PW_VIDEO ? page.waitForTimeout(ms) : Promise.resolve())

test.use({
  viewport: { width: 1280, height: 800 },
  ...(process.env.PW_VIDEO ? { video: { mode: 'on', size: { width: 1280, height: 800 } } } : {}),
})

test.setTimeout(120_000)

const MAC = 'https://mac.example.test'
const DEVBOX = 'https://devbox.example.test'

/** The tunnel is Walnut's own command provider, connected on this computer. One of its
 *  options is filled by the provider itself (`hidden`, pattern `[a-z0-9-]+`), so it asks the
 *  person nothing unless `saved` holds a value for it that does not fit. */
async function serveConnected(page: Page, saved: Record<string, string> = {}) {
  await page.route('**/api/expose', (route) => route.fulfill({
    json: {
      status: { enabled: true, provider: 'command', providerTitle: 'Custom command', state: 'connected', since: 1, url: MAC, port: 54001 },
      providers: [{
        id: 'command', title: 'Custom command', owner: 'core',
        options: [
          { key: 'name', label: 'Tunnel name', default: 'walnut' },
          { key: 'token', label: 'Token', hidden: true, pattern: '[a-z0-9-]+' },
        ],
      }],
      settings: { enabled: true, provider: 'command', options: saved },
    },
  }))
}

/** Answers the code request with `body`, counting the requests. */
async function serveCode(page: Page, body: () => Record<string, unknown>) {
  const mints = { count: 0 }
  await page.route('**/api/devices/browser-code', (route) => {
    mints.count++
    return route.fulfill({ json: body() })
  })
  return mints
}

/** What Copy put on the clipboard, read without a clipboard permission (any engine). */
async function recordClipboard(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] }
    w.__copied = []
    const clip = navigator.clipboard ?? ({} as Clipboard)
    Object.defineProperty(clip, 'writeText', { configurable: true, value: async (text: string) => { w.__copied.push(text) } })
    if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clip })
  })
}

async function openBrowserLink(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-devices').click()
  await openWay(page, 'browser')
  const group = page.getByTestId('browser-access')
  await expect(group).not.toContainText('Loading...', { timeout: 30_000 })
  await page.getByTestId('browser-access-code').scrollIntoViewIfNeeded()
  return group
}

/** Nothing of the old layout: no QR, no address switch or note, no "Can't scan it?", no Address row. */
async function expectOneLinkOnly(page: Page) {
  const row = page.getByTestId('browser-access-code')
  await expect(page.getByTestId('browser-access-link')).toHaveCount(1)
  await expect(row.locator('img')).toHaveCount(0)
  await expect(page.locator('[data-testid^="browser-access-address-"]')).toHaveCount(0)
  await expect(page.getByTestId('browser-access-qr')).toHaveCount(0)
  await expect(page.getByTestId('browser-access-manual')).toHaveCount(0)
  await expect(page.getByTestId('browser-access-make-code')).toHaveCount(0)
  await expect(page.getByTestId('browser-access-url')).toHaveCount(0)
  await expect(page.getByTestId('browser-access-copy-url')).toHaveCount(0)
}

test('the one link is made by itself, goes to the always-on host first, hides its code, is kept across visits; Copy copies it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await recordClipboard(page)
  await serveConnected(page)
  const mints = await serveCode(page, () => ({
    code: 'ABCD-EFGH', expiresAt: Date.now() + 600_000,
    url: MAC, link: `${MAC}/#pair=ABCD-EFGH`,
    addresses: [
      { where: 'this-computer', label: 'This computer', url: MAC, link: `${MAC}/#pair=ABCD-EFGH`, alwaysOn: false },
      { where: 'devbox', label: 'Dev box', url: DEVBOX, link: `${DEVBOX}/#pair=ABCD-EFGH`, alwaysOn: true },
    ],
  }))
  const group = await openBrowserLink(page)
  const row = page.getByTestId('browser-access-code')
  await expect(row).toContainText('Open on your phone')
  const link = page.getByTestId('browser-access-link')
  await expect(link).toHaveAttribute('href', `${DEVBOX}/#pair=ABCD-EFGH`)
  // The text hides the code: a screenshot or a recording of Settings signs no one in.
  await expect(link).toHaveText(`${DEVBOX}/#pair=••••-••••`)
  await expect(row).not.toContainText('ABCD')
  await expect(row).not.toContainText('EFGH')
  await expect(row).toContainText('Copy it to the phone and open it there: Walnut opens signed in, and stays signed in.')
  // The code rides in the link; it is not shown again on its own.
  await expect(page.getByTestId('browser-access-code-value')).toHaveCount(0)
  await expectOneLinkOnly(page)
  // Made once on connect, with nothing pressed.
  expect(mints.count).toBe(1)
  // An option the provider fills itself has no field.
  await expect(page.getByTestId('browser-access-option-name')).toBeVisible()
  await expect(page.getByTestId('browser-access-option-token')).toHaveCount(0)
  await pause(page)
  await group.screenshot({ path: `/tmp/browser-access-addresses/${test.info().project.name}-link-host.png` })

  await page.getByTestId('browser-access-copy-link').click()
  await expect(page.getByTestId('browser-access-copy-link')).toHaveText('Copied')
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([`${DEVBOX}/#pair=ABCD-EFGH`])
  // Clicking the link copies it too and never opens it here: opening it would sign this
  // browser in and use up the link the phone is meant to open.
  const before = page.url()
  const opened: string[] = []
  page.context().on('page', (p) => opened.push(p.url()))
  await link.click()
  await page.waitForTimeout(500)
  expect(page.url()).toBe(before)
  expect(opened).toEqual([])
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([`${DEVBOX}/#pair=ABCD-EFGH`, `${DEVBOX}/#pair=ABCD-EFGH`])

  // Another settings page and back: the same link, not a new one (a new one per visit
  // would push out the one already sent to a phone).
  await page.getByTestId('settings-nav-remote-hosts').click()
  await expect(page.getByTestId('browser-access')).toHaveCount(0, { timeout: 30_000 })
  await page.getByTestId('settings-nav-devices').click()
  await openWay(page, 'browser')
  await expect(page.getByTestId('browser-access-link')).toHaveAttribute('href', `${DEVBOX}/#pair=ABCD-EFGH`, { timeout: 30_000 })
  // Long enough for a mint the visit started to have been asked for.
  await page.waitForTimeout(1_500)
  expect(mints.count).toBe(1)
  expect(errors).toEqual([])
})

test("with no always-on host the link goes to this computer's address", async ({ page }) => {
  await serveConnected(page)
  await serveCode(page, () => ({
    code: 'MNPQ-RSTU', expiresAt: Date.now() + 600_000,
    url: MAC, link: `${MAC}/#pair=MNPQ-RSTU`,
    addresses: [{ where: 'this-computer', label: 'This computer', url: MAC, link: `${MAC}/#pair=MNPQ-RSTU`, alwaysOn: false }],
  }))
  const group = await openBrowserLink(page)
  await expect(page.getByTestId('browser-access-link')).toHaveAttribute('href', `${MAC}/#pair=MNPQ-RSTU`)
  await expect(page.getByTestId('browser-access-link')).toHaveText(`${MAC}/#pair=••••-••••`)
  await expectOneLinkOnly(page)
  await pause(page)
  await group.screenshot({ path: `/tmp/browser-access-addresses/${test.info().project.name}-link-mac.png` })
})

test('an older server that sends one link still gets that link', async ({ page }) => {
  await serveConnected(page)
  await serveCode(page, () => ({ code: 'WXYZ-2345', expiresAt: Date.now() + 600_000, url: MAC, link: `${MAC}/#pair=WXYZ-2345` }))
  await openBrowserLink(page)
  await expect(page.getByTestId('browser-access-link')).toHaveAttribute('href', `${MAC}/#pair=WXYZ-2345`)
  await expect(page.getByTestId('browser-access-link')).toHaveText(`${MAC}/#pair=••••-••••`)
  await expectOneLinkOnly(page)
  await pause(page)
})

test('with no address in the answer, the code is shown to type', async ({ page }) => {
  await serveConnected(page)
  const mints = await serveCode(page, () => ({ code: 'HJKM-NPQR', expiresAt: Date.now() + 600_000, addresses: [] }))
  await openBrowserLink(page)
  await expect(page.getByTestId('browser-access-code-value')).toHaveText('HJKM-NPQR')
  await expect(page.getByTestId('browser-access-code')).toContainText('No address reaches this computer from outside yet.')
  await expect(page.getByTestId('browser-access-link')).toHaveCount(0)
  await expect(page.getByTestId('browser-access-copy-link')).toHaveCount(0)
  // A connected tunnel whose answer had no address yet is asked again a few seconds later,
  // then less and less often (5, 15, 45 s): each new code takes one of the five live ones.
  await expect.poll(() => mints.count, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
  const second = mints.count
  await page.waitForTimeout(8_000)
  expect(mints.count).toBe(second)
  await expect(page.getByTestId('browser-access-code-value')).toHaveText('HJKM-NPQR')
})

test('a hidden option shows its field only when the value saved for it does not fit', async ({ page }) => {
  await serveConnected(page, { token: 'Not A Token!' })
  await serveCode(page, () => ({ code: 'ABCD-EFGH', expiresAt: Date.now() + 600_000, addresses: [] }))
  await openBrowserLink(page)
  const field = page.getByTestId('browser-access-option-token')
  await expect(field).toBeVisible()
  await expect(field).toHaveValue('Not A Token!')
})

test('a hidden option with a value that fits shows nothing', async ({ page }) => {
  await serveConnected(page, { token: 'abc-123' })
  await serveCode(page, () => ({ code: 'ABCD-EFGH', expiresAt: Date.now() + 600_000, addresses: [] }))
  await openBrowserLink(page)
  await expect(page.getByTestId('browser-access-option-name')).toBeVisible()
  await expect(page.getByTestId('browser-access-option-token')).toHaveCount(0)
})
