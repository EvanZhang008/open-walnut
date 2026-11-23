/**
 * The rail's marks for a host or Claude Code problem (useAttentionDots.ts): no
 * card on the page carries these problems, so the bell dot and the rail
 * Settings warn dot speak on every page, Home included. The bell's number
 * stays for human decisions (asks); a host or local reason is a dot (a corner
 * dot next to a number), named in the bell's accessible name and title. The
 * Settings dot is for remote hosts only and goes quiet on Settings > Remote
 * hosts, where the rows are; Quiet silences the bell. Also the local Claude
 * Code re-check and version floor as the bell and the panel read them.
 * Host frames and local health are routed client-side; HD-8 uses the server's
 * host fixture (Settings lists the server's hosts).
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { connected, failed, isolatePrefs, resetServerHostFixture, routeHealth, signedOut } from './host-problems-helpers'
import { bell, loadApp, loadFixture, openBell } from './host-problems-fixture-helpers'
import {
  FIXTURE_ORDER, askRecord, bellCount, bellDot, bpSetup, closePanel, endServerQuiet, errorsBadge, goRail, healthyGitSync, hostRowsOutsidePanel,
  openProblems, openRow, openSystemHosts, panelLocalCard, panelProblems, pickRail, problemHosts, problemRow, railButton, seedFeed, settingsDot,
  settingsEntry, systemBadge, systemHostRow,
} from './host-attention-helpers'

test.describe.configure({ timeout: 90_000 })

test.beforeAll(async ({ request }) => { await resetServerHostFixture(request) })

const HOSTS_REASON = 'Notifications: remote hosts need attention'
const LOCAL_REASON = 'Notifications: Claude Code needs attention'
const BOTH_REASON = 'Notifications: Claude Code and remote hosts need attention'
const LABELS: Record<string, string> = { keybox: 'Key box', certbox: 'Cert box', netbox: 'Net box', signbox: 'Sign box' }

test.describe('the dots speak on every page', () => {
  test('HD-1: default Home: no host row on the page; the rail Settings dot and the bell dot name remote hosts, with no count; the same on /notes', async ({ page }) => {
    await bpSetup(page)
    await expect(settingsEntry(page)).toHaveAttribute('aria-label', 'Settings: remote hosts need attention', { timeout: 20_000 })
    await expect(settingsDot(page)).toHaveAttribute('data-kind', 'warn')
    await expect(hostRowsOutsidePanel(page)).toHaveCount(0)
    await expect(bell(page)).toHaveAttribute('aria-label', HOSTS_REASON)
    await expect(bell(page)).toHaveAttribute('title', HOSTS_REASON)
    await expect(bellDot(page)).toHaveCount(1)
    await expect(bellCount(page)).toHaveCount(0)
    await goRail(page, 'notes')
    await expect(settingsDot(page)).toHaveAttribute('data-kind', 'warn')
    await expect(bell(page)).toHaveAttribute('aria-label', HOSTS_REASON)
    await expect(bellDot(page)).toHaveCount(1)
  })

  // One mark on the bell (2026-11-21, the label system, standard.md "Status labels"): beside a count
  // the hosts' dot goes; the bell's name still says both.
  test('HD-2: a pending ask: the one needs-you count badge alone (Mail\'s look, no corner dot), on Home and on /notes, and the name says both', async ({ page }) => {
    await bpSetup(page, { feed: [askRecord(1)] })
    const name = 'Notifications, 1 waiting; remote hosts need attention'
    for (const where of ['home', 'notes'] as const) {
      if (where === 'notes') await goRail(page, 'notes')
      await expect(bellCount(page), where).toHaveText('1', { timeout: 20_000 })
      await expect(bellCount(page), where).not.toHaveClass(/notification-badge-attention/)
      await expect(bellCount(page), where).toHaveClass(/badge-alert/)
      await expect(bell(page).locator('.notification-badge-dot'), where).toHaveCount(0)
      await expect(bell(page), where).toHaveAttribute('aria-label', name)
      await expect(bell(page), where).toHaveAttribute('title', name)
    }
  })

  test('HD-3: only a local sign-in problem: the bell names Claude Code with a dot on Home; the rail Settings dot stays off (it is for remote hosts)', async ({ page }) => {
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box')], local: 'sign-in' })
    await expect(bell(page)).toHaveAttribute('aria-label', LOCAL_REASON, { timeout: 20_000 })
    await expect(bellDot(page)).toHaveCount(1)
    await expect(settingsDot(page)).toHaveCount(0)
    await expect(hostRowsOutsidePanel(page)).toHaveCount(0)
  })

  test('HD-4: the bell dot for hosts is the bell\'s one dot (its usual shape and size, the rail Settings dot\'s warn colour); with git sync failing too and every host dismissed in the panel, the same dot in its plain look, named Notifications', async ({ page }) => {
    await bpSetup(page, {
      before: async (p) => {
        await p.route('**/api/git-sync/status', (route) => route.fulfill({ json: { protected: false, consecutiveFailures: 0, error: 'git unavailable' } }))
      },
    })
    await expect(settingsDot(page)).toHaveCount(1, { timeout: 20_000 })
    await expect(bellDot(page)).toHaveCount(1)
    await expect(bellDot(page)).toHaveClass(/is-host-warn/)
    const lookOf = (sel: string) => page.evaluate((s) => {
      const btn = document.querySelector('.sidebar-notification-btn')!
      let e = btn.querySelector<HTMLElement>(s)
      const made = !e
      if (!e) { e = document.createElement('span'); e.className = 'notification-badge-dot'; btn.appendChild(e) }
      const cs = getComputedStyle(e)
      const v = `${cs.backgroundColor}|${cs.borderRadius}|${cs.width}|${cs.height}`
      if (made) e.remove()
      return v
    }, sel)
    const colour = (l: Locator) => l.evaluate((e) => getComputedStyle(e.querySelector<HTMLElement>('.hsd') ?? e).backgroundColor)
    // The plain dot the bell has always drawn (a bare .notification-badge-dot), and the one it draws now.
    const plain = await lookOf('.notification-badge-dot.__none')
    const shape = (look: string) => look.split('|').slice(1).join('|')
    expect(shape(await lookOf('.notification-badge-dot'))).toBe(shape(plain))
    expect(await colour(bellDot(page))).toBe(await colour(settingsDot(page)))
    await openProblems(page)
    for (const host of FIXTURE_ORDER) await problemRow(page, host).getByRole('button', { name: `Dismiss ${LABELS[host]}` }).click()
    await expect(problemHosts(page)).toHaveCount(0)
    await closePanel(page, 'escape')
    // Hosts dismissed, git sync still failing: the same dot, the plain look, and its name no longer says hosts.
    await expect(settingsDot(page)).toHaveCount(0)
    await expect(bellDot(page)).toHaveCount(1)
    expect(await lookOf('.notification-badge-dot')).toBe(plain)
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications')
  })
})

test.describe('the bell names its reason word for word', () => {
  /** Both, then hosts, then local, each read off the bell on Home. */
  async function sampleReasons(page: Page, count: 0 | 1): Promise<void> {
    // An expired certificate is the person's to clear, so it speaks on the bell (an unreachable host would not).
    const h = await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), failed('netbox', 'Net box', 'cert_expired')], local: 'sign-in', feed: count ? [askRecord(1)] : [] })
    const name = (sentence: string) => count ? sentence.replace('Notifications: ', 'Notifications, 1 waiting; ') : sentence
    for (const [label, step] of [
      [BOTH_REASON, async () => {}],
      [HOSTS_REASON, async () => { await h.health!.set('ready') }],
      [LOCAL_REASON, async () => { await h.push(connected('netbox', 'Net box')); await h.health!.set('sign-in') }],
    ] as Array<[string, () => Promise<void>]>) {
      await step()
      await expect(bell(page)).toHaveAttribute('aria-label', name(label), { timeout: 20_000 })
      await expect(bell(page)).toHaveAttribute('title', name(label))
      if (count) await expect(bell(page).locator('.notification-badge-dot')).toHaveCount(0) // the count is the one mark
      else await expect(bellDot(page)).toHaveCount(1)
    }
  }

  test('HD-5: attentionCount 0: hosts, local and both read the table sentences; title equals the name', async ({ page }) => {
    await sampleReasons(page, 0)
  })

  test('HD-6: attentionCount 1: the same reasons after "1 waiting"', async ({ page }) => {
    await sampleReasons(page, 1)
  })

  // Quiet is server state on the shared fixture server, read by every later spec there. A hook
  // ends it even when the test timed out (2026-11-02: a finally inside the test waited on a
  // closed panel until the timeout, left Quiet on, and four specs after it read "Quiet").
  test.afterEach(async ({ request }) => { await endServerQuiet(request) })

  test('HD-7: Quiet: the bell wears the moon, no dot, and names only the quiet (not the reason); ending it brings the reason and the dot back', async ({ page }) => {
    await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'cert_expired')] })
    await expect(bell(page)).toHaveAttribute('aria-label', HOSTS_REASON, { timeout: 20_000 })
    await expect(bellDot(page)).toHaveCount(1)
    await openBell(page)
    const toggle = page.getByTestId('nfc-quiet-toggle')
    await toggle.click()
    await expect(toggle).toHaveText('Unmute', { timeout: 10_000 })
    await closePanel(page, 'escape')
    // Quiet is Do Not Disturb for the rail (b55ee8d97): no count or dot, in the marks or the name.
    await expect(bell(page)).toHaveAttribute('data-quiet', 'true')
    await expect(bell(page).locator('.quiet-moon')).toHaveCount(1)
    await expect(bellDot(page)).toHaveCount(0)
    await expect(bell(page)).toHaveAttribute('aria-label', /^Notifications\. Quiet\b/)
    const name = (await bell(page).getAttribute('aria-label')) ?? ''
    await expect(bell(page)).toHaveAttribute('title', name.replace('Notifications. ', ''))
    expect(name).not.toContain('remote hosts')
    await openBell(page)
    await toggle.click()
    await expect(toggle).toHaveText('Mute for 1 hour', { timeout: 10_000 })
    await closePanel(page, 'escape')
    await expect(bell(page)).not.toHaveAttribute('data-quiet', 'true')
    await expect(bell(page)).toHaveAttribute('aria-label', HOSTS_REASON)
    await expect(bell(page)).toHaveAttribute('title', HOSTS_REASON)
    await expect(bellDot(page)).toHaveCount(1)
  })
})

test.describe('a host Walnut is handling', () => {
  test('HD-11: only an unreachable host: no bell or Settings dot, no toast, no problems block; System lists its row and Errors points to Walnut Health', async ({ page }) => {
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), failed('netbox', 'Net box', 'unreachable')] })
    // System naming the host proves its frame arrived before the absences below are read.
    await openSystemHosts(page)
    await expect(systemHostRow(page, 'netbox')).toBeVisible({ timeout: 20_000 })
    await expect(systemHostRow(page, 'netbox')).toHaveAttribute('data-kind', 'unreachable')
    await pickRail(page, 'All')
    await expect(panelProblems(page)).toHaveCount(0)
    await expect(problemRow(page, 'netbox')).toHaveCount(0)
    await pickRail(page, 'Errors')
    await expect(page.locator('.notification-panel [data-testid="nfc-health-link"]')).toContainText('see Walnut Health')
    await closePanel(page, 'escape')
    await expect(bellDot(page)).toHaveCount(0)
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications')
    await expect(settingsDot(page)).toHaveCount(0)
    await expect(page.locator('[data-testid="corner-stack"] [data-testid="notification-toast"]', { hasText: /Net box|remote host/ })).toHaveCount(0)
  })
})

test.describe('Settings > Remote hosts (server fixture)', () => {
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('HD-8: Open Settings from a System row closes the panel and lands on the host row; on the Remote hosts pane neither dot speaks, on another Settings pane both do', async ({ page, request }) => {
    // The server's fixture: Settings lists these hosts, so #rh-host-keybox is a real row.
    await loadFixture(request, 'host-problems')
    await isolatePrefs(page)
    await seedFeed(page, [])
    await healthyGitSync(page)
    await routeHealth(page)
    await loadApp(page)
    await expect(settingsDot(page)).toHaveAttribute('data-kind', 'warn', { timeout: 20_000 })
    await expect(bell(page)).toHaveAttribute('aria-label', HOSTS_REASON)
    await openSystemHosts(page)
    // Rows start closed (dense): Show details puts the row's Open Settings on screen.
    await openRow(systemHostRow(page, 'keybox'))
    await systemHostRow(page, 'keybox').getByTestId('hpb-open-settings').click()
    await expect(page).toHaveURL(/\/settings#rh-host-keybox$/)
    await expect(page.locator('.notification-panel')).toHaveCount(0)
    await expect(page.locator('#rh-host-keybox')).toBeVisible({ timeout: 20_000 })
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
    await expect(settingsDot(page)).toHaveAttribute('data-kind', 'warn')
    await expect(bell(page)).toHaveAttribute('aria-label', HOSTS_REASON)
  })
})

test.describe('local Claude Code: the re-check and the version floor', () => {
  test('HD-9: the sign-in re-check runs with no panel open; the bell lands on All, whose Claude Code notice asks once; signing in clears the dot', async ({ page }) => {
    const h = await bpSetup(page, { hosts: [connected('devbox', 'Dev box')], local: 'sign-in' })
    await goRail(page, 'notes')
    await expect(bell(page)).toHaveAttribute('aria-label', LOCAL_REASON, { timeout: 20_000 })
    const n0 = h.health!.rechecks
    await openBell(page)
    // The rail's picked entry is the shared nav item, aria-current="page" (0a5209345f).
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'page')
    await expect(panelLocalCard(page)).toBeVisible()
    // Only this machine needs a step: no host list in the problems block, and nothing on the
    // Errors badge, since signing in is a first-run step, not a failure (localNoticeIsFailure).
    await expect(problemHosts(page)).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveCount(0)
    await page.waitForTimeout(1500)
    expect(h.health!.rechecks - n0).toBe(1)
    await closePanel(page, 'escape')
    // Signed in from a terminal: the next 15s re-check answers it, with no panel open.
    h.health!.state = 'ready'
    await expect(bellDot(page)).toHaveCount(0, { timeout: 17_000 })
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications')
    const src = fs.readFileSync(path.resolve(process.cwd(), 'web/src/components/common/SetupBanner.tsx'), 'utf-8')
    expect(src).not.toMatch(/setInterval\([^)]*checkLocalClaude/)
  })

  test('HD-10: this machine only outdated: no bell dot, no problems block or Claude Code notice in the panel, no Errors or System count; outdated plus a signed-out and an unreachable host: the problems block lists the hosts only', async ({ page, browser }) => {
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box')], local: 'outdated' })
    await page.waitForTimeout(1500)
    await expect(bellDot(page)).toHaveCount(0)
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications')
    await openBell(page)
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'page')
    // An old Claude Code here is never a notice.
    await expect(panelProblems(page)).toHaveCount(0)
    await expect(panelLocalCard(page)).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveCount(0)
    await pickRail(page, 'System')
    await expect(panelLocalCard(page)).toHaveCount(0)
    await expect(systemBadge(page)).toHaveCount(0)
    const ctx = await browser.newContext()
    const page2 = await ctx.newPage()
    try {
      await bpSetup(page2, { hosts: [signedOut('signbox', 'Sign box'), failed('netbox', 'Net box', 'unreachable')], local: 'outdated' })
      await openProblems(page2)
      // The unreachable host is Walnut Health's: no row here, only the signed-out one.
      await expect(problemRow(page2, 'signbox')).toBeVisible()
      await expect(problemRow(page2, 'netbox')).toHaveCount(0)
      await expect(panelLocalCard(page2)).toHaveCount(0)
      await expect(panelProblems(page2).locator('[data-testid="setup-banner-outdated"]')).toHaveCount(0)
      await expect(bell(page2)).toHaveAttribute('aria-label', HOSTS_REASON)
    } finally {
      await ctx.close()
    }
  })
})
