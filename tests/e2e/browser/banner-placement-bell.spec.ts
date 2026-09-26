/**
 * Who speaks when no card is on the page (slice spec 3): the rail Settings dot
 * and the bell. The bell's number stays for human decisions (asks); a host or
 * local reason is a dot (a corner dot next to a number), named in its
 * accessible name and title. Also the System rail (4.2) and the sign-in
 * re-check that runs with no card mounted.
 * Host frames and local health are routed client-side; BP-C58 uses the
 * server's host fixture (the System pane lists the server's hosts).
 *
 * Run: PW_TEST_PORT=35994 PW_IGNORE_LOAD=1 npx playwright test banner-placement-bell --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35994 PW_IGNORE_LOAD=1 npx playwright test banner-placement-bell --project=webkit --workers=1
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import {
  anyBanner, banner, bareLayout, connected, failed, hideTaskPanel, isolatePrefs, resetServerHostFixture, routeHealth, signedOut,
} from './host-problems-helpers'
import { bell, fixtureFile, HEALTHY, loadApp, loadFixture, openBell, panelBanner } from './host-problems-fixture-helpers'
import {
  BP_SHOTS, askRecord, bellCount, bellDot, bpSetup, closePanel, expectTasksCard, goRail, healthyGitSync, openPanelCard,
  openRow, railButton, reserve, settingsDot, settingsEntry,
} from './banner-placement-helpers'

test.describe.configure({ timeout: 90_000 })

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(BP_SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})

const HOSTS_REASON = 'Notifications: remote hosts need attention'
const LOCAL_REASON = 'Notifications: Claude Code needs attention'
const BOTH_REASON = 'Notifications: Claude Code and remote hosts need attention'
const chatHidden = async (p: Page) => { await p.addInitScript(() => localStorage.setItem('open-walnut-home-chat-visible', 'false')) }

test.describe('the rail and the bell speak when no card is on the page', () => {
  test('BP-C15: task panel and chat hidden, no draft: no card; the rail Settings dot and the bell dot name remote hosts', async ({ page }) => {
    await bpSetup(page, { before: bareLayout })
    await expect(settingsEntry(page)).toHaveAttribute('aria-label', 'Settings: remote hosts need attention', { timeout: 20_000 })
    await expect(anyBanner(page)).toHaveCount(0)
    await expect(bell(page)).toHaveAttribute('aria-label', HOSTS_REASON)
    await expect(bellDot(page)).toHaveCount(1)
    await expect(bellCount(page)).toHaveCount(0)
    await page.locator('.sidebar-notification-area').screenshot({ path: `${BP_SHOTS}/c15-bell-dot.png` })
  })

  test('BP-C16: default Home with the card in the task panel and no ask: no bell dot, the name is Notifications', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications')
    await expect(bellDot(page)).toHaveCount(0)
    await expect(settingsDot(page)).toHaveCount(0)
  })

  test('BP-C17: a pending ask: the amber number alone while the card is on Home; on /notes the number plus a corner dot', async ({ page }) => {
    await bpSetup(page, { feed: [askRecord(1)] })
    await expectTasksCard(page)
    await expect(bellCount(page)).toHaveText('1')
    await expect(bellCount(page)).toHaveClass(/notification-badge-attention/)
    await expect(bell(page).locator('.notification-badge-dot.is-corner')).toHaveCount(0)
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications')
    await goRail(page, 'notes')
    await expect(bellCount(page)).toHaveText('1')
    await expect(bell(page).locator('.notification-badge-dot.is-corner')).toHaveCount(1)
    const name = 'Notifications, 1 waiting; remote hosts need attention'
    await expect(bell(page)).toHaveAttribute('aria-label', name)
    await expect(bell(page)).toHaveAttribute('title', name)
    await page.locator('.sidebar-notification-area').screenshot({ path: `${BP_SHOTS}/c17-count-corner-dot.png` })
  })

  test('BP-C18: only a local sign-in problem: no bell dot while the task panel shows it; with no mount the bell names Claude Code', async ({ page }) => {
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box')], local: 'sign-in', before: chatHidden })
    await expect(banner(page).locator('[data-testid="setup-banner-sign-in"]')).toBeVisible({ timeout: 20_000 })
    await expect(bellDot(page)).toHaveCount(0)
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications')
    await hideTaskPanel(page)
    await expect(anyBanner(page)).toHaveCount(0)
    await expect(bell(page)).toHaveAttribute('aria-label', LOCAL_REASON)
    await expect(bellDot(page)).toHaveCount(1)
    // A local-only problem never lights the rail Settings dot (that one is for remote hosts).
    await expect(settingsDot(page)).toHaveCount(0)
  })
})

test.describe('local Claude Code: the re-check and the version floor', () => {
  test('BP-C49: on /notes the sign-in re-check runs with no card mounted; opening the panel asks once; signing in clears the dot', async ({ page }) => {
    const h = await bpSetup(page, { hosts: [connected('devbox', 'Dev box')], local: 'sign-in' })
    await expect(banner(page).locator('[data-testid="setup-banner-sign-in"]')).toBeVisible({ timeout: 20_000 })
    await goRail(page, 'notes')
    await expect(bell(page)).toHaveAttribute('aria-label', LOCAL_REASON)
    const n0 = h.health!.rechecks
    await openPanelCard(page)
    await page.waitForTimeout(1500)
    expect(h.health!.rechecks - n0).toBe(1)
    await closePanel(page, 'escape')
    // Signed in from a terminal: the next 15s re-check answers it; no panel, no card.
    h.health!.state = 'ready'
    await expect(bellDot(page)).toHaveCount(0, { timeout: 17_000 })
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications')
    const src = ['components/common/AttentionBanner.tsx', 'components/common/SetupBanner.tsx']
      .map((f) => fs.readFileSync(path.resolve(process.cwd(), 'web/src', f), 'utf-8')).join('\n')
    expect(src).not.toMatch(/setInterval\([^)]*checkLocalClaude/)
  })

  test('BP-C50: this machine only outdated: no card anywhere, no bell dot; outdated plus a signed-out host: the host section only', async ({ page, browser }) => {
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box')], local: 'outdated' })
    await page.waitForTimeout(1500)
    await expect(anyBanner(page)).toHaveCount(0)
    await expect(bellDot(page)).toHaveCount(0)
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications')
    await openBell(page)
    await expect(panelBanner(page)).toHaveCount(0)
    const ctx = await browser.newContext()
    const page2 = await ctx.newPage()
    try {
      // Two hosts, so the card takes the shared title (one host would title it by name, C82).
      await bpSetup(page2, { hosts: [signedOut('signbox', 'Sign box'), failed('netbox', 'Net box', 'unreachable')], local: 'outdated' })
      await expect(banner(page2)).toHaveCount(1, { timeout: 20_000 })
      await expect(banner(page2).locator('[data-testid="setup-banner-outdated"]')).toHaveCount(0)
      await expect(banner(page2).locator('.setup-banner-title')).toHaveText('Remote hosts need attention')
    } finally {
      await ctx.close()
    }
  })
})

test.describe('the System rail (server fixture)', () => {
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('BP-C58: an unreachable host lights the System rail dot with no number; an outdated host alone does not, but is listed', async ({ page, browser, request }) => {
    await loadFixture(request, fixtureFile({
      devbox: { label: 'Dev box', hostname: 'dev.example.com', phase: 'connected', claude: HEALTHY },
      netbox: { label: 'Net box', hostname: 'net.example.com', phase: 'failed', error: 'ssh: connect to host net.example.com port 22: Network is unreachable' },
    }))
    await isolatePrefs(page)
    await healthyGitSync(page)
    await loadApp(page)
    await openBell(page)
    const system = railButton(page, 'System')
    await expect(system.locator('.nfc-rail-dot')).toHaveCount(1, { timeout: 20_000 })
    await expect(system.locator('.nfc-rail-badge')).toHaveCount(0)
    await system.click()
    await expect(page.locator('.notification-panel .notification-card-label', { hasText: /^Remote hosts$/ })).toHaveCount(1)
    await loadFixture(request, fixtureFile({
      devbox: { label: 'Dev box', hostname: 'dev.example.com', phase: 'connected', claude: HEALTHY },
      buildbox: { label: 'Build box', hostname: 'build.example.com', phase: 'connected', claude: { version: '2.1.220', auth: 'ok', installMethod: 'other' } },
    }))
    const ctx = await browser.newContext()
    const page2 = await ctx.newPage()
    try {
      await isolatePrefs(page2)
      await healthyGitSync(page2)
      await loadApp(page2)
      await openBell(page2)
      const system2 = railButton(page2, 'System')
      await system2.click()
      await expect(page2.locator('.notification-detail-row[data-host="buildbox"]')).toBeVisible({ timeout: 20_000 })
      await expect(system2.locator('.nfc-rail-dot')).toHaveCount(0)
      await page2.locator('.notification-panel').screenshot({ path: `${BP_SHOTS}/c58-system-outdated-only.png` })
    } finally {
      await ctx.close()
    }
  })
})

test.describe('the bell names its reason word for word', () => {
  /** On /notes (nothing covered): both, then hosts, then local, each read off the bell. */
  async function sampleReasons(page: Page, count: 0 | 1): Promise<void> {
    const h = await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), failed('netbox', 'Net box', 'unreachable')], local: 'sign-in', feed: count ? [askRecord(1)] : [] })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await goRail(page, 'notes')
    const name = (sentence: string) => count ? sentence.replace('Notifications: ', 'Notifications, 1 waiting; ') : sentence
    for (const [label, step] of [
      [BOTH_REASON, async () => {}],
      [HOSTS_REASON, async () => { await h.health!.set('ready') }],
      [LOCAL_REASON, async () => { await h.push(connected('netbox', 'Net box')); await h.health!.set('sign-in') }],
    ] as Array<[string, () => Promise<void>]>) {
      await step()
      await expect(bell(page)).toHaveAttribute('aria-label', name(label), { timeout: 10_000 })
      await expect(bell(page)).toHaveAttribute('title', name(label))
      if (count) await expect(bell(page).locator('.notification-badge-dot.is-corner')).toHaveCount(1)
      else await expect(bellDot(page)).toHaveCount(1)
    }
  }

  test('BP-C59: attentionCount 0: hosts, local and both read the table sentences; title equals the name', async ({ page }) => {
    await sampleReasons(page, 0)
  })

  test('BP-C59: attentionCount 1: the same reasons after "1 waiting"', async ({ page }) => {
    await sampleReasons(page, 1)
  })

  test('BP-C59: Quiet: the title starts with the quiet label, then "; " and the reason; the name stays the reason', async ({ page }) => {
    await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable')] })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await goRail(page, 'notes')
    await expect(bell(page)).toHaveAttribute('aria-label', HOSTS_REASON)
    await openBell(page)
    const toggle = page.getByTestId('nfc-quiet-toggle')
    await toggle.click()
    try {
      await expect(toggle).toHaveText('End quiet', { timeout: 10_000 })
      await closePanel(page, 'escape')
      await expect(bell(page)).toHaveAttribute('data-quiet', 'true')
      await expect(bell(page)).toHaveAttribute('aria-label', HOSTS_REASON)
      const title = (await bell(page).getAttribute('title')) ?? ''
      expect(title.endsWith(`; ${HOSTS_REASON}`)).toBe(true)
      expect(title.length).toBeGreaterThan(`; ${HOSTS_REASON}`.length)
      await openBell(page)
    } finally {
      // Quiet is server state on the shared fixture server: always end it.
      if (await toggle.innerText().catch(() => '') === 'End quiet') await toggle.click()
      await expect(toggle).toHaveText('Quiet 1h', { timeout: 10_000 })
    }
  })
})

test.describe('the reserve and the Remote hosts pane', () => {
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('BP-C68: no reserve off Home or after Open Settings; on the Remote hosts pane neither dot speaks, on another pane both do', async ({ page, request }) => {
    // The server's fixture: Settings lists these hosts, so #rh-host-netbox is a real row.
    await loadFixture(request, 'host-problems')
    await isolatePrefs(page)
    await healthyGitSync(page)
    await routeHealth(page)
    await loadApp(page)
    await expectTasksCard(page)
    await goRail(page, 'notes')
    await openBell(page)
    await expect(reserve(page)).toHaveCount(0)
    await closePanel(page, 'escape')
    await goRail(page, 'home')
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    const card = await openPanelCard(page)
    // Several rows start closed (dense): Show details puts the row's Open Settings on screen.
    await openRow(card.locator('li.hpb-row[data-host="keybox"]'))
    await card.locator('li.hpb-row[data-host="keybox"]').getByTestId('hpb-open-settings').click()
    await expect(page).toHaveURL(/\/settings#rh-host-keybox$/)
    await expect(page.locator('.notification-panel')).toHaveCount(0)
    await expect(settingsDot(page)).toHaveCount(0)
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications')
    await page.getByTestId('settings-nav-sessions').click()
    await expect(settingsDot(page)).toHaveAttribute('data-kind', 'warn')
    await expect(bell(page)).toHaveAttribute('aria-label', HOSTS_REASON)
    await page.getByTestId('settings-nav-remote-hosts').click()
    await expect(page).toHaveURL(/\/settings#remote-hosts$/)
    await expect(settingsDot(page)).toHaveCount(0)
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications')
    await goRail(page, 'home')
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await expect(reserve(page)).toHaveCount(0)
  })
})
