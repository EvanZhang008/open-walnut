/**
 * Settings › Remote Hosts against the SERVER's host fixture, plus the checks
 * that one failure reads the same on every surface:
 *
 *   one sentence   Key box (auth) renders the same HostFailureText in the
 *                  banner row, the picker note and the Settings row, with
 *                  Show SSH output, Retry and a quieter Open Settings (C7, C8, C27)
 *   the row        label title, alias, row id; Open Settings flashes it every
 *                  time (C68); a hint that wraps, outside .rh-status (C78)
 *   reconnecting   the last cause and an enabled Connect now (C9)
 *   off            an ephemeral fixture: every row is off, nothing to press (C24)
 *   autofix        Update holds 'Updating Claude Code on Fix box...' until the
 *                  re-check answers (C29); a slow one shows its time and, after
 *                  3 minutes, Still updating + Check again (C95)
 *   elsewhere      the System pane's host row, an outdated Build box included (C71);
 *                  the rail dot when no banner is on screen (C67), lit by the
 *                  banner's own rows (a signed-out host, not a version floor)
 *
 * Run with --workers=1 (the banner specs route the same aliases client-side,
 * and every describe loads its own server fixture).
 * page.goto only loads the app; everything else is a real click or key.
 *
 * Run: PW_TEST_PORT=35993 npx playwright test host-problems-settings --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35993 npx playwright test host-problems-settings --project=webkit --workers=1
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { firstSentence } from '../../../src/core/hosts/host-problem'
import {
  HEALTHY, bannerRow, bell, fixtureCounters, fixtureFile, hostFixture, hostRow, hostTab, isolatePrefs, loadApp, loadFixture,
  openPicker, openRemoteHosts, picker, resetServerHostFixture, wireHost,
} from './host-problems-fixture-helpers'
import { bareLayout } from './host-problems-helpers'
import { openRow } from './banner-placement-helpers'

const SHOTS = '/tmp/walnut-host-problems-slice/fix2'

test.beforeEach(async ({ page }) => { await isolatePrefs(page) })
test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

/** The HostFailureText inside `scope`: its two sentences, and its SSH output once opened. */
async function readFailure(scope: Locator, error: string): Promise<{ headline: string; hint: string }> {
  const hft = scope.locator('.hft').first()
  const headline = (await hft.locator('.hft-headline').innerText()).trim()
  const hint = (await hft.locator('.hft-hint').innerText()).trim()
  const toggle = hft.getByRole('button', { name: 'Show SSH output' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(hft.getByRole('button', { name: 'Hide SSH output' })).toHaveAttribute('aria-expanded', 'true')
  await expect(hft.locator('pre.hft-summary')).toHaveText(error.trim())
  // No real schedule for an auth failure, so no countdown anywhere.
  await expect(hft.locator('.hft-when')).toHaveCount(0)
  expect(await scope.innerText()).not.toMatch(/tries again in|retries by itself/)
  return { headline, hint }
}

/** Button labels inside `scope`, in DOM order. */
const buttonOrder = (scope: Locator): Promise<string[]> =>
  scope.locator('button').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()).filter(Boolean))

test.describe('one failure, one sentence: Key box on every surface', () => {
  test.beforeAll(async ({ request }) => { await loadFixture(request, 'host-problems') })

  test('banner row, picker note and Settings row render the same HostFailureText, SSH output and Retry (C7, C8, C27)', async ({ page, request }) => {
    const wire = await wireHost(request, 'keybox')
    expect(wire.kind).toBe('auth')
    expect(wire.retryable).toBe(false)
    expect(wire.retryAt).toBeUndefined()
    await loadApp(page)

    // 1. The banner row (the first row: connect failures lead, in Settings order).
    const row = bannerRow(page, 'keybox')
    await expect(row).toBeVisible({ timeout: 20_000 })
    // Several rows start closed (dense); opened, the row reads the same words as the picker and Settings.
    await openRow(row)
    const inBanner = await readFailure(row, wire.error!)
    const bannerButtons = await buttonOrder(row.locator('.hpb-actions'))
    expect(bannerButtons).toEqual(['Retry', 'Open Settings'])

    // 2. The picker note for the Key box tab.
    await openPicker(page)
    await hostTab(page, 'keybox').click()
    const note = picker(page).locator('.sps-host-note[data-host="keybox"]')
    await expect(note).toHaveAttribute('data-type', 'connect')
    const inPicker = await readFailure(note, wire.error!)
    expect(await buttonOrder(note.locator('.sps-host-note-actions'))).toEqual(['Retry', 'Open Settings'])
    await picker(page).screenshot({ path: `${SHOTS}/picker-keybox.png` })

    // 3. Settings, through the banner's own Open Settings.
    // A click outside closes the picker (its outside-click path). The card
    // stays in the task panel while a draft is open: still exactly one.
    await expect(page.locator('[data-testid="attention-banner"]')).toHaveCount(1)
    await expect(page.locator('.todo-panel [data-testid="attention-banner"][data-mount="tasks"]')).toHaveCount(1)
    await page.locator('.todo-panel').click({ position: { x: 5, y: 5 } })
    await expect(picker(page)).toBeHidden()
    // Several rows start closed (dense): Show details puts the row's Open Settings on screen.
    await openRow(row)
    await row.getByTestId('hpb-open-settings').click()
    await expect(page).toHaveURL(/\/settings#rh-host-keybox$/)
    const settingsRow = hostRow(page, 'keybox')
    await expect(settingsRow).toBeVisible({ timeout: 20_000 })
    const inSettings = await readFailure(settingsRow.locator('.rh-failure'), wire.error!)
    await expect(settingsRow.locator('.rh-status').getByRole('button', { name: 'Retry' })).toBeEnabled()

    expect(inBanner.headline).toBe('Could not connect to Key box')
    expect(inPicker).toEqual(inBanner)
    expect(inSettings).toEqual(inBanner)
    expect(inBanner.hint).toBe(wire.hint!.replace(/`/g, ''))
    await settingsRow.screenshot({ path: `${SHOTS}/settings-keybox-open.png` })
  })

  test('at 900px the Settings hint wraps whole, outside the one-line status classes (C78)', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 })
    await loadApp(page, '/settings')
    await openRemoteHosts(page)
    const r = hostRow(page, 'keybox')
    await r.scrollIntoViewIfNeeded()
    const hint = r.locator('.rh-failure .hft-hint')
    await expect(hint).toBeVisible()
    const m = await hint.evaluate((el) => ({
      scrollW: el.scrollWidth, clientW: el.clientWidth, h: el.getBoundingClientRect().height,
      line: parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.4,
      insideStatus: !!el.closest('.rh-status, .rh-status-error'),
    }))
    expect(m.scrollW).toBeLessThanOrEqual(m.clientW)
    expect(m.h).toBeGreaterThan(m.line * 1.5)
    expect(m.insideStatus).toBe(false)
    expect(await r.locator('.rh-status .hft, .rh-status-error .hft').count()).toBe(0)
    // The shared one-line rule is still what it was: the hint escaped it, the rule did not change.
    const statusText = await r.locator('.rh-status .status-text').evaluate((el) => {
      const cs = getComputedStyle(el)
      return { ws: cs.whiteSpace, ov: cs.overflow, to: cs.textOverflow }
    })
    expect(statusText).toEqual({ ws: 'nowrap', ov: 'hidden', to: 'ellipsis' })
    await r.screenshot({ path: `${SHOTS}/settings-900-keybox.png` })
  })
})

test.describe('the Settings row itself', () => {
  test.beforeAll(async ({ request }) => {
    await loadFixture(request, fixtureFile({
      devbox: { label: 'Dev box', hostname: 'dev.example.com', phase: 'connected', claude: HEALTHY },
      signbox: { label: 'Sign box', hostname: 'sign.example.com', phase: 'connected', claude: { version: '2.1.281', auth: 'not-logged-in', installMethod: 'native' } },
    }))
  })

  test('title is the label, then the alias; Open Settings from the banner flashes the row every time (C68)', async ({ page }) => {
    await loadApp(page)
    const flashOnce = async () => {
      await bannerRow(page, 'signbox').getByTestId('hpb-open-settings').click()
      await expect(page).toHaveURL(/\/settings#rh-host-signbox$/)
      const r = hostRow(page, 'signbox')
      await expect(r).toHaveClass(/rh-row-flash/, { timeout: 5_000 })
      await expect(r).toBeInViewport()
      await expect(r).not.toHaveClass(/rh-row-flash/, { timeout: 5_000 })
      return r
    }
    const r = await flashOnce()
    expect(await r.getAttribute('id')).toBe('rh-host-signbox')
    await expect(r.locator('.rh-host-name')).toHaveText('Sign box')
    await expect(r.locator('.rh-host-alias')).toHaveText('signbox')
    // Back home and the same Open Settings again: the same hash, a second flash.
    await page.getByTestId('sidebar-core-app-home').click()
    await expect(bannerRow(page, 'signbox')).toBeVisible({ timeout: 20_000 })
    await flashOnce()
  })

  test('reconnecting with a timeout: Reconnecting to Dev box, the last attempt, and Connect now works (C9)', async ({ page, request }) => {
    await hostFixture(request, { action: 'start-reconnect', host: 'devbox' })
    await hostFixture(request, { action: 'inject-failure', host: 'devbox', kind: 'timeout' })
    const wire = await wireHost(request, 'devbox')
    expect(wire.phase).toBe('reconnecting')
    expect(wire.lastKind).toBe('timeout')
    await loadApp(page, '/settings')
    await openRemoteHosts(page)
    const r = hostRow(page, 'devbox')
    await expect(r.locator('.rh-status-short')).toHaveText('Reconnecting to Dev box')
    await expect(r.locator('.rh-failure[data-type="reconnecting"] .hft-headline')).toHaveText('Last attempt: Connecting to Dev box timed out')
    const now = r.locator('.rh-status').getByRole('button', { name: 'Connect now' })
    await expect(now).toBeEnabled()
    await r.screenshot({ path: `${SHOTS}/settings-reconnecting.png` })
    const before = (await fixtureCounters(request)).connect.devbox ?? 0
    await now.click()
    await expect(r.locator('.rh-status-short')).toHaveText('Connected', { timeout: 10_000 })
    expect((await fixtureCounters(request)).connect.devbox ?? 0).toBe(before + 1)
  })
})

test.describe('an ephemeral fixture: Settings says off and offers nothing', () => {
  test.beforeAll(async ({ request }) => { await loadFixture(request, 'host-problems-ephemeral') })

  test('every row reads Off on this test server, no Connect now, no readiness lines, no host banner (C24)', async ({ page, request }) => {
    await loadApp(page)
    await expect(page.locator('[data-testid="host-problems"]')).toHaveCount(0)
    await openRemoteHosts(page)
    const hosts = ['devbox', 'buildbox', 'signbox', 'keybox', 'certbox', 'netbox', 'offhost']
    for (const host of hosts) {
      expect((await wireHost(request, host)).phase).toBe('off')
      const r = hostRow(page, host)
      await expect(r.locator('.rh-status-short')).toHaveText('Off on this test server')
      await expect(r.locator('.rh-status').getByRole('button')).toHaveCount(0)
      await expect(r.locator('.rh-readiness, .rh-failure')).toHaveCount(0)
    }
    for (const host of hosts) {
      await expect(hostRow(page, host).getByRole('button', { name: /^(Connect now|Retry|Update|Install|Check again)$/ })).toHaveCount(0)
    }
    // Every OTHER row is a host switched off in Settings (the test server's own
    // `fixture-remote`): it reads Disabled with no button (a Connect now there
    // only ever answered 409 host_disabled), and nothing below the status line.
    const aliases = await page.locator('#remote-hosts .rh-host-row[data-host-alias]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-host-alias')!))
    const others = aliases.filter((a) => !hosts.includes(a))
    expect(others).toContain('fixture-remote')
    for (const alias of others) {
      const r = hostRow(page, alias)
      await expect(r.locator('.rh-status-short')).toHaveText('Disabled')
      await expect(r.locator('.rh-status').getByRole('button')).toHaveCount(0)
      await expect(r.getByRole('button', { name: /^(Connect now|Retry|Update|Install|Check again)$/ })).toHaveCount(0)
      await expect(r.locator('.rh-readiness, .rh-failure')).toHaveCount(0)
    }
    await expect(page.locator('#remote-hosts')).not.toContainText('Not connected')
    await page.locator('#remote-hosts').screenshot({ path: `${SHOTS}/settings-ephemeral.png` })
  })
})

/** The Fix box row's readiness block text, sampled until `until` matches or 20s pass. */
async function sampleUntil(block: Locator, until: RegExp, everyMs = 250, maxMs = 20_000): Promise<string[]> {
  const out: string[] = []
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const t = await block.innerText().catch(() => '')
    out.push(t)
    if (until.test(t)) return out
    await new Promise((r) => setTimeout(r, everyMs))
  }
  throw new Error(`never matched ${until}: last ${JSON.stringify(out.slice(-3))}`)
}

test.describe('Update on a host the server can fix', () => {
  const FIX_FILE = fixtureFile({
    fixbox: { label: 'Fix box', hostname: 'fix.example.com', phase: 'connected', claude: { version: '2.1.220', auth: 'ok', installMethod: 'native' } },
  })
  test.beforeEach(async ({ request }) => { await loadFixture(request, FIX_FILE) })

  async function openFixRow(page: Page): Promise<{ row: Locator; message: string }> {
    await loadApp(page, '/settings')
    await openRemoteHosts(page)
    const row = hostRow(page, 'fixbox')
    const line = row.locator('.rh-readiness[data-problem="claude_outdated"]')
    await expect(line).toBeVisible()
    return { row, message: (await line.innerText()).trim() }
  }

  test('from Update until the re-check answers, the line only ever reads Updating Claude Code on Fix box... (C29)', async ({ page, request }) => {
    const { row, message } = await openFixRow(page)
    expect(message).toContain('Claude Code on Fix box is 2.1.220')
    await row.getByTestId('rh-readiness-fix-claude_outdated').click()
    const samples = await sampleUntil(row, /✓ Fix box is ready \(Claude Code 2\.1\.281\)/)
    const during = samples.slice(0, -1)
    expect(during.length).toBeGreaterThan(8)
    for (const t of during) {
      expect(t).toContain('Updating Claude Code on Fix box...')
      expect(t).not.toContain(message)
    }
    // The fixture really went through the gap: fixing dropped before the re-check landed.
    expect((await fixtureCounters(request)).connect.fixbox).toBe(1)
    const wire = await wireHost(request, 'fixbox')
    expect(wire.readiness?.problems).toEqual([])
  })

  test('a slow fix shows its time, then Still updating and Check again after 3 minutes (C95)', async ({ page, request }) => {
    await hostFixture(request, { action: 'autofix-slow', host: 'fixbox', ms: 200_000 })
    const { row } = await openFixRow(page)
    await row.getByTestId('rh-readiness-fix-claude_outdated').click()
    const running = row.locator('.rh-readiness[data-fix="running"]')
    await expect(running).toHaveText(/^Updating Claude Code on Fix box\.\.\.$/)
    await page.waitForTimeout(6_000)
    await expect(running).toHaveText(/^Updating Claude Code on .+\.\.\. \d+s$/)
    await hostFixture(request, { action: 'advance-clock', ms: 180_000 })
    await expect(running).toHaveText(/^Still updating Claude Code on Fix box\.\.\. 3m \d+s$/, { timeout: 5_000 })
    await expect(row.getByRole('button', { name: 'Check again' })).toBeVisible()
    await row.screenshot({ path: `${SHOTS}/settings-still-updating.png` })
  })
})

test.describe('where else a host problem shows', () => {
  test('the System pane names the host, its phase and the first sentence of its problem (C71)', async ({ page, request }) => {
    await loadFixture(request, 'host-problems')
    const message = (await wireHost(request, 'buildbox')).readiness!.problems[0].message
    await loadApp(page)
    await page.getByRole('button', { name: 'Notifications' }).click()
    const panel = page.locator('.notification-panel')
    await panel.locator('.nfc-rail-btn', { hasText: 'System' }).click()
    const value = panel.locator('.notification-detail-row[data-host="buildbox"] .notification-detail-value')
    await expect(value).toHaveText(`Connected. ${firstSentence(message)}`, { timeout: 15_000 })
    await expect(panel.locator('.notification-detail-row[data-host="buildbox"] .hsd')).toHaveAttribute('data-kind', 'warn')
    // A healthy host still reads a bare Connected.
    await expect(panel.locator('.notification-detail-row[data-host="devbox"] .notification-detail-value')).toHaveText('Connected')
  })

  test('task panel, slot and draft column all hidden: the rail Settings entry and the bell wear the warn dot until nothing needs attention (C67)', async ({ page, request }) => {
    await loadFixture(request, fixtureFile({
      keybox: { label: 'Key box', hostname: 'key.example.com', phase: 'failed', error: 'Permission denied (publickey).' },
      signbox: { label: 'Sign box', hostname: 'sign.example.com', phase: 'connected', claude: { version: '2.1.281', auth: 'not-logged-in', installMethod: 'native' } },
    }))
    await bareLayout(page)
    await loadApp(page)
    await expect(page.locator('.main-page-chat [data-testid="ask-walnut-slot"]')).toHaveCount(0)
    await expect(page.locator('.main-page-session-column .draft-session-panel')).toHaveCount(0)
    await expect(page.locator('[data-testid="attention-banner"]')).toHaveCount(0)
    const entry = page.getByTestId('sidebar-core-app-settings')
    const dot = entry.locator('.sidebar-host-dot')
    // The link carries the one accessible name; the dot inside it is decorative.
    await expect(entry).toHaveAttribute('aria-label', 'Settings: remote hosts need attention', { timeout: 20_000 })
    await expect(dot).toHaveAttribute('aria-hidden', 'true')
    await expect(dot).toHaveAttribute('data-kind', 'warn')
    // The bell speaks for the card too: a dot, no number, the reason in its name.
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications: remote hosts need attention')
    await expect(bell(page).locator('.notification-badge-dot')).toHaveCount(1)
    await expect(bell(page).locator('.notification-badge-count')).toHaveCount(0)
    await entry.screenshot({ path: `${SHOTS}/rail-settings-dot.png` })
    await entry.click()
    await expect(page).toHaveURL(/\/settings#remote-hosts$/)
    await expect(page.locator('#remote-hosts')).toBeVisible()
    // On the Remote hosts pane the rows are in view: neither dot speaks for them.
    await expect(dot).toHaveCount(0)
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications')
    await page.getByTestId('settings-nav-sessions').click()
    await expect(dot).toHaveAttribute('data-kind', 'warn')
    // The fixture clears both problems: the dot stays while one is left, and goes with the last.
    await hostFixture(request, { action: 'set-status', host: 'keybox', phase: 'connected' })
    await expect.poll(async () => (await wireHost(request, 'keybox')).connected, { timeout: 10_000 }).toBe(true)
    await page.waitForTimeout(500)
    await expect(dot).toHaveAttribute('data-kind', 'warn')
    await hostFixture(request, { action: 'clear-problems', host: 'signbox' })
    await expect(dot).toHaveCount(0, { timeout: 5_000 })
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications', { timeout: 5_000 })
  })
})
