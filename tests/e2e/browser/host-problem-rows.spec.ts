/**
 * The notification panel's host problem rows (NotificationProblems, the
 * problems block leading All and the all-errors view): which hosts take a row,
 * their order, this machine's Claude Code notice before them, one row per host
 * with no cap, the row x and its dismiss keys, live clearing, reconnect rows and
 * ui-prefs sync. Buttons and receipts live in host-problem-row-actions.spec.ts.
 * No card on the page carries a host problem (host-attention.ts).
 *
 * Readiness rows are only the kinds in BANNER_READINESS_KINDS (signed out,
 * missing, needs Node, broken): a Claude Code that is merely too old for one
 * model (claude_outdated) takes no row. It still shows in the picker note
 * (host-problems-draft.spec.ts), the Start gate and Settings.
 *
 * Host statuses are served the way the server shapes them: the hydrate is
 * answered through page.route and every change is a `host:status` frame
 * dispatched on the app's own socket, so no remote host (and no ssh) is
 * involved. Local Claude Code states come from a routed /api/system/health,
 * which lists the routed hosts (the panel lists configured hosts only).
 * page.goto only loads the app; everything else is a real click or key.
 *
 * The last describe runs against the SERVER's host fixture instead (no routing),
 * so /api/hosts/status is the real server answer.
 *
 * Run: walnut-dev run bun x playwright test tests/e2e/browser/host-problem-rows.spec.ts --project chromium-host-fixture --retries=0
 */
import { test, expect, type Page } from '@playwright/test'
import {
  DISMISS_KEY, Hosts, base, connected, connecting, failed, isolatePrefs, loadHome, now, outdated,
  reconnecting, resetServerHostFixture, routeHealth, setup, signedOut, storedKeys, type HS, type LocalState,
} from './host-problems-helpers'
import { loadApp, loadFixture, wireHost } from './host-problems-fixture-helpers'
import {
  FIXTURE_ORDER, closePanel, errorsBadge, hostRowsOutsidePanel, openProblems, openSystemHosts, panelLocalCard, panelProblems,
  problemHosts, problemRow, problemRowHosts, seedFeed, systemHostRow,
} from './host-attention-helpers'

test.beforeAll(async ({ request }) => { await resetServerHostFixture(request) })
test.beforeEach(async ({ page }) => { await seedFeed(page, []) })

/** Home with the routed hosts, listed in the health as configured hosts (the panel lists those only). */
const load = (page: Page, hosts: HS[], local?: LocalState): Promise<Hosts> => setup(page, hosts, local, { listHosts: true })

/** No Claude Code on the host: a readiness row. */
const missing = (host: string, label: string): HS => connected(host, label, {
  problems: [{ kind: 'claude_missing', message: `Claude Code is not installed on ${label}.`, commands: [] }],
  claude: { minVersion: '2.1.280', found: false },
})
/** Signed out, judged against another floor (the floor is part of the dismiss key). */
const signedOutAtFloor = (host: string, label: string, minVersion: string): HS => {
  const s = signedOut(host, label)
  return { ...s, readiness: { ...s.readiness!, claude: { ...s.readiness!.claude, minVersion } } }
}

test.describe('host problem rows: which hosts, in which order', () => {
  test('healthy, connecting and merely outdated hosts take no row; connect failures lead; no row outside the panel (C13, C15, C74)', async ({ page }) => {
    await load(page, [
      connected('devbox', 'Dev box'), signedOut('signbox', 'Sign box'), outdated('buildbox', 'Build box'),
      failed('netbox', 'Net box', 'unreachable'), connecting('cbox', 'Connecting box'),
    ])
    await expect(hostRowsOutsidePanel(page)).toHaveCount(0)
    await openProblems(page)
    // Connect failures first, readiness second; a version floor for one model is not a problem (BANNER_READINESS_KINDS).
    await expect.poll(() => problemRowHosts(page)).toEqual(['netbox', 'signbox'])
    for (const host of ['devbox', 'cbox', 'buildbox']) await expect(problemRow(page, host), host).toHaveCount(0)
    // The readiness row names its host once (in the server's sentence), with no label chip.
    const sign = problemRow(page, 'signbox')
    const text = await sign.locator('.hpb-body').innerText()
    expect(text.split('Sign box').length - 1).toBe(1)
    await expect(sign.locator('.hpb-label, .host-connect-label')).toHaveCount(0)
    await expect(sign).toHaveAttribute('data-type', 'readiness')
    await expect(sign).toHaveAttribute('data-kind', 'claude_not_logged_in')
    await expect(hostRowsOutsidePanel(page)).toHaveCount(0)
  })

  test('local sign-in + host problems: the Claude Code notice leads the problems block, the Remote hosts list follows (C14)', async ({ page }) => {
    await load(page, [signedOut('signbox', 'Sign box')], 'sign-in')
    await openProblems(page)
    const local = panelLocalCard(page)
    await expect(local.locator('[data-testid="setup-banner-sign-in"]')).toBeVisible()
    const order = await panelProblems(page).evaluate((el) => {
      const l = el.querySelector('[data-testid="nfc-local-claude"]')!
      const hosts = el.querySelector('[data-testid="nfc-problem-hosts"]')!
      return !!(l.compareDocumentPosition(hosts) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(order).toBe(true)
    await expect(problemRow(page, 'signbox')).toHaveAttribute('data-kind', 'claude_not_logged_in')
    await expect(local.getByRole('button', { name: 'Dismiss Claude Code notice' })).toBeVisible()
  })

  test('5 problems: 5 rows, one per host, no "and N more" (C16)', async ({ page }) => {
    await load(page, [
      failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable'),
      failed('proxybox', 'Proxy box', 'proxy'), missing('barebox', 'Bare box'), signedOut('signbox', 'Sign box'),
    ])
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page)).toEqual(['keybox', 'netbox', 'proxybox', 'barebox', 'signbox'])
    await expect(problemHosts(page).locator('.hpb-more')).toHaveCount(0)
  })

  test('hosts waiting on the same login keep one row each, each with its own headline and countdown (C58)', async ({ page }) => {
    await load(page, [
      failed('certbox', 'Cert box', 'cert_expired', { retryAt: now() + 192_000 }),
      failed('certbox2', 'Cert box 2', 'cert_expired', { retryAt: now() + 250_000 }),
    ])
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page)).toEqual(['certbox', 'certbox2'])
    await expect(problemRow(page, 'certbox').locator('.hft-headline')).toHaveText('Could not connect to Cert box: SSH certificate expired')
    await expect(problemRow(page, 'certbox2').locator('.hft-headline')).toHaveText('Could not connect to Cert box 2: SSH certificate expired')
    await expect(problemRow(page, 'certbox').locator('.hft-when')).toHaveText(/^Walnut tries again in 3m /)
    await expect(problemRow(page, 'certbox2').locator('.hft-when')).toHaveText(/^Walnut tries again in 4m /)
    await expect(problemHosts(page).getByRole('button', { name: 'Retry all' })).toHaveCount(0)
  })

  test('a real countdown only where Walnut really retries (C21)', async ({ page }) => {
    await load(page, [
      failed('certbox', 'Cert box', 'cert_expired', { retryAt: now() + 192_000 }),
      failed('netbox', 'Net box', 'unreachable'),
    ])
    await openProblems(page)
    const when = problemRow(page, 'certbox').locator('.hft-when')
    await expect(when).toHaveText(/^Walnut tries again in 3m \d+s$/)
    const secs = (t: string) => { const m = /(\d+)m (\d+)s/.exec(t)!; return Number(m[1]) * 60 + Number(m[2]) }
    const first = secs(await when.innerText())
    await page.waitForTimeout(5000)
    const drop = first - secs(await when.innerText())
    expect(drop).toBeGreaterThanOrEqual(4)
    expect(drop).toBeLessThanOrEqual(6)
    const net = await problemRow(page, 'netbox').innerText()
    expect(net).not.toMatch(/retries by itself|tries again in/)
    expect(await page.locator('body').innerText()).not.toContain('retries by itself')
  })

  test('a reconnect takes a row only after 2 minutes with a known cause (C72)', async ({ page }) => {
    const h = await load(page, [reconnecting('devbox', 'Dev box', 110_000, 'timeout'), signedOut('signbox', 'Sign box')])
    await openProblems(page)
    await expect(problemRow(page, 'signbox')).toBeVisible()
    await expect(problemRow(page, 'devbox')).toHaveCount(0)
    // The same reconnect with no known cause: still no row, however long.
    await h.push(reconnecting('devbox', 'Dev box', 125_000))
    await page.waitForTimeout(300)
    await expect(problemRow(page, 'devbox')).toHaveCount(0)
    // Past 2 minutes with a cause: the row, its last attempt and Connect now.
    await h.push(reconnecting('devbox', 'Dev box', 125_000, 'timeout'))
    const r = problemRow(page, 'devbox')
    await expect(r).toBeVisible({ timeout: 10_000 })
    await expect(r.locator('.hft-headline')).toHaveText('Reconnecting to Dev box')
    await expect(r.locator('.hpb-last')).toHaveText('Last attempt: Connecting to Dev box timed out')
    await expect(r.getByRole('button', { name: 'Connect now' })).toBeVisible()
  })
})

test.describe('host problem rows: dismissal and live clearing', () => {
  test('row x survives a reload; a new floor brings it back; clearing drops the row and the key (C17, C18, C19)', async ({ page }) => {
    const h = await load(page, [signedOut('signbox', 'Sign box'), failed('netbox', 'Net box', 'unreachable')])
    await openProblems(page)
    await problemRow(page, 'signbox').getByRole('button', { name: 'Dismiss Sign box' }).click()
    await expect(problemRow(page, 'signbox')).toHaveCount(0)
    expect(await storedKeys(page)).toContain('signbox|claude_not_logged_in|2.1.280')
    await expect(errorsBadge(page)).toHaveText('1')
    await closePanel(page, 'escape')
    await page.evaluate(() => sessionStorage.setItem('hp-keep', '1'))
    await page.reload()
    await loadHome(page)
    // The stored key holds after the reload: Sign box stays out of the list and the Errors count.
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page)).toEqual(['netbox'])
    await expect(errorsBadge(page)).toHaveText('1')
    await closePanel(page, 'escape')
    // A newer floor is a different problem (the floor is part of the key): the row is back.
    await h.push(signedOutAtFloor('signbox', 'Sign box', '2.1.290'))
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page)).toEqual(['netbox', 'signbox'])
    await expect(errorsBadge(page)).toHaveText('2')
    // Cleared: the row leaves the list, and no stale key is left behind.
    await h.push(connected('signbox', 'Sign box'))
    await expect(problemRow(page, 'signbox')).toHaveCount(0, { timeout: 6000 })
    await expect.poll(async () => (await storedKeys(page)).filter((k) => k.startsWith('signbox|'))).toEqual([])
    await expect(errorsBadge(page)).toHaveText('1')
  })

  test('a dismissed connect row stays hidden through kind flips and short connections, and returns after 10 connected minutes (C81)', async ({ page }) => {
    const h = await load(page, [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')])
    await openProblems(page)
    await problemRow(page, 'netbox').getByRole('button', { name: 'Dismiss Net box' }).click()
    await expect(problemRow(page, 'netbox')).toHaveCount(0)
    for (const kind of ['timeout', 'unreachable', 'timeout']) {
      await h.push(failed('netbox', 'Net box', kind))
      await page.waitForTimeout(150)
      await expect(problemRow(page, 'netbox')).toHaveCount(0)
    }
    await h.push(connected('netbox', 'Net box', undefined, 5 * 60_000))
    await page.waitForTimeout(200)
    await expect(problemRow(page, 'netbox')).toHaveCount(0)
    await h.push(failed('netbox', 'Net box', 'unreachable'))
    await page.waitForTimeout(200)
    await expect(problemRow(page, 'netbox')).toHaveCount(0)
    expect(await storedKeys(page)).toContain('netbox|connect')
    // Ten unbroken connected minutes re-arm it.
    await h.push(connected('netbox', 'Net box', undefined, 10 * 60_000 + 1000))
    await expect.poll(() => storedKeys(page)).not.toContain('netbox|connect')
    await expect(problemRow(page, 'netbox')).toHaveCount(0)
    await h.push(failed('netbox', 'Net box', 'unreachable'))
    await expect(problemRow(page, 'netbox')).toBeVisible()
  })

  test('a dismissal syncs through ui-prefs: a second browser leaves the row out (one fewer on Errors), while its System list still gives the host its row, with no x (C92)', async ({ page, browser }) => {
    const hosts = () => [signedOut('signbox', 'Sign box'), failed('netbox', 'Net box', 'unreachable')]
    await setup(page, hosts(), undefined, { serverPrefs: true, listHosts: true })
    expect(DISMISS_KEY.startsWith('open-walnut-')).toBe(true)
    await openProblems(page)
    // Listen first: the debounced PUT can land before a listener set up after the click.
    const synced = page.waitForResponse((r) => r.url().includes('/api/ui-prefs') && r.request().method() === 'PUT'
      && (r.request().postData() ?? '').includes(DISMISS_KEY), { timeout: 10_000 })
    await problemRow(page, 'signbox').getByRole('button', { name: 'Dismiss Sign box' }).click()
    await synced
    await expect(problemRow(page, 'netbox')).toBeVisible()
    await expect(problemRow(page, 'signbox')).toHaveCount(0)
    const other = await browser.newContext()
    const page2 = await other.newPage()
    await seedFeed(page2, [])
    try {
      const h2 = new Hosts(page2)
      await h2.install(hosts())
      await routeHealth(page2, 'ready', { daemons: () => hosts().map((s) => ({ host: s.host, label: s.label, connected: s.connected })) })
      await loadHome(page2)
      await openProblems(page2)
      await expect(problemRow(page2, 'netbox')).toBeVisible()
      await expect(problemRow(page2, 'signbox')).toHaveCount(0)
      await expect(errorsBadge(page2)).toHaveText('1')
      await closePanel(page2, 'escape')
      // System is the inventory: dismissals never hide a host there.
      await openSystemHosts(page2)
      await expect(systemHostRow(page2, 'signbox')).toBeVisible()
      await expect(systemHostRow(page2, 'signbox').getByRole('button', { name: 'Dismiss Sign box' })).toHaveCount(0)
    } finally {
      // Leave the fixture server's prefs as found.
      const cleared = page.waitForResponse((r) => r.url().includes('/api/ui-prefs') && r.request().method() === 'PUT', { timeout: 10_000 }).catch(() => {})
      await page.evaluate((k) => localStorage.removeItem(k), DISMISS_KEY)
      await cleared
      await other.close()
    }
  })

  test('a removed host leaves the list on its frame (C82)', async ({ page }) => {
    const h = await load(page, [failed('keybox', 'Key box', 'auth'), signedOut('signbox', 'Sign box')])
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page)).toEqual(['keybox', 'signbox'])
    await h.push({ ...base('keybox', 'Key box'), removed: true })
    await expect.poll(() => problemRowHosts(page)).toEqual(['signbox'])
  })
})

/**
 * The server's host-problems fixture (no routing): its frames, and the
 * /api/hosts/status answer, are the real buildHostStatus.
 */
test.describe('host problem rows: a version floor takes no row (server fixture)', () => {
  test.beforeEach(async ({ page }) => { await isolatePrefs(page) })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('Build box (claude_outdated) has no row while /api/hosts/status still reports it; the four problems all show', async ({ page, request }) => {
    await loadFixture(request, 'host-problems')
    await loadApp(page)
    await openProblems(page)
    // Connect failures in Settings order, then the signed-out host.
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(FIXTURE_ORDER)
    await expect(problemRow(page, 'signbox')).toHaveAttribute('data-kind', 'claude_not_logged_in')
    const wire = await wireHost(request, 'buildbox')
    expect(wire.connected).toBe(true)
    expect(wire.readiness!.problems.map((p) => p.kind)).toEqual(['claude_outdated'])
    await expect(problemRow(page, 'buildbox')).toHaveCount(0)
  })
})
