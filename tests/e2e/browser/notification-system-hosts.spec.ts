/**
 * The notification panel's System section lists every host once (its Remote
 * hosts block): a problem host is the Home card's own row (dense: the same
 * headline, primary button and Show details, and no x), every other host a
 * plain status line; this machine's Claude Code notice leads the section while
 * it shows. The panel never renders the attention card, on any section.
 * Host frames and local health are routed client-side (host-problems-helpers.ts);
 * NSH-a (server) and NSH-d use the server's host fixture, so the health and
 * Settings list the hosts from the server's own config.
 *
 * Run: PW_TEST_PORT=3495 PW_IGNORE_LOAD=1 npx playwright test notification-system-hosts --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=3495 PW_IGNORE_LOAD=1 npx playwright test notification-system-hosts --project=webkit --workers=1
 */
import fs from 'node:fs'
import { test, expect, type Locator } from '@playwright/test'
import { HINTS, banner, connected, failed, isolatePrefs, resetServerHostFixture, routeHealth, row } from './host-problems-helpers'
import { hostRow, loadApp, loadFixture, openBell, panelBanner } from './host-problems-fixture-helpers'
import {
  FIXTURE_ORDER, bpSetup, closePanel, expectTasksCard, healthyGitSync, hostErrorRecord, maxCards, openRow, openSystemHosts,
  panelMount, pickRail, railButton, systemHostLine, systemHostRow, systemHosts, systemListHosts, systemLocalCard, systemRowHosts,
} from './banner-placement-helpers'

const SHOTS = '/tmp/walnut-nfc-system/shots'
const SECTIONS = ['Needs Action', 'Inbox', 'Errors', 'Automation', 'System', 'All']
/** The Settings order of fixtureHosts(), which is the System list's order. */
const LISTED = ['devbox', 'buildbox', 'signbox', 'keybox', 'certbox', 'netbox']
const PROBLEM_ROWS = ['signbox', 'keybox', 'certbox', 'netbox']

test.describe.configure({ timeout: 90_000 })
test.beforeAll(async ({ request }) => {
  fs.mkdirSync(SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})
test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })
// A health or feed fetch still in flight when the page closes must not fail the test.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

/** What a person reads on a row: its headline, its buttons, its toggles, and its form. */
const words = (r: Locator) => r.evaluate((el) => ({
  headline: (el.querySelector('.hft-headline, .hpb-headline')?.textContent ?? '').trim(),
  buttons: Array.from(el.querySelectorAll('.hpb-actions button')).map((b) => (b.textContent ?? '').trim()),
  details: Array.from(el.querySelectorAll('.hft-details')).map((b) => (b.textContent ?? '').trim()),
  dense: el.classList.contains('hpb-dense'),
  open: el.classList.contains('hpb-open'),
}))

test.describe('each host once, no card in the panel (a)', () => {
  test('NSH-a: System lists each host exactly once, and no section of the panel renders an attention card', async ({ page }) => {
    await bpSetup(page, { probe: true })
    await expectTasksCard(page)
    await openBell(page)
    for (const label of SECTIONS) {
      await pickRail(page, label)
      await expect(page.locator('.notification-panel [data-testid="attention-banner"]'), label).toHaveCount(0)
      await expect(panelMount(page), label).toHaveCount(0)
    }
    await pickRail(page, 'System')
    await expect.poll(() => systemListHosts(page)).toEqual(LISTED)
    // One entry per host in the whole panel: no second list, no card rows.
    for (const host of LISTED) await expect(page.locator(`.notification-panel li[data-host="${host}"]`), host).toHaveCount(1)
    expect(await systemRowHosts(page)).toEqual(PROBLEM_ROWS)
    // The page only ever held the Home card.
    expect(await maxCards(page)).toBe(1)
  })

  test('NSH-a (server fixture): the Remote hosts block names each configured host exactly once; still no card on any section', async ({ page, request }) => {
    await isolatePrefs(page)
    await healthyGitSync(page)
    await routeHealth(page)
    await loadFixture(request, 'host-problems')
    await loadApp(page)
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await openSystemHosts(page)
    await expect.poll(() => systemRowHosts(page), { timeout: 20_000 }).toEqual(PROBLEM_ROWS)
    const listed = await systemListHosts(page)
    for (const host of LISTED) expect(listed.filter((h) => h === host), host).toHaveLength(1)
    expect(new Set(listed).size).toBe(listed.length)
    for (const label of SECTIONS) {
      await pickRail(page, label)
      await expect(panelBanner(page), label).toHaveCount(0)
    }
  })
})

test.describe('a System row is the Home card row (b)', () => {
  test('NSH-b: a problem row in System has the Home card row\'s headline, primary button and Show details; Show details there reveals the hint and Open Settings; a healthy line has no toggle', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await bpSetup(page)
    await expectTasksCard(page)
    const home: Record<string, Awaited<ReturnType<typeof words>>> = {}
    for (const host of FIXTURE_ORDER) home[host] = await words(row(page, host))
    await openSystemHosts(page)
    for (const host of FIXTURE_ORDER) {
      const mine = await words(systemHostRow(page, host))
      expect(mine, host).toEqual(home[host])
      // Dense and folded, as on the card: the headline, ONE primary button, then Show details.
      expect(mine, host).toMatchObject({ dense: true, open: false, details: ['Show details'] })
      expect(mine.buttons, host).toHaveLength(1)
    }
    await page.mouse.move(2, 2)
    await page.locator('.notification-panel').screenshot({ path: `${SHOTS}/system-collapsed-${browserName}.png` })
    // Show details in System: the hint and Open Settings. One flag per row id, so the card's row opens too.
    const key = systemHostRow(page, 'keybox')
    await key.getByRole('button', { name: 'Show details' }).click()
    await expect(key).toHaveClass(/hpb-open/)
    await expect(key.locator('.hft-hint')).toHaveText(HINTS.auth)
    await expect(key.getByTestId('hpb-open-settings')).toBeVisible()
    await expect(row(page, 'keybox')).toHaveClass(/hpb-open/)
    expect(await words(key)).toEqual(await words(row(page, 'keybox')))
    await page.mouse.move(2, 2)
    await page.locator('.notification-panel').screenshot({ path: `${SHOTS}/system-row-expanded-${browserName}.png` })
    // A readiness row opens onto the rest of its message and Open Settings.
    const sign = systemHostRow(page, 'signbox')
    await sign.getByRole('button', { name: 'Show details' }).click()
    await expect(sign.locator('.hpb-rest')).toBeVisible()
    await expect(sign.getByTestId('hpb-open-settings')).toBeVisible()
    await expect(sign.getByRole('button', { name: 'Hide details' })).toBeVisible()
    // Healthy and merely outdated hosts: a plain line, no button, no toggle.
    for (const host of ['devbox', 'buildbox']) {
      await expect(systemHostLine(page, host), host).toBeVisible()
      await expect(systemHostLine(page, host).locator('button, .hft-details'), host).toHaveCount(0)
    }
  })

  test('NSH-g: System has no x and no Dismiss all, folded or open; only the Claude Code card keeps its own x', async ({ page }) => {
    await bpSetup(page, { local: 'sign-in' })
    await expectTasksCard(page)
    await openSystemHosts(page)
    const detail = page.locator('.notification-panel .nfc-detail')
    const noDismiss = async (when: string) => {
      await expect(page.locator('.notification-panel').getByRole('button', { name: 'Dismiss all' }), when).toHaveCount(0)
      await expect(page.locator('.notification-panel').locator('.hpb-x, .ab-dismiss-all'), when).toHaveCount(0)
      await expect(systemHosts(page).getByRole('button', { name: /^Dismiss / }), when).toHaveCount(0)
    }
    await noDismiss('folded')
    for (const host of PROBLEM_ROWS) await openRow(systemHostRow(page, host))
    await noDismiss('open')
    await expect(detail.getByRole('button', { name: /^Dismiss / })).toHaveCount(1)
    await expect(systemLocalCard(page).getByRole('button', { name: 'Dismiss Claude Code notice' })).toBeVisible()
  })
})

test.describe('one attempt, Open Settings, Shown in System (c, d, e)', () => {
  test('NSH-c: Retry in a System row starts the attempt; the Home card shows the same attempt; one connect request answers both', async ({ page }) => {
    const h = await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable'), failed('keybox', 'Key box', 'auth')] })
    await expectTasksCard(page, ['netbox', 'keybox'])
    h.connectDelayMs = 2000
    h.connectAnswer = (host) => failed(host, 'Net box', 'unreachable')
    await openSystemHosts(page)
    const sys = systemHostRow(page, 'netbox')
    await sys.getByTestId('hpb-retry').click()
    await expect(sys).toContainText('Connecting to Net box...')
    await expect(sys.getByTestId('hpb-retry')).toBeDisabled()
    // The Home card behind the panel reads the same attempt, before the server answers.
    await expect(row(page, 'netbox')).toContainText('Connecting to Net box...')
    await expect(row(page, 'netbox').getByTestId('hpb-retry')).toBeDisabled()
    await expect(sys.getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result', { timeout: 10_000 })
    await expect(row(page, 'netbox').getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result')
    expect(h.connects.get('netbox')).toBe(1)
    // The same the other way: a Retry on the Home card is the System row's attempt.
    await closePanel(page, 'escape')
    await expect(row(page, 'netbox').getByTestId('hpb-receipt')).toHaveCount(0, { timeout: 10_000 })
    await row(page, 'netbox').getByTestId('hpb-retry').click()
    await openSystemHosts(page)
    await expect(systemHostRow(page, 'netbox')).toContainText('Connecting to Net box...')
    await expect(systemHostRow(page, 'netbox').getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result', { timeout: 10_000 })
    expect(h.connects.get('netbox')).toBe(2)
  })

  test('NSH-d: Open Settings in a System row (a readiness problem) closes the panel, then lands on #rh-host-signbox', async ({ page, request }) => {
    await isolatePrefs(page)
    await healthyGitSync(page)
    await routeHealth(page)
    await loadFixture(request, 'host-problems')
    await loadApp(page)
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await openSystemHosts(page)
    await openRow(systemHostRow(page, 'signbox'))
    await systemHostRow(page, 'signbox').getByTestId('hpb-open-settings').click()
    await expect(page.locator('.notification-panel')).toHaveCount(0)
    await expect(page).toHaveURL(/\/settings#rh-host-signbox$/)
    await expect(hostRow(page, 'signbox')).toBeVisible({ timeout: 20_000 })
    await expect(hostRow(page, 'signbox')).toBeInViewport()
  })

  test('NSH-e: Shown in System opens System with the host\'s row open, scrolled into view and focused, once per click', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 })
    const hosts = [...Array.from({ length: 9 }, (_, i) => failed(`box${i + 1}`, `Box ${i + 1}`, 'unreachable')), failed('lastbox', 'Last box', 'auth')]
    const h = await bpSetup(page, { hosts, feed: [hostErrorRecord('lastbox', 1), hostErrorRecord('lastbox', 2)] })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await openBell(page)
    await pickRail(page, 'Errors')
    const link = page.locator('.notification-panel .nfc-cat-title[data-cause-key="host:lastbox"] .nfc-cat-shown-link')
    await expect(link).toHaveText('Shown in System')
    await link.click()
    await expect(railButton(page, 'System')).toHaveAttribute('aria-current', 'true')
    const last = systemHostRow(page, 'lastbox')
    await expect(last).toHaveClass(/hpb-open/)
    await expect(last.getByTestId('hpb-open-settings')).toBeVisible()
    // The link went with Errors: the keyboard lands on the row's own details toggle.
    await expect(last.getByRole('button', { name: 'Hide details' })).toBeFocused()
    // The list is taller than the panel: the section scrolled to bring the row whole into its view.
    const seen = await last.evaluate((el) => {
      let sc: HTMLElement | null = el.parentElement
      while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight + 1)) sc = sc.parentElement
      if (!sc) return { scroller: false, scrollTop: 0, whole: false }
      sc.setAttribute('data-nsh-scroller', '1')
      const b = sc.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      return { scroller: true, scrollTop: sc.scrollTop, whole: r.top >= b.top - 1 && r.bottom <= b.bottom + 1 }
    })
    expect(seen.scroller, 'the System section scrolls at this size').toBe(true)
    expect(seen.scrollTop).toBeGreaterThan(0)
    expect(seen.whole).toBe(true)
    await expect(last).toBeInViewport()
    // Once per click: scrolled back up by hand, a later frame for the host does not pull the list down again.
    const scroller = page.locator('[data-nsh-scroller="1"]')
    await scroller.evaluate((el) => { el.scrollTop = 0 })
    await h.push(failed('lastbox', 'Last box', 'auth'))
    await page.waitForTimeout(500)
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0)
    // A second click does it again.
    await pickRail(page, 'Errors')
    await link.click()
    await expect(railButton(page, 'System')).toHaveAttribute('aria-current', 'true')
    await expect(systemHostRow(page, 'lastbox')).toBeInViewport()
    await expect(systemHostRow(page, 'lastbox').getByRole('button', { name: 'Hide details' })).toBeFocused()
  })
})

test.describe('this machine\'s Claude Code in System (f)', () => {
  test('NSH-f: the Claude Code card leads System only while the local notice shows', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const h = await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), failed('netbox', 'Net box', 'unreachable')], local: 'sign-in' })
    await expect(banner(page).locator('[data-testid="setup-banner-sign-in"]')).toBeVisible({ timeout: 20_000 })
    await openSystemHosts(page)
    const local = systemLocalCard(page)
    await expect(local).toBeVisible()
    await expect(local).toHaveClass(/\bnotification-card\b/)
    await expect(local.locator('.notification-card-label')).toHaveText('Claude Code')
    await expect(local).toHaveAttribute('data-kind', 'sign-in')
    await expect(local).toContainText('not signed in')
    expect(await local.evaluate((el) => el.closest('.nfc-detail')?.querySelector('.notification-card') === el), 'the first System block').toBe(true)
    await page.mouse.move(2, 2)
    await page.locator('.notification-panel').screenshot({ path: `${SHOTS}/system-local-card-${browserName}.png` })
    // Signed in from a terminal: the card leaves System with the notice; the hosts stay.
    await h.health!.set('ready')
    await expect(local).toHaveCount(0, { timeout: 10_000 })
    await expect(systemHostRow(page, 'netbox')).toBeVisible()
    // Signed out again: back at the top.
    await h.health!.set('sign-in')
    await expect(local).toBeVisible({ timeout: 10_000 })
    // Too old for one model is never a notice: no card.
    await h.health!.set('outdated')
    await expect(local).toHaveCount(0, { timeout: 10_000 })
  })
})
