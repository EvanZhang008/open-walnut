/**
 * An SSH proxy (ProxyCommand) whose own login expired, against the SERVER's
 * host fixture: the frames are the real buildHostStatus over the real
 * classifier, reading the one-line summary the failure cache really stores.
 *
 * Reported 2026-09-27/29: this failure read as a plain `proxy` problem, so the
 * card said "check the proxy settings", the host retried every 3 seconds for
 * hours, and renewing the login did not bring it back. Pinned here: its own
 * headline and next step, the credential countdown, one row for every host
 * waiting on that login, and Retry all reconnecting once the login is renewed
 * (a click before that fails the same way and the countdown starts over).
 *
 * Run: PW_TEST_PORT=35994 npx playwright test host-proxy-login --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35994 npx playwright test host-proxy-login --project=webkit --workers=1
 */
import fs from 'node:fs'
import { test, expect } from '@playwright/test'
import {
  HEALTHY, fixtureCounters, fixtureFile, hostFixture, isolatePrefs, loadApp, loadFixture, resetServerHostFixture, tasksBanner, wireHost,
} from './host-problems-fixture-helpers'

const SHOTS = '/tmp/host-proxy-login'
/** summarizeConnectFailure's output for the proxy's real refusal (names neutralized). */
const SUMMARY = 'Error: Acme SSH Client returned an error when reaching to Acme SSH … [walnut-ssh-evidence: proxy-login (the SSH proxy says its own login is invalid or expired)]'

const FILE = fixtureFile({
  devbox: { label: 'Dev box', hostname: 'dev.example.com', phase: 'connected', claude: HEALTHY },
  proxbox: { label: 'Proxy box', hostname: 'prox.example.com', phase: 'failed', error: SUMMARY, retryInSec: 60 },
  proxbox2: { label: 'Proxy box 2', hostname: 'prox2.example.com', phase: 'failed', error: SUMMARY, retryInSec: 60 },
})

test.beforeAll(() => { fs.mkdirSync(SHOTS, { recursive: true }) })
test.beforeEach(async ({ page }) => {
  // A page that never mounts says why in the run log.
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 300)}`) })
  await isolatePrefs(page)
})
test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

test.describe('a proxy whose own login expired', () => {
  // A cold Home under load takes most of the default 30s by itself.
  test.describe.configure({ timeout: 120_000 })
  test.beforeEach(async ({ request }) => { await loadFixture(request, FILE) })

  test('its own headline and next step, the credential countdown, one row for both hosts', async ({ page, request }, info) => {
    const wire = await wireHost(request, 'proxbox')
    expect(wire.kind).toBe('proxy_login')
    expect(wire.retryable).toBe(false)
    expect(wire.hint).toMatch(/proxy says its own login expired/)
    expect(wire.hint).toMatch(/organization's login command/)
    await page.setViewportSize({ width: 1280, height: 800 })
    await loadApp(page)
    const merged = tasksBanner(page).locator('li.hpb-row[data-host="proxbox proxbox2"]')
    await expect(merged).toBeVisible({ timeout: 20_000 })
    await expect(merged.locator('.hft-headline')).toHaveText('Could not connect to Proxy box and Proxy box 2: SSH proxy login expired')
    await expect(merged.locator('.hft-hint')).toContainText("organization's login command")
    await expect(merged.locator('.hft-hint')).not.toContainText('Check the proxy settings')
    await expect(merged.locator('.hft-when')).toHaveText(/^Walnut tries again in (\d{1,2}s|1m \d+s)$/)
    await expect(merged.getByRole('button', { name: 'Retry all' })).toHaveCount(1)
    await merged.screenshot({ path: `${SHOTS}/${info.project.name}-row.png` })
  })

  test('Retry all before the login fails the same way; after it, both hosts reconnect', async ({ page, request }, info) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await loadApp(page)
    const merged = tasksBanner(page).locator('li.hpb-row[data-host="proxbox proxbox2"]')
    await expect(merged).toBeVisible({ timeout: 20_000 })
    const before = await fixtureCounters(request)

    // Still expired: one dial each, the same kind, the countdown starts over.
    await merged.getByRole('button', { name: 'Retry all' }).click()
    await expect.poll(async () => (await fixtureCounters(request)).connect.proxbox ?? 0).toBe((before.connect.proxbox ?? 0) + 1)
    await expect.poll(async () => (await fixtureCounters(request)).connect.proxbox2 ?? 0).toBe((before.connect.proxbox2 ?? 0) + 1)
    const again = await wireHost(request, 'proxbox')
    expect(again.kind).toBe('proxy_login')
    expect(again.retryAt! - Date.now()).toBeGreaterThan(50_000)
    await expect(merged.getByRole('button', { name: 'Retry all' })).toBeEnabled({ timeout: 10_000 })
    await expect(merged.locator('.hft-headline')).toHaveText('Could not connect to Proxy box and Proxy box 2: SSH proxy login expired')

    // The user ran the login command.
    await hostFixture(request, { action: 'renew-credential', host: 'proxbox' })
    await hostFixture(request, { action: 'renew-credential', host: 'proxbox2' })
    await merged.getByRole('button', { name: 'Retry all' }).click()
    await expect.poll(async () => (await wireHost(request, 'proxbox')).connected, { timeout: 10_000 }).toBe(true)
    await expect.poll(async () => (await wireHost(request, 'proxbox2')).connected, { timeout: 10_000 }).toBe(true)
    await page.mouse.move(2, 2)
    // The failure row gives way to each host's ready sentence, then goes.
    await expect(tasksBanner(page).getByText(/^(\u2713 )?Proxy box( 2)? is ready/).first()).toBeVisible({ timeout: 15_000 })
    await tasksBanner(page).screenshot({ path: `${SHOTS}/${info.project.name}-after-renew.png` }).catch(() => {})
    await expect(page.locator('.hft-headline', { hasText: 'SSH proxy login expired' })).toHaveCount(0, { timeout: 15_000 })
  })
})
