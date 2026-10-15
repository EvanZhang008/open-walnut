/**
 * Spec D5 (C87): a browser with no token whose sign-in probe gets no answer
 * (GET /api/v1/me aborted, as on a slow cell network or while the Mac sleeps)
 * gets the sign-in page with a line that says so and a 44 px Try again, never a
 * half drawn console. The next answer decides: a refusal with the primary's
 * code is the plain sign-in page; a 200 boots the console, also without a tap.
 * iPhone 15 in the project's engine.
 */
import { devices, expect, test, type Page } from '@playwright/test'

const PHONE = devices['iPhone 15']
const NETWORK = 'Walnut did not answer. Check the connection, then try again.'

test.setTimeout(120_000)

function pageOptions() {
  const { defaultBrowserType: _engine, ...iphone } = PHONE
  return { ...iphone, baseURL: test.info().project.use.baseURL }
}

type Probe = 'abort' | 'refuse' | 'pass'

/** The token-less probe answered as the test says; every other request goes through. */
async function probeAs(page: Page, state: { mode: Probe }): Promise<void> {
  await page.route((url) => url.pathname === '/api/v1/me', (route) => {
    if (route.request().headers()['authorization']) return route.continue()
    if (state.mode === 'abort') return route.abort('failed')
    if (state.mode === 'refuse') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'not paired', code: 'not_paired' }) })
    return route.continue()
  })
}

test('D5: no answer to the probe is the sign-in page with Try again, no console; the next refusal is the plain page', async ({ browser }) => {
  const ctx = await browser.newContext(pageOptions())
  const page = await ctx.newPage()
  const state = { mode: 'abort' as Probe }
  await probeAs(page, state)
  await page.goto('/')
  await expect(page.getByTestId('unpaired-notice')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('unpaired-probe-error')).toHaveText(NETWORK)
  const retry = page.getByTestId('unpaired-probe-retry')
  const box = (await retry.boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(44)
  expect(await page.locator('.app-shell').count()).toBe(0)
  await page.screenshot({ path: `/tmp/mobile-web/sign-in-probe-${page.context().browser()?.browserType().name()}.png` })
  state.mode = 'refuse'
  await retry.tap()
  await expect(page.getByTestId('unpaired-probe-error')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByTestId('unpaired-notice')).toBeVisible()
  expect(await page.locator('.app-shell').count()).toBe(0)
  await ctx.close()
})

test('D5: the page probes again by itself, and the first 200 boots the console once', async ({ browser }) => {
  const ctx = await browser.newContext(pageOptions())
  const page = await ctx.newPage()
  const state = { mode: 'abort' as Probe }
  await probeAs(page, state)
  await page.goto('/')
  await expect(page.getByTestId('unpaired-probe-error')).toHaveText(NETWORK, { timeout: 60_000 })
  state.mode = 'pass'
  await expect(page.locator('.app-shell')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.getByTestId('unpaired-notice')).toHaveCount(0)
  await page.waitForTimeout(5_000)
  expect(await page.locator('.app-shell').count()).toBe(1)
  await ctx.close()
})
