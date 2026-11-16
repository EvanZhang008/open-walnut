/**
 * An SSH proxy (ProxyCommand) whose own login expired, against the SERVER's
 * host fixture: the frames are the real buildHostStatus over the real
 * classifier, reading the one-line summary the failure cache really stores.
 *
 * Reported 2026-09-27/29: this failure read as a plain `proxy` problem, so the
 * host's row said "check the proxy settings", the host retried every 3 seconds for
 * hours, and renewing the login did not bring it back. Pinned here, on the
 * notification panel's problem rows: its own headline and next step, the
 * credential countdown, a row for each host waiting on that login, and Retry
 * reconnecting once the login is renewed (a click before that fails the same
 * way and the countdown starts over).
 *
 * Run: walnut-dev run bun x playwright test tests/e2e/browser/host-proxy-login.spec.ts --project chromium-host-fixture --retries=0
 */
import fs from 'node:fs'
import { test, expect } from '@playwright/test'
import {
  HEALTHY, fixtureCounters, fixtureFile, hostFixture, isolatePrefs, loadApp, loadFixture, resetServerHostFixture, wireHost,
} from './host-problems-fixture-helpers'
import { openProblems, problemHosts, problemRow, problemRowHosts } from './host-attention-helpers'

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

  const HOSTS = [['proxbox', 'Proxy box'], ['proxbox2', 'Proxy box 2']] as const

  test('its own headline and next step, the credential countdown, a row for each host', async ({ page, request }, info) => {
    const wire = await wireHost(request, 'proxbox')
    expect(wire.kind).toBe('proxy_login')
    expect(wire.retryable).toBe(false)
    expect(wire.hint).toMatch(/proxy says its own login expired/)
    expect(wire.hint).toMatch(/organization's login command/)
    await page.setViewportSize({ width: 1280, height: 800 })
    await loadApp(page)
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(['proxbox', 'proxbox2'])
    for (const [host, label] of HOSTS) {
      const r = problemRow(page, host)
      await expect(r.locator('.hft-headline')).toHaveText(`Could not connect to ${label}: SSH proxy login expired`)
      await expect(r.locator('.hft-when')).toHaveText(/^Walnut tries again in (\d{1,2}s|1m \d+s)$/)
      await expect(r.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(1)
      // The hint is one Show details away (a dense row starts closed).
      await r.getByRole('button', { name: 'Show details' }).click()
      await expect(r.locator('.hft-hint')).toContainText("organization's login command")
      await expect(r.locator('.hft-hint')).not.toContainText('Check the proxy settings')
    }
    await problemHosts(page).screenshot({ path: `${SHOTS}/${info.project.name}-rows.png` })
  })

  test('Retry before the login fails the same way; after it, both hosts reconnect', async ({ page, request }, info) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await loadApp(page)
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(['proxbox', 'proxbox2'])
    const before = await fixtureCounters(request)

    // Still expired: one dial each, the same kind, the countdown starts over.
    for (const [host] of HOSTS) await problemRow(page, host).getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(async () => (await fixtureCounters(request)).connect.proxbox ?? 0).toBe((before.connect.proxbox ?? 0) + 1)
    await expect.poll(async () => (await fixtureCounters(request)).connect.proxbox2 ?? 0).toBe((before.connect.proxbox2 ?? 0) + 1)
    const again = await wireHost(request, 'proxbox')
    expect(again.kind).toBe('proxy_login')
    expect(again.retryAt! - Date.now()).toBeGreaterThan(50_000)
    for (const [host, label] of HOSTS) {
      const r = problemRow(page, host)
      await expect(r.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled({ timeout: 10_000 })
      await expect(r.locator('.hft-headline')).toHaveText(`Could not connect to ${label}: SSH proxy login expired`)
    }

    // The user ran the login command.
    await hostFixture(request, { action: 'renew-credential', host: 'proxbox' })
    await hostFixture(request, { action: 'renew-credential', host: 'proxbox2' })
    for (const [host] of HOSTS) await problemRow(page, host).getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(async () => (await wireHost(request, 'proxbox')).connected, { timeout: 10_000 }).toBe(true)
    await expect.poll(async () => (await wireHost(request, 'proxbox2')).connected, { timeout: 10_000 }).toBe(true)
    // Both rows leave the list, and the expired-login headline is gone from the page.
    await expect(problemRow(page, 'proxbox')).toHaveCount(0, { timeout: 15_000 })
    await expect(problemRow(page, 'proxbox2')).toHaveCount(0, { timeout: 15_000 })
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-after-renew.png` }).catch(() => {})
    await expect(page.locator('.hft-headline', { hasText: 'SSH proxy login expired' })).toHaveCount(0, { timeout: 15_000 })
  })
})
