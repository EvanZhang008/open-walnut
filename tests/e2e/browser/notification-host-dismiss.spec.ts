/**
 * Dismissing a host problem ("I know") in the notification panel: the x on a
 * row of All's problems block writes the dismiss keys (localStorage
 * open-walnut-host-banner-dismissed); the host then leaves the problems block,
 * the Errors count and the dots until its problem changes, and a reload keeps
 * it so. System's host list is the inventory: it ignores dismissals and draws
 * no x. The panel has no Dismiss all. The Claude Code notice has its own x.
 * The always-on pruner expires a key with no panel open, and Settings can
 * bring a hidden row back.
 * Host frames and local health are routed client-side (NH-5 uses the server's
 * host fixture, since Settings lists the server's hosts).
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  DISMISS_KEY, connected, failed, isolatePrefs, loadHome, resetServerHostFixture, signedOut, storedKeys,
} from './host-problems-helpers'
import { bell, hostRow, loadApp, loadFixture, openBell, openRemoteHosts } from './host-problems-fixture-helpers'
import {
  FIXTURE_ORDER, bellDot, boxGap, bpSetup, closePanel, countInFirstFrameAfterClick, errorsBadge, goRail, openProblems, panelLocalCard,
  panelProblems, pickRail, problemHosts, problemRow, problemRowHosts, railButton, settingsDot, systemHostRow, systemHosts, systemRowHosts,
} from './host-attention-helpers'

test.describe.configure({ timeout: 90_000 })

test.beforeAll(async ({ request }) => { await resetServerHostFixture(request) })

const LABELS: Record<string, string> = { keybox: 'Key box', certbox: 'Cert box', netbox: 'Net box', signbox: 'Sign box' }
const rowX = (page: Page, host: string): Locator => problemRow(page, host).getByRole('button', { name: `Dismiss ${LABELS[host]}` })

test.describe('the row x in All\'s problems', () => {
  test('NH-1: a row x is stored and survives a reload; the host leaves All\'s problems and the Errors count before and after it, while System keeps its row (Settings order, no x)', async ({ page }) => {
    await bpSetup(page)
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(FIXTURE_ORDER)
    // Key box: Net box (unreachable) is Walnut Health's and has no row here to dismiss.
    const others = FIXTURE_ORDER.filter((h) => h !== 'keybox')
    await rowX(page, 'keybox').click()
    await expect(problemRow(page, 'keybox')).toHaveCount(0)
    expect(await storedKeys(page)).toContain('keybox|connect')
    await expect.poll(() => problemRowHosts(page)).toEqual(others)
    await expect(errorsBadge(page)).toHaveText(String(others.length))
    await pickRail(page, 'System')
    await expect.poll(() => systemRowHosts(page)).toEqual(['signbox', 'keybox', 'certbox', 'netbox'])
    await expect(systemHostRow(page, 'keybox').getByRole('button', { name: 'Dismiss Key box' })).toHaveCount(0)
    await closePanel(page, 'escape')
    await page.evaluate(() => sessionStorage.setItem('hp-keep', '1'))
    await page.reload()
    await loadHome(page)
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(others)
    await expect(errorsBadge(page)).toHaveText(String(others.length))
  })

  test('NH-2: every problem row has its own titled x and the panel has no Dismiss all, System no x; with every host dismissed All leads with the Claude Code notice alone (no Errors count: signing in is a setup step), the rail Settings dot goes and the bell names Claude Code only, while System still lists every problem host', async ({ page }) => {
    await bpSetup(page, { local: 'sign-in' })
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(FIXTURE_ORDER)
    const panel = page.locator('.notification-panel')
    await expect(panel.getByRole('button', { name: 'Dismiss all' })).toHaveCount(0)
    for (const host of FIXTURE_ORDER) {
      await expect(rowX(page, host), host).toHaveCount(1)
      await expect(rowX(page, host), host).toHaveAttribute('title', `Dismiss ${LABELS[host]}`)
    }
    await pickRail(page, 'System')
    await expect(systemHosts(page).locator('.hpb-x')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Dismiss all' })).toHaveCount(0)
    await pickRail(page, 'All')
    for (const host of FIXTURE_ORDER) {
      await rowX(page, host).click()
      await expect(problemRow(page, host), host).toHaveCount(0)
    }
    await expect(problemHosts(page)).toHaveCount(0)
    await expect(panelLocalCard(page)).toBeVisible()
    await expect(panel.locator('.hpb-undo-row, [data-testid="hpb-undo-row"]')).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveCount(0)
    await pickRail(page, 'System')
    await expect.poll(() => systemRowHosts(page)).toEqual(['signbox', 'keybox', 'certbox', 'netbox'])
    await closePanel(page, 'escape')
    await expect(settingsDot(page)).toHaveCount(0)
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications: Claude Code needs attention')
  })

  test('NH-3: the row x and its neighbours stay apart: every x in the problems list is 24px clear of every other x and of Close, and the Claude Code x keeps 24px from Close', async ({ page }) => {
    await bpSetup(page, {
      // Five problems of the person's (an unreachable host or a broken proxy has no row here).
      hosts: [failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'dns'), failed('proxybox', 'Proxy box', 'proxy_login'),
        failed('lanbox', 'Lan box', 'host_key'), signedOut('signbox', 'Sign box')],
      local: 'sign-in',
    })
    await openProblems(page)
    await expect(problemHosts(page).locator('li.hpb-row[data-host]')).toHaveCount(5)
    const panel = page.locator('.notification-panel')
    const close = (await panel.locator('.notification-panel-close').boundingBox())!
    const xs: Array<{ x: number; y: number; width: number; height: number }> = []
    for (const x of await problemHosts(page).locator('.hpb-x:visible').all()) {
      expect(await x.getAttribute('title')).toBe(await x.getAttribute('aria-label'))
      xs.push((await x.boundingBox())!)
    }
    expect(xs.length).toBe(5)
    for (let i = 0; i < xs.length; i++) {
      expect(boxGap(xs[i], close), `x ${i} vs Close`).toBeGreaterThanOrEqual(24)
      for (let j = i + 1; j < xs.length; j++) expect(boxGap(xs[i], xs[j]), `x ${i} vs x ${j}`).toBeGreaterThanOrEqual(24)
    }
    const localX = panelLocalCard(page).locator('.ab-local-x')
    await expect(localX).toBeVisible()
    // The one x (NoticeClose) says what it does to a screen reader and draws no hover title of its
    // own (the notice's words keep the only tooltip), so no tooltip can disagree with its label.
    expect(await localX.getAttribute('aria-label')).toBe('Dismiss Claude Code notice')
    expect(await localX.getAttribute('title')).toBeNull()
    expect(boxGap((await localX.boundingBox())!, close)).toBeGreaterThanOrEqual(24)
  })

  test('NH-4: Dismiss Claude Code notice in All: the bell dot goes in the next frame, the notice leaves the panel and the Errors count', async ({ page }) => {
    // A Claude Code that does not start: a failure, so its notice counts on Errors (localNoticeIsFailure).
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box')], local: 'broken' })
    await expect(bellDot(page)).toHaveCount(1, { timeout: 20_000 })
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications: Claude Code needs attention')
    await openBell(page)
    // The rail's picked entry is the shared nav item, aria-current="page" (0a5209345f).
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'page')
    await expect(panelLocalCard(page).locator('[data-testid="setup-banner-install"]')).toBeVisible()
    await expect(errorsBadge(page)).toHaveText('1')
    const x = panelLocalCard(page).getByRole('button', { name: 'Dismiss Claude Code notice' })
    expect(await countInFirstFrameAfterClick(page, x, '.sidebar-notification-btn .notification-badge-dot')).toBe(0)
    await expect(panelLocalCard(page)).toHaveCount(0)
    await expect(panelProblems(page)).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveCount(0)
    await closePanel(page, 'escape')
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications')
  })
})

test.describe('expiry and the way back', () => {
  test('NH-5: a dismissed connect row stays out of All on /notes, expires there with no panel open, and the next failure lights the bell and leads All again', async ({ page }) => {
    test.setTimeout(150_000) // the pruner's 60s interval is the slow path
    // A refused key: the person's to clear, so it has a row to dismiss and lights the bell again.
    const h = await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), failed('netbox', 'Net box', 'auth')] })
    await openProblems(page)
    await rowX(page, 'netbox').click()
    expect(await storedKeys(page)).toContain('netbox|connect')
    await closePanel(page, 'escape')
    await goRail(page, 'notes')
    await expect(bellDot(page)).toHaveCount(0)
    // Dismissed: the bell opens on All with nothing leading it and nothing on Errors; System still lists the host.
    await openBell(page)
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'page')
    await expect(panelProblems(page)).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveCount(0)
    await pickRail(page, 'System')
    await expect(systemHostRow(page, 'netbox')).toBeVisible()
    await closePanel(page, 'escape')
    // Connected for 11 minutes: the always-on pruner drops the key on this frame.
    await h.push(connected('netbox', 'Net box', undefined, 11 * 60_000))
    await expect.poll(() => storedKeys(page), { timeout: 65_000 }).not.toContain('netbox|connect')
    await h.push(failed('netbox', 'Net box', 'auth'))
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications: remote hosts need attention', { timeout: 10_000 })
    await expect(bellDot(page)).toHaveCount(1)
    await openProblems(page)
    await expect(problemRow(page, 'netbox')).toBeVisible()
    expect(await storedKeys(page)).not.toContain('netbox|connect')
  })

  test('NH-6 (server fixture): Settings says a dismissed host\'s problem is hidden, with Show it there again beside it, for that host only; it brings the row back into All\'s problems', async ({ page, request }) => {
    await isolatePrefs(page)
    await page.addInitScript((k) => localStorage.removeItem(k), DISMISS_KEY)
    await loadFixture(request, 'host-problems')
    await loadApp(page)
    await openProblems(page)
    await expect(problemRow(page, 'certbox')).toBeVisible({ timeout: 20_000 })
    await rowX(page, 'certbox').click()
    await expect(problemRow(page, 'certbox')).toHaveCount(0)
    await closePanel(page, 'escape')
    await openRemoteHosts(page)
    // Said once, with its way back beside it (2026-11-05 review: the fix was in the row's menu).
    await expect(hostRow(page, 'certbox').getByTestId('rh-banner-hidden')).toContainText('Show it there again')
    await expect(hostRow(page, 'keybox').getByTestId('rh-banner-hidden')).toHaveCount(0)
    await expect(hostRow(page, 'keybox').getByTestId('rh-show-again')).toHaveCount(0)
    // No menu item says it a second time.
    await hostRow(page, 'certbox').getByTestId('rh-row-more').click()
    await expect(page.getByTestId('rh-row-menu').getByRole('menuitem', { name: /Show again/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await hostRow(page, 'certbox').getByTestId('rh-show-again').click()
    await expect(hostRow(page, 'certbox').getByTestId('rh-banner-hidden')).toHaveCount(0)
    // The focus stays on the page, never on body.
    await expect.poll(() => page.evaluate(() => !!document.activeElement && document.activeElement !== document.body)).toBe(true)
    await openProblems(page)
    await expect(problemRow(page, 'certbox')).toBeVisible({ timeout: 20_000 })
    await resetServerHostFixture(request)
  })
})
