/**
 * The third nitpick round on the attention card, actions and words
 * (BP-R3-N<n>, BP-R3-C<n>): the notification panel takes focus like a dialog
 * on every section (header, rail, then the section; in System the first
 * problem row's control; the panel never holds the card),
 * an undo line is about one row, search keeps the rows, the bell keeps its one
 * dot look, a Retry result keeps the row's height, the System pane says why,
 * one verb for re-checking, and a Retry settles on its own answer only (C23, C48).
 * Host frames and local health are routed client-side (host-problems-helpers.ts).
 *
 * Run: PW_TEST_PORT=35987 PW_IGNORE_LOAD=1 npx playwright test banner-placement-round3 --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35987 PW_IGNORE_LOAD=1 npx playwright test banner-placement-round3 --project=webkit --workers=1
 */
import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import {
  bareLayout, banner, failed, hideTaskPanel, isolatePrefs, resetServerHostFixture, routeHealth, row, showTaskPanel,
} from './host-problems-helpers'
import { bell, loadApp, loadFixture, openBell, panelBanner } from './host-problems-fixture-helpers'
import {
  BP_SHOTS, bellDot, bpSetup, fixtureHosts, healthyGitSync, hostsOf, openSystemHosts, railButton, settingsDot, systemHostRow, systemHosts,
} from './banner-placement-helpers'

test.describe.configure({ timeout: 90_000 })
test.beforeAll(async ({ request }) => {
  fs.mkdirSync(BP_SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})

const TAB = (browserName: string): string => (browserName === 'webkit' ? 'Alt+Tab' : 'Tab')
const where = (page: Page): Promise<string> => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null
  const inPanel = !!a?.closest('.notification-panel')
  return `${inPanel ? 'panel' : 'out'}:${a?.getAttribute('aria-label') || (a?.textContent ?? '').trim().slice(0, 24) || a?.tagName}`
})

test.describe('the notification panel is a dialog for the keyboard (N5)', () => {
  test('BP-R3-N5: Enter on the bell moves focus into the panel (All, no card); Tab goes header, then the rail; Enter on System, then Tab past All reaches the first problem row; it never leaves; Escape returns to the bell', async ({ page, browserName }) => {
    await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    await bell(page).focus()
    await page.keyboard.press('Enter')
    const panel = page.locator('.notification-panel')
    // The dialog contract sits on the panel itself: it holds on All, where there is no card.
    await expect(panel).toHaveAttribute('role', 'dialog')
    await expect(panel).toHaveAttribute('aria-modal', 'true')
    await expect(panel).toHaveAttribute('aria-label', 'Notifications')
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'true')
    await expect(panelBanner(page)).toHaveCount(0)
    await expect.poll(() => where(page)).toMatch(/^panel:/)
    const stops: string[] = []
    for (let i = 0; i < 6; i++) { await page.keyboard.press(TAB(browserName)); stops.push(await where(page)) }
    // Header first (Clear All when the feed has items, Quiet, Close), then the rail from its first entry.
    expect(stops.every((s) => s.startsWith('panel:')), JSON.stringify(stops)).toBe(true)
    const close = stops.indexOf('panel:Close')
    expect(close, JSON.stringify(stops)).toBeGreaterThanOrEqual(0)
    expect(stops[close + 1], JSON.stringify(stops)).toMatch(/^panel:Needs Action/)
    // On along the rail to System, and into it by keyboard.
    for (let i = 0; i < 12 && !(await where(page)).startsWith('panel:System'); i++) await page.keyboard.press(TAB(browserName))
    await expect(railButton(page, 'System')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(railButton(page, 'System')).toHaveAttribute('aria-current', 'true')
    await expect(systemHosts(page).locator('li.hpb-row')).toHaveCount(4, { timeout: 10_000 })
    await expect(panelBanner(page)).toHaveCount(0)
    await page.keyboard.press(TAB(browserName))
    expect(await where(page)).toMatch(/^panel:All/)
    // Settings order: Dev box and Build box are plain lines; Sign box is the first row (Check again).
    await page.keyboard.press(TAB(browserName))
    expect(await where(page)).toBe('panel:Check again')
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="nfc-remote-hosts"] li.hpb-row[data-host="signbox"]'))).toBe(true)
    // Around the end and back: Tab never lands under the overlay.
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press(TAB(browserName))
      expect(await where(page)).toMatch(/^panel:/)
    }
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('sidebar-notification-btn'))).toBe(true)
  })
})

test.describe('undo lines and search (N7, N11)', () => {
  test('BP-R3-N7: dismissing an opened row leaves a line about one row tall, not the opened height', async ({ page }) => {
    await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    const key = row(page, 'keybox')
    await key.getByRole('button', { name: 'Show details' }).click()
    await expect(key.locator('.hft-hint')).toBeVisible()
    const opened = (await key.boundingBox())!.height
    const x = key.getByRole('button', { name: 'Dismiss Key box' })
    await x.click()
    const undo = banner(page).locator('[data-undo-id="row:host:keybox"]')
    await expect(undo).toBeVisible()
    const h = (await undo.boundingBox())!.height
    await banner(page).screenshot({ path: `${BP_SHOTS}/r3-n7-undo.png` })
    expect(opened).toBeGreaterThan(100)
    expect(h).toBeLessThanOrEqual(60)
  })

  test('BP-R3-N11: while searching the card keeps its rows and buttons; nothing is a dead strip', async ({ page }) => {
    await bpSetup(page, { hosts: fixtureHosts(), allTasks: true })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    await page.locator('.todo-search-input').fill('walnut')
    await page.waitForTimeout(400)
    await expect(banner(page)).not.toHaveAttribute('data-collapsed', 'true')
    expect(await hostsOf(banner(page))).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    await expect(row(page, 'keybox').getByTestId('hpb-retry')).toBeVisible()
    await page.locator('.todo-search-input').press('Escape')
    await expect.poll(() => hostsOf(banner(page))).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
  })
})

test.describe('one look, one sentence, one verb (N12, N13, N14, N15)', () => {
  test('BP-R3-N12: the bell dot for hosts is the bell\'s one existing dot (same shape, the rail\'s warn colour); with git sync failing too, that dot speaks for both', async ({ page }) => {
    await bpSetup(page, {
      hosts: fixtureHosts(),
      before: async (p) => {
        await bareLayout(p)
        await p.route('**/api/git-sync/status', (route) => route.fulfill({ json: { protected: false, consecutiveFailures: 0, error: 'git unavailable' } }))
      },
    })
    await expect(settingsDot(page)).toHaveCount(1, { timeout: 20_000 })
    await expect(bellDot(page)).toHaveCount(1)
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
    // The plain dot the bell has always drawn (a bare .notification-badge-dot), and the one it draws now:
    // the same shape and size; for hosts it wears the Settings rail dot's warn colour (round 4, N3-14).
    const plain = await lookOf('.notification-badge-dot.__none')
    const shape = (look: string) => look.split('|').slice(1).join('|')
    expect(shape(await lookOf('.notification-badge-dot'))).toBe(shape(plain))
    const warn = await settingsDot(page).evaluate((e) => getComputedStyle(e.querySelector<HTMLElement>('.hsd') ?? e).backgroundColor)
    expect((await lookOf('.notification-badge-dot')).split('|')[0]).toBe(warn)
    // System has no Dismiss all: the hosts are dismissed on the Home card (the task panel shown for it).
    await showTaskPanel(page)
    await banner(page).getByRole('button', { name: 'Dismiss all' }).click()
    await hideTaskPanel(page)
    // Hosts dismissed, git sync still failing: the same dot, the same look, and its name no longer says hosts.
    await expect(bellDot(page)).toHaveCount(1)
    expect(await lookOf('.notification-badge-dot')).toBe(plain)
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications')
  })

  test('BP-R3-N13: Retry with the same result: the row keeps its height through the result line and after it', async ({ page }) => {
    const h = await bpSetup(page, { hosts: fixtureHosts() })
    h.connectDelayMs = 300
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    const net = row(page, 'netbox')
    const before = Math.round((await net.boundingBox())!.height)
    await page.mouse.move(2, 2)
    await net.getByTestId('hpb-retry').click()
    await expect(net.getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result', { timeout: 10_000 })
    const heights: number[] = []
    for (let i = 0; i < 14; i++) { heights.push(Math.round((await net.boundingBox())!.height)); await page.waitForTimeout(500) }
    await expect(net.getByTestId('hpb-receipt')).toHaveCount(0, { timeout: 5_000 })
    heights.push(Math.round((await net.boundingBox())!.height))
    expect(heights.every((x) => Math.abs(x - before) <= 1), `${before} ${JSON.stringify(heights)}`).toBe(true)
  })

  test('BP-R3-N14: the System pane lists each failed host as its card row, in the card\'s own sentence, not a bare Disconnected', async ({ page, request }) => {
    // The server fixture: the pane's host list comes from the real health answer.
    await loadFixture(request, 'host-problems')
    await isolatePrefs(page)
    await healthyGitSync(page)
    await routeHealth(page)
    await loadApp(page)
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await openBell(page)
    await railButton(page, 'System').click()
    for (const [host, text] of [['keybox', 'Could not connect to Key box'], ['certbox', 'Could not connect to Cert box: SSH certificate expired'], ['netbox', 'Could not connect to Net box']]) {
      const r = systemHostRow(page, host)
      await expect(r.locator('.hft-headline'), host).toHaveText(text, { timeout: 10_000 })
      await expect(r, host).not.toContainText('Disconnected')
      // The Home card (behind the panel) says the same words for the same host.
      await expect(row(page, host).locator('.hft-headline')).toHaveText(text)
    }
  })

  test('BP-R3-N15: one verb for re-checking (Check again, local and hosts); the subhead reads Remote hosts (4)', async ({ page }) => {
    await bpSetup(page, { hosts: fixtureHosts(), local: 'sign-in' })
    await expect(banner(page).locator('[data-testid="setup-banner-check"]')).toHaveText('Check again', { timeout: 20_000 })
    await expect(row(page, 'signbox').getByTestId('hpb-check')).toHaveText('Check again')
    await expect(banner(page).locator('.hpb-subhead-row')).toHaveText(/^Remote hosts\s*\(4\)$/)
    await expect(banner(page).locator('.hpb-subhead-row')).not.toContainText('hosts (4) hosts')
  })
})

test.describe('a Retry settles on its own answer (C23, C48)', () => {
  test('BP-R3-C23: a different result after a frame re-stamped with the old kind: the new sentence, and no same-result line', async ({ page }) => {
    const h = await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    h.connectDelayMs = 1_500
    h.connectAnswer = (host) => (host === 'keybox' ? failed('keybox', 'Key box', 'unreachable') : null)
    await page.mouse.move(2, 2)
    await row(page, 'keybox').getByTestId('hpb-retry').click()
    // The server's push just before its answer: the OLD kind with a fresh `at`.
    await page.waitForTimeout(700)
    await h.push(failed('keybox', 'Key box', 'auth'))
    await expect(row(page, 'keybox')).toHaveAttribute('data-kind', 'unreachable', { timeout: 10_000 })
    await expect(row(page, 'keybox').getByTestId('hpb-receipt')).toHaveCount(0)
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(500)
      await expect(row(page, 'keybox').getByTestId('hpb-receipt')).toHaveCount(0)
    }
  })

  test('BP-R3-C48: connect held 2s, Retry in the task panel, bell and System at 300ms: the System row is pending, one request, and the receipt lands there', async ({ page }) => {
    const h = await bpSetup(page, { hosts: fixtureHosts() })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    h.connectDelayMs = 2_000
    // A frame for this host inside the old 1s slack of the click.
    await h.push(failed('certbox', 'Cert box', 'cert_expired'))
    await page.mouse.move(2, 2)
    await row(page, 'certbox').getByTestId('hpb-retry').click()
    await page.waitForTimeout(300)
    await openSystemHosts(page)
    const pr = systemHostRow(page, 'certbox')
    const retry = pr.getByTestId('hpb-retry')
    await expect(retry).toHaveText('Retrying...')
    await expect(retry).toBeDisabled()
    await retry.click({ force: true }).catch(() => {})
    await expect(pr.getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result', { timeout: 10_000 })
    expect(h.connects.get('certbox')).toBe(1)
  })
})
