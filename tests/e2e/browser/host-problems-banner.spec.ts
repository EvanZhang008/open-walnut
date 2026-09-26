/**
 * The ONE home attention banner for remote hosts (spec section 3): which hosts
 * take a row, the card title, the cap, dismissal keys, live clearing, merged
 * credential rows, reconnect rows, the height cap and ui-prefs sync.
 * Buttons, keyboard order and rows that hold their place live in
 * host-problems-banner-actions.spec.ts.
 *
 * The card lives in the task panel (data-mount="tasks") in the default layout;
 * the slot variants (C65, C43, C64) hide the task panel first (slotLayout), so
 * the card falls back to the Ask Walnut slot.
 *
 * Readiness rows are only the kinds in BANNER_READINESS_KINDS (signed out,
 * missing, needs Node, broken): a Claude Code that is merely too old for one
 * model (claude_outdated) takes no banner row. It still shows in the picker
 * note (host-problems-draft.spec.ts), the Start gate and Settings.
 *
 * Host statuses are served the way the server shapes them: the hydrate is
 * answered through page.route and every change is a `host:status` frame
 * dispatched on the app's own socket, so no remote host (and no ssh) is
 * involved. Button requests (connect, check) are answered through page.route
 * too. Local Claude Code states come from a routed /api/system/health.
 * page.goto only loads the app; everything else is a real click or key.
 *
 * The last describe runs against the SERVER's host fixture instead (no routing),
 * so /api/hosts/status is the real server answer.
 *
 * Run: PW_TEST_PORT=35991 npx playwright test host-problems-banner --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35991 npx playwright test host-problems-banner --project=webkit --workers=1
 */
import { test, expect, type Locator } from '@playwright/test'
import {
  DISMISS_KEY, Hosts, SHOTS, banner, base, connected, connecting, failed, isolatePrefs, loadHome, now, outdated,
  reconnecting, resetServerHostFixture, routeHealth, row, rows, setup, signedOut, slotLayout, storedKeys, type HS,
} from './host-problems-helpers'
import { bannerRow, loadApp, loadFixture, openBell, panelBanner, slotBanner, wireHost } from './host-problems-fixture-helpers'

test.beforeAll(async ({ request }) => { await resetServerHostFixture(request) })

/** No Claude Code on the host: a banner readiness row. */
const missing = (host: string, label: string): HS => connected(host, label, {
  problems: [{ kind: 'claude_missing', message: `Claude Code is not installed on ${label}.`, commands: [] }],
  claude: { minVersion: '2.1.280', found: false },
})
/** Signed out, judged against another floor (the floor is part of the dismiss key). */
const signedOutAtFloor = (host: string, label: string, minVersion: string): HS => {
  const s = signedOut(host, label)
  return { ...s, readiness: { ...s.readiness!, claude: { ...s.readiness!.claude, minVersion } } }
}

test.describe('home attention banner: which hosts, which title', () => {
  test('host-only problems: one card titled Remote hosts need attention; healthy, connecting and merely outdated hosts take no row (C13, C15, C74)', async ({ page }) => {
    await setup(page, [
      connected('devbox', 'Dev box'), signedOut('signbox', 'Sign box'), outdated('buildbox', 'Build box'),
      failed('netbox', 'Net box', 'unreachable'), connecting('cbox', 'Connecting box'),
    ])
    await expect(banner(page)).toHaveCount(1)
    await expect(page.locator('[data-testid="attention-banner"]')).toHaveCount(1)
    await expect(page.locator('.host-connect-banner')).toHaveCount(0)
    await expect(banner(page).locator('.setup-banner-title')).toHaveText('Remote hosts need attention')
    await expect(row(page, 'devbox')).toHaveCount(0)
    await expect(row(page, 'cbox')).toHaveCount(0)
    // A version floor for one model is not a banner problem (BANNER_READINESS_KINDS).
    await expect(row(page, 'buildbox')).toHaveCount(0)
    // Connect failures first, readiness second.
    await expect(rows(page)).toHaveCount(2)
    expect(await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-host')))).toEqual(['netbox', 'signbox'])
    // The readiness row names its host once (in the server's sentence), with no label chip.
    const text = await row(page, 'signbox').locator('.hpb-body').innerText()
    expect(text.split('Sign box').length - 1).toBe(1)
    await expect(row(page, 'signbox').locator('.hpb-label, .host-connect-label')).toHaveCount(0)
    await expect(row(page, 'signbox')).toHaveAttribute('data-type', 'readiness')
    await expect(row(page, 'signbox')).toHaveAttribute('data-kind', 'claude_not_logged_in')
    await banner(page).screenshot({ path: `${SHOTS}/banner-host-only.png` })
  })

  // (This machine's claude_outdated takes no section, the same rule as a host's: BP-C50.)
  test('local sign-in + host problems: one card, local title, Remote hosts subhead after the local section (C14)', async ({ page }) => {
    await setup(page, [signedOut('signbox', 'Sign box')], 'sign-in')
    await expect(banner(page)).toHaveCount(1)
    await expect(banner(page).locator('.setup-banner-title').first()).toHaveText('Sign in to Claude Code')
    await expect(banner(page).locator('.hpb-subhead')).toHaveText('Remote hosts')
    const order = await banner(page).evaluate((el) => {
      const local = el.querySelector('[data-testid="setup-banner-sign-in"]')!
      const hosts = el.querySelector('[data-testid="host-problems"]')!
      return !!(local.compareDocumentPosition(hosts) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(order).toBe(true)
    await expect(row(page, 'signbox')).toHaveAttribute('data-kind', 'claude_not_logged_in')
    await expect(banner(page).getByRole('button', { name: 'Dismiss Claude Code notice' })).toBeVisible()
  })

  test('5 problems: 3 rows and "and 2 more" opening Remote Hosts (C16)', async ({ page }) => {
    await setup(page, [
      failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable'),
      failed('proxybox', 'Proxy box', 'proxy'), missing('barebox', 'Bare box'), signedOut('signbox', 'Sign box'),
    ])
    await expect(rows(page)).toHaveCount(3)
    const more = banner(page).locator('.hpb-more')
    await expect(more).toHaveText('and 2 more')
    await more.click()
    await expect(page).toHaveURL(/\/settings#remote-hosts$/)
  })

  test('exactly 4 problems: 4 rows, no more link; one host titles the card; only a ready row: no title (C82)', async ({ page }) => {
    const h = await setup(page, [
      failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable'),
      failed('proxybox', 'Proxy box', 'proxy'), signedOut('signbox', 'Sign box'),
    ])
    await expect(rows(page)).toHaveCount(4)
    await expect(banner(page).locator('.hpb-more')).toHaveCount(0)
    for (const host of ['keybox', 'netbox', 'proxybox']) await h.push({ ...base(host, host), removed: true })
    await expect(rows(page)).toHaveCount(1)
    await expect(banner(page).locator('.setup-banner-title')).toHaveText('Sign box needs attention')
    await h.push(connected('signbox', 'Sign box'))
    await expect(row(page, 'signbox')).toHaveText(/^(\u2713 )?Sign box is ready \(Claude Code 2\.1\.281\)$/)
    await expect(banner(page).locator('.setup-banner-title')).toHaveCount(0)
    await expect(banner(page)).toHaveCount(0, { timeout: 6000 })
  })
})

test.describe('home attention banner: dismissal and live clearing', () => {
  test('row x survives a reload; a new floor brings it back; clearing shows the ready row and drops the key (C17, C18, C19)', async ({ page }) => {
    const h = await setup(page, [signedOut('signbox', 'Sign box'), failed('netbox', 'Net box', 'unreachable')])
    await row(page, 'signbox').getByRole('button', { name: 'Dismiss Sign box' }).click()
    await expect(row(page, 'signbox')).toHaveCount(0)
    expect(await storedKeys(page)).toContain('signbox|claude_not_logged_in|2.1.280')
    // Off the task panel: a card height change waits while the pointer is over the list.
    await page.mouse.move(2, 2)
    await page.evaluate(() => sessionStorage.setItem('hp-keep', '1'))
    await page.reload()
    await loadHome(page)
    await expect(row(page, 'netbox')).toBeVisible()
    await expect(row(page, 'signbox')).toHaveCount(0)
    // A newer floor is a different problem (the floor is part of the key): the row is back.
    await h.push(signedOutAtFloor('signbox', 'Sign box', '2.1.290'))
    await expect(row(page, 'signbox')).toBeVisible()
    // Cleared: the one success sentence for about 3s, then gone, and no stale key.
    // (Pointer off the card first: a row under the hand waits for it to leave.)
    await page.mouse.move(2, 2)
    await h.push(connected('signbox', 'Sign box'))
    await expect(row(page, 'signbox')).toHaveText(/^(\u2713 )?Sign box is ready \(Claude Code /)
    await expect(row(page, 'signbox')).toHaveCount(0, { timeout: 6000 })
    expect((await storedKeys(page)).filter((k) => k.startsWith('signbox|'))).toEqual([])
  })

  test('a real countdown only where Walnut really retries (C21)', async ({ page }) => {
    await setup(page, [
      failed('certbox', 'Cert box', 'cert_expired', { retryAt: now() + 192_000 }),
      failed('netbox', 'Net box', 'unreachable'),
    ])
    const when = row(page, 'certbox').locator('.hft-when')
    await expect(when).toHaveText(/^Walnut tries again in 3m \d+s$/)
    const secs = (t: string) => { const m = /(\d+)m (\d+)s/.exec(t)!; return Number(m[1]) * 60 + Number(m[2]) }
    const first = secs(await when.innerText())
    await page.waitForTimeout(5000)
    const drop = first - secs(await when.innerText())
    expect(drop).toBeGreaterThanOrEqual(4)
    expect(drop).toBeLessThanOrEqual(6)
    const net = await row(page, 'netbox').innerText()
    expect(net).not.toMatch(/retries by itself|tries again in/)
    expect(await page.locator('body').innerText()).not.toContain('retries by itself')
  })

  test('hosts waiting on the same login share one row with Retry all (C58)', async ({ page }) => {
    await setup(page, [
      failed('certbox', 'Cert box', 'cert_expired', { retryAt: now() + 192_000 }),
      failed('certbox2', 'Cert box 2', 'cert_expired', { retryAt: now() + 250_000 }),
    ])
    await expect(rows(page)).toHaveCount(1)
    const merged = rows(page).first()
    await expect(merged).toHaveAttribute('data-host', 'certbox certbox2')
    await expect(merged.locator('.hft-headline')).toHaveText('Could not connect to Cert box and Cert box 2: SSH certificate expired')
    await expect(merged.locator('.hft-hint')).toHaveCount(1)
    await expect(merged.getByRole('button', { name: 'Retry all' })).toHaveCount(1)
    await expect(merged.locator('.hft-when')).toHaveText(/^Walnut tries again in 3m /)
    await expect(banner(page).locator('.setup-banner-title')).toHaveText('Remote hosts need attention')
  })

  test('a dismissed connect row stays hidden through kind flips and short connections, and returns after 10 connected minutes (C81)', async ({ page }) => {
    const h = await setup(page, [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')])
    await row(page, 'netbox').getByRole('button', { name: 'Dismiss Net box' }).click()
    await expect(row(page, 'netbox')).toHaveCount(0)
    await page.mouse.move(2, 2)
    for (const kind of ['timeout', 'unreachable', 'timeout']) {
      await h.push(failed('netbox', 'Net box', kind))
      await page.waitForTimeout(150)
      await expect(row(page, 'netbox')).toHaveCount(0)
    }
    await h.push(connected('netbox', 'Net box', undefined, 5 * 60_000))
    await page.waitForTimeout(200)
    await expect(row(page, 'netbox')).toHaveCount(0)
    await h.push(failed('netbox', 'Net box', 'unreachable'))
    await page.waitForTimeout(200)
    await expect(row(page, 'netbox')).toHaveCount(0)
    expect(await storedKeys(page)).toContain('netbox|connect')
    // Ten unbroken connected minutes re-arm it (and a dismissed row never shows a ready row).
    await h.push(connected('netbox', 'Net box', undefined, 10 * 60_000 + 1000))
    await expect.poll(() => storedKeys(page)).not.toContain('netbox|connect')
    await expect(row(page, 'netbox')).toHaveCount(0)
    await h.push(failed('netbox', 'Net box', 'unreachable'))
    await expect(row(page, 'netbox')).toBeVisible()
  })
})

test.describe('home attention banner: reconnects, size, sync', () => {
  test('a reconnect takes a row only after 2 minutes with a known cause (C72)', async ({ page }) => {
    const h = await setup(page, [reconnecting('devbox', 'Dev box', 110_000, 'timeout'), signedOut('signbox', 'Sign box')])
    await expect(row(page, 'signbox')).toBeVisible()
    await expect(row(page, 'devbox')).toHaveCount(0)
    // 10 more seconds of the same reconnect: the banner's own timer brings the row in.
    await h.push(reconnecting('devbox', 'Dev box', 116_000, 'timeout'))
    await expect(row(page, 'devbox')).toHaveCount(0)
    const r = row(page, 'devbox')
    await expect(r).toBeVisible({ timeout: 10_000 })
    await expect(r.locator('.hft-headline')).toHaveText('Reconnecting to Dev box')
    await expect(r.locator('.hpb-last')).toHaveText('Last attempt: Connecting to Dev box timed out')
    await expect(r.getByRole('button', { name: 'Connect now' })).toBeVisible()
  })

  test('900px high window: the host section stays within 40% of the slot and scrolls inside; rows 2+ start collapsed (C65)', async ({ page }) => {
    // The slot's own cap: the task panel hidden, so the card falls back to the slot.
    await page.setViewportSize({ width: 1280, height: 900 })
    await slotLayout(page)
    await setup(page, [
      failed('netbox', 'Net box', 'unreachable'), failed('keybox', 'Key box', 'auth'), failed('proxybox', 'Proxy box', 'proxy'),
    ], 'sign-in')
    const card = slotBanner(page)
    const slotRow = (host: string) => card.locator(`li.hpb-row[data-host="${host}"]`)
    await expect(card).toHaveAttribute('data-mount', 'slot')
    const section = card.locator('[data-testid="host-problems"]')
    await expect(card.locator('li.hpb-row[data-host]')).toHaveCount(3)
    const slotH = await page.locator('.main-page-chat').evaluate((el) => el.getBoundingClientRect().height)
    const secH = (await section.boundingBox())!.height
    expect(secH).toBeLessThanOrEqual(slotH * 0.4 + 1)
    for (const host of ['keybox', 'proxybox']) {
      await expect(slotRow(host).locator('.hft-hint')).toHaveCount(0)
      await expect(slotRow(host).getByRole('button', { name: 'Show details' })).toBeVisible()
    }
    await slotRow('keybox').getByRole('button', { name: 'Show details' }).click()
    await expect(slotRow('keybox').locator('.hft-hint')).toBeVisible()
    await section.locator('.hpb-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(card.getByRole('button', { name: 'Dismiss all' })).toBeInViewport()
    await expect(card.locator('.setup-banner-title').first()).toBeInViewport()
    await card.screenshot({ path: `${SHOTS}/banner-900h-local-plus-3.png` })
  })

  test('900px high window, task panel: the whole card stays within max(40% of the task panel, 132px) and the host section scrolls (C65 tasks)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await setup(page, [
      failed('netbox', 'Net box', 'unreachable'), failed('keybox', 'Key box', 'auth'), failed('proxybox', 'Proxy box', 'proxy'),
    ], 'sign-in')
    const section = banner(page).locator('[data-testid="host-problems"]')
    await expect(rows(page)).toHaveCount(3)
    const panelH = await page.locator('.todo-panel').evaluate((el) => el.getBoundingClientRect().height)
    const cap = Math.max(panelH * 0.4, 132) + 1
    expect((await banner(page).boundingBox())!.height).toBeLessThanOrEqual(cap)
    expect((await section.boundingBox())!.height).toBeLessThanOrEqual(cap)
    for (const host of ['keybox', 'proxybox']) {
      await expect(row(page, host).locator('.hft-hint')).toHaveCount(0)
      await expect(row(page, host).getByRole('button', { name: 'Show details' })).toBeVisible()
    }
    await section.locator('.hpb-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(banner(page).getByRole('button', { name: 'Dismiss all' })).toBeInViewport()
    await expect(banner(page).locator('.setup-banner-title').first()).toBeInViewport()
    await banner(page).screenshot({ path: `${SHOTS}/banner-900h-tasks-local-plus-3.png` })
  })

  /** Actions under the body, the headline in at most 2 whole lines, no sideways scroll. */
  async function expectNarrowLayout(card: Locator, shot: string): Promise<void> {
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    const r = card.locator('li.hpb-row[data-host="certbox"]')
    const head = r.locator('.hft-headline')
    await expect(head).toHaveText('Could not connect to Cert box: SSH certificate expired')
    const lines = await head.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || '16')))
    expect(lines).toBeLessThanOrEqual(2)
    expect(await head.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
    const headBox = (await head.boundingBox())!
    const btnTop = (await r.getByTestId('hpb-retry').boundingBox())!.y
    expect(btnTop).toBeGreaterThanOrEqual(headBox.y + headBox.height - 1)
    for (const scheme of ['dark', 'light'] as const) {
      await card.page().emulateMedia({ colorScheme: scheme })
      await card.screenshot({ path: `${SHOTS}/${shot}-${scheme}.png` })
    }
  }

  test('narrow slot: actions sit under the body, the headline wraps to 2 lines whole, no sideways scroll (C43, C64)', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 900 })
    await slotLayout(page)
    await setup(page, [
      failed('certbox', 'Cert box', 'cert_expired', { retryAt: now() + 192_000 }), signedOut('signbox', 'Sign box'),
    ])
    // The slot at 380px, the width a narrow window leaves it (pinned: the
    // default split at 960px depends on the saved panel widths).
    await page.addStyleTag({ content: '.main-page-chat { flex: 0 0 380px !important; width: 380px !important; min-width: 0 !important; max-width: 380px !important; }' })
    await expect.poll(() => page.locator('.main-page-chat').evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(380)
    await expect(slotBanner(page)).toHaveAttribute('data-mount', 'slot')
    await expectNarrowLayout(slotBanner(page), 'banner-narrow')
  })

  test('narrow task panel (300px in a 980px window): the same narrow layout in the task panel (C43, C64 tasks)', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 800 })
    await setup(page, [
      failed('certbox', 'Cert box', 'cert_expired', { retryAt: now() + 192_000 }), signedOut('signbox', 'Sign box'),
    ])
    await page.addStyleTag({ content: '.main-page-todo { flex: 0 0 300px !important; width: 300px !important; min-width: 0 !important; max-width: 300px !important; }' })
    await expect.poll(() => page.locator('.todo-panel').evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBeLessThanOrEqual(300)
    await expectNarrowLayout(banner(page), 'banner-narrow-tasks')
  })

  test('a dismissal made here is hidden in a second browser too (ui-prefs sync) (C92)', async ({ page, browser }) => {
    await setup(page, [signedOut('signbox', 'Sign box'), failed('netbox', 'Net box', 'unreachable')], undefined, { serverPrefs: true })
    expect(DISMISS_KEY.startsWith('open-walnut-')).toBe(true)
    // Listen first: the debounced PUT can land before a listener set up after the click.
    const synced = page.waitForResponse((r) => r.url().includes('/api/ui-prefs') && r.request().method() === 'PUT'
      && (r.request().postData() ?? '').includes(DISMISS_KEY), { timeout: 10_000 })
    await row(page, 'signbox').getByRole('button', { name: 'Dismiss Sign box' }).click()
    await synced
    const other = await browser.newContext()
    const page2 = await other.newPage()
    try {
      const h2 = new Hosts(page2)
      await h2.install([signedOut('signbox', 'Sign box'), failed('netbox', 'Net box', 'unreachable')])
      await routeHealth(page2)
      await loadHome(page2)
      await expect(row(page2, 'netbox')).toBeVisible()
      await expect(row(page2, 'signbox')).toHaveCount(0)
    } finally {
      // Leave the fixture server's prefs as found.
      const cleared = page.waitForResponse((r) => r.url().includes('/api/ui-prefs') && r.request().method() === 'PUT', { timeout: 10_000 }).catch(() => {})
      await page.evaluate((k) => localStorage.removeItem(k), DISMISS_KEY)
      await cleared
      await other.close()
    }
  })

  test('a dismissal made in the notification panel is hidden in a second browser too (C92 panel)', async ({ page, browser }) => {
    await setup(page, [signedOut('signbox', 'Sign box'), failed('netbox', 'Net box', 'unreachable')], undefined, { serverPrefs: true })
    const synced = page.waitForResponse((r) => r.url().includes('/api/ui-prefs') && r.request().method() === 'PUT'
      && (r.request().postData() ?? '').includes(DISMISS_KEY), { timeout: 10_000 })
    await openBell(page)
    await panelBanner(page).locator('li.hpb-row[data-host="signbox"]').getByRole('button', { name: 'Dismiss Sign box' }).click()
    await synced
    await page.keyboard.press('Escape')
    await expect(row(page, 'netbox')).toBeVisible()
    await expect(row(page, 'signbox')).toHaveCount(0)
    const other = await browser.newContext()
    const page2 = await other.newPage()
    try {
      const h2 = new Hosts(page2)
      await h2.install([signedOut('signbox', 'Sign box'), failed('netbox', 'Net box', 'unreachable')])
      await routeHealth(page2)
      await loadHome(page2)
      await expect(row(page2, 'netbox')).toBeVisible()
      await expect(row(page2, 'signbox')).toHaveCount(0)
    } finally {
      const cleared = page.waitForResponse((r) => r.url().includes('/api/ui-prefs') && r.request().method() === 'PUT', { timeout: 10_000 }).catch(() => {})
      await page.evaluate((k) => localStorage.removeItem(k), DISMISS_KEY)
      await cleared
      await other.close()
    }
  })
})

/**
 * The server's host-problems fixture (no routing): its frames, and the
 * /api/hosts/status answer, are the real buildHostStatus.
 */
test.describe('home attention banner: a version floor takes no row (server fixture)', () => {
  test.beforeEach(async ({ page }) => { await isolatePrefs(page) })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('Build box (claude_outdated) has no row while /api/hosts/status still reports it; the four banner problems all show, no "and N more"', async ({ page, request }) => {
    await loadFixture(request, 'host-problems')
    await loadApp(page)
    const hostsOf = () => banner(page).locator('li.hpb-row[data-host]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-host')))
    // Connect failures in Settings order, then the signed-out host.
    await expect.poll(hostsOf, { timeout: 20_000 }).toEqual(['keybox', 'certbox', 'netbox', 'signbox'])
    await expect(bannerRow(page, 'signbox')).toHaveAttribute('data-kind', 'claude_not_logged_in')
    await expect(banner(page).locator('.hpb-more')).toHaveCount(0)
    await expect(banner(page).locator('.setup-banner-title')).toHaveText('Remote hosts need attention')
    const wire = await wireHost(request, 'buildbox')
    expect(wire.connected).toBe(true)
    expect(wire.readiness!.problems.map((p) => p.kind)).toEqual(['claude_outdated'])
    await expect(bannerRow(page, 'buildbox')).toHaveCount(0)
  })
})
