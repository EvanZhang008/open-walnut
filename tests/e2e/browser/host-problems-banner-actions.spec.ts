/**
 * The home attention banner's buttons (spec section 3): rows that never move
 * under the hand, stable button widths, Retry / Check again receipts and a
 * keyboard-only path. Same harness as host-problems-banner.spec.ts: the
 * hydrate and button requests go through page.route and every change is a
 * `host:status` frame on the app's own socket, so no remote host is dialed.
 * The last describe drives the same buttons through the SERVER's host fixture.
 *
 * The banner's readiness rows are BANNER_READINESS_KINDS only, so its automatic
 * fix is Install (Claude Code missing or needing Node). Update, the fix for a
 * claude_outdated host, lives in Settings (host-problems-settings.spec.ts).
 *
 * Run: PW_TEST_PORT=35991 npx playwright test host-problems-banner-actions --project=chromium
 *      PW_WEBKIT=1 PW_TEST_PORT=35991 npx playwright test host-problems-banner-actions --project=webkit
 */
import { test, expect, type Page, type Locator } from '@playwright/test'
import {
  banner, connected, connecting, failed, now, resetServerHostFixture, row, rows, setup, signedOut,
  storedKeys, type HS,
} from './host-problems-helpers'
import {
  HEALTHY, bannerRow, fixtureCounters, fixtureFile, hostFixture, isolatePrefs, loadApp, loadFixture,
} from './host-problems-fixture-helpers'

/** A connected host with no Claude Code at all: the server can install it. */
const FIX_FILE = fixtureFile({
  fixbox: { label: 'Fix box', hostname: 'fix.example.com', phase: 'connected', claude: { found: false } },
})

/** No Claude Code on the host: a banner readiness row. */
const missing = (host: string, label: string): HS => connected(host, label, {
  problems: [{ kind: 'claude_missing', message: `Claude Code is not installed on ${label}.`, commands: [] }],
  claude: { minVersion: '2.1.280', found: false },
})

test.beforeAll(async ({ request }) => { await resetServerHostFixture(request) })

test.describe('home attention banner: rows never move under the hand', () => {
  test('an on-screen row that retries by itself stays in place reading Trying again (C61)', async ({ page }) => {
    const h = await setup(page, [failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable')])
    const target = row(page, 'netbox')
    const y0 = (await target.boundingBox())!.y
    const samples: Array<{ y: number | null; text: string }> = []
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        const box = await target.boundingBox().catch(() => null)
        samples.push({ y: box?.y ?? null, text: box ? await target.innerText().catch(() => '') : '' })
        await page.waitForTimeout(100)
      }
    })()
    await page.waitForTimeout(300)
    await h.push(connecting('netbox', 'Net box'))
    await expect(target).toContainText('Trying again...')
    await page.waitForTimeout(800)
    await h.push(failed('netbox', 'Net box', 'unreachable'))
    await expect(target.locator('.hft-headline')).toHaveText('Could not connect to Net box')
    await page.waitForTimeout(300)
    sampling = false
    await sampler
    expect(samples.length).toBeGreaterThan(8)
    for (const s of samples) expect(s.y).toBe(y0)
    expect(samples.some((s) => s.text.includes('Trying again...'))).toBe(true)
  })

  test('Retry holds the row height; with the pointer on the card a new row appends last until it leaves (C62)', async ({ page }) => {
    const h = await setup(page, [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')])
    h.connectDelayMs = 1500
    h.connectAnswer = (host) => failed(host, 'Net box', 'unreachable')
    const target = row(page, 'netbox')
    const before = (await target.boundingBox())!.height
    await target.getByRole('button', { name: 'Retry' }).click()
    await expect(target.getByRole('button', { name: 'Retrying...' })).toBeVisible()
    await h.push(connecting('netbox', 'Net box'))
    for (let i = 0; i < 5; i++) {
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(before - 0.5)
      await page.waitForTimeout(150)
    }
    await expect(target.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 8000 })
    // Let the Retry's own receipt come and go first (off the task panel, so it is not held).
    await page.mouse.move(2, 2)
    await expect(target.getByTestId('hpb-receipt')).toHaveCount(1, { timeout: 12_000 })
    await expect(target.getByTestId('hpb-receipt')).toHaveCount(0, { timeout: 12_000 })
    // Pointer on the card: a new failed host never lands above a row under the
    // hand. In the task panel the whole height change waits for the pointer (at
    // most 10s, spec 5.5); if it shows early, it is appended at the END.
    await banner(page).hover()
    const ySign = (await row(page, 'signbox').boundingBox())!.y
    await h.push(failed('keybox', 'Key box', 'auth'))
    for (let i = 0; i < 12; i++) {
      const order = await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-host')))
      expect([['netbox', 'signbox'], ['netbox', 'signbox', 'keybox']]).toContainEqual(order)
      expect((await row(page, 'signbox').boundingBox())!.y).toBe(ySign)
      await page.waitForTimeout(250)
    }
    // Pointer leaves: the connect failure takes its place in the connect group.
    await page.mouse.move(2, 2)
    await expect.poll(() => rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-host')))).toEqual(['netbox', 'keybox', 'signbox'])
  })

  test('paired labels keep one width: Retry / Retrying..., Check again / Checking..., Copy / Copied (C63)', async ({ page }) => {
    const h = await setup(page, [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')])
    h.connectDelayMs = 1200
    const retry = row(page, 'netbox').getByTestId('hpb-retry')
    const w1 = (await retry.boundingBox())!.width
    await retry.click()
    await expect(retry).toHaveText('Retrying...')
    expect(Math.abs((await retry.boundingBox())!.width - w1)).toBeLessThanOrEqual(1)
    const check = row(page, 'signbox').getByTestId('hpb-check')
    const c1 = (await check.boundingBox())!.width
    await check.click()
    await expect(check).toHaveText('Checking...')
    expect(Math.abs((await check.boundingBox())!.width - c1)).toBeLessThanOrEqual(1)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
    await row(page, 'signbox').getByRole('button', { name: 'Show details' }).click().catch(() => {})
    const copy = row(page, 'signbox').locator('.hc .setup-copy-btn').first()
    const k1 = (await copy.boundingBox())!.width
    await copy.click()
    await expect(copy).toHaveText(/Copied|Copy failed/)
    expect(Math.abs((await copy.boundingBox())!.width - k1)).toBeLessThanOrEqual(1)
  })
})

/** Tab until `target` has focus (at most `max` presses); the keyboard is the only input. */
async function tabTo(page: Page, target: Locator, max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  throw new Error('Tab never reached the target')
}


test.describe('home attention banner: buttons and keyboard', () => {
  test('Tab and Enter alone: Retry, Show SSH output, row x; focus lands on the next row x (C44)', async ({ page }) => {
    const h = await setup(page, [failed('netbox', 'Net box', 'unreachable'), failed('keybox', 'Key box', 'auth')])
    h.connectAnswer = (host) => failed(host, 'Net box', 'unreachable')
    // Start in the task panel's toolbar: the card is the next thing in Tab order.
    await page.locator('.todo-panel-toolbar').click({ position: { x: 2, y: 2 } }).catch(() => {})
    const first = row(page, 'netbox')
    await tabTo(page, first.getByTestId('hpb-retry'))
    await page.keyboard.press('Enter')
    await expect(first.getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result')
    // Two rows start closed (dense): Show details first, by keyboard too. The opened
    // row's Show SSH output sits just before its Hide details in Tab order.
    await tabTo(page, first.getByRole('button', { name: 'Show details' }))
    await page.keyboard.press('Enter')
    await expect(first.getByRole('button', { name: 'Hide details' })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(first.getByRole('button', { name: 'Show SSH output' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(first.locator('pre.hft-summary')).toBeVisible()
    await tabTo(page, first.getByRole('button', { name: 'Dismiss Net box' }))
    await page.keyboard.press('Enter')
    await expect(first).toHaveCount(0)
    // The x leaves an undo row in its place with focus on Undo; when that row
    // folds away (5s, the pointer is off the card) focus moves to the next row's x.
    await expect(banner(page).getByRole('button', { name: 'Undo' })).toBeFocused()
    await expect(row(page, 'keybox').getByRole('button', { name: 'Dismiss Key box' })).toBeFocused({ timeout: 12_000 })
  })

  test('Check again: Checking..., then the ready sentence when the re-check clears it (C55 banner half)', async ({ page }) => {
    const h = await setup(page, [signedOut('signbox', 'Sign box')])
    h.checkAnswer = (host) => connected(host, 'Sign box')
    const check = row(page, 'signbox').getByRole('button', { name: 'Check again' })
    await check.click()
    await expect(row(page, 'signbox').getByTestId('hpb-check')).toHaveText('Checking...')
    await expect(row(page, 'signbox')).toHaveText(/^(\u2713 )?Sign box is ready \(Claude Code 2\.1\.281\)$/)
  })

  // ('Checked just now: still <version>' is the claude_outdated wording, which takes no banner row.)
  test('same result still answers: Tried again just now / Checked just now: same result, for about 5s (C77 banner half)', async ({ page }) => {
    const h = await setup(page, [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')])
    h.connectAnswer = (host) => failed(host, 'Net box', 'unreachable')
    h.checkAnswer = (host) => ({ ...signedOut(host, 'Sign box'), readiness: { ...signedOut(host, 'Sign box').readiness!, checkedAt: now() } })
    await row(page, 'netbox').getByTestId('hpb-retry').click()
    const receipt = row(page, 'netbox').getByTestId('hpb-receipt')
    await expect(receipt).toHaveText('Tried again just now: same result')
    await row(page, 'signbox').getByTestId('hpb-check').click()
    const checked = row(page, 'signbox').getByTestId('hpb-receipt')
    await expect(checked).toHaveText('Checked just now: same result')
    await expect(receipt).toHaveCount(0, { timeout: 7000 })
    await expect(checked).toHaveCount(0, { timeout: 7000 })
  })

  test('no Connecting... button, success sentences in one shape, Other ways matches the full list (C94)', async ({ page }) => {
    const h = await setup(page, [signedOut('signbox', 'Sign box'), failed('netbox', 'Net box', 'unreachable')])
    h.connectDelayMs = 800
    await row(page, 'netbox').getByTestId('hpb-retry').click()
    await expect(banner(page).getByRole('button', { name: /^Connecting\.\.\.$/ })).toHaveCount(0)
    const sign = row(page, 'signbox')
    const toggle = sign.getByRole('button', { name: 'Show details' })
    if (await toggle.count()) await toggle.click()
    await sign.getByRole('button', { name: /Other ways/ }).click()
    const chips = await sign.locator('.hc-chip').allInnerTexts()
    expect(chips).toEqual(['ssh -t alice@sign.example.com claude', 'ssh alice@sign.example.com claude /login'])
    await h.push(connected('signbox', 'Sign box'))
    const ready = await row(page, 'signbox').innerText()
    expect(ready.trim()).toMatch(/^(\u2713 )?.+ is ready( \(Claude Code .+\))?$/)
  })

  test('Dismiss all hides every host entry, the hidden ones too, and keeps the local section; it is last in Tab order (C76)', async ({ page }) => {
    await setup(page, [
      failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable'),
      failed('proxybox', 'Proxy box', 'proxy'), missing('barebox', 'Bare box'), signedOut('signbox', 'Sign box'),
    ], 'sign-in')
    // Two of the five sit behind 'and 2 more'.
    await expect(banner(page).locator('.hpb-more')).toHaveText('and 2 more')
    const all = banner(page).getByRole('button', { name: 'Dismiss all' })
    const lastFocusable = await banner(page).evaluate((el) => {
      const f = Array.from(el.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])'))
      const last = f[f.length - 1]
      return last ? (last.getAttribute('aria-label') ?? last.textContent ?? '').trim() : null
    })
    expect(lastFocusable).toBe('Dismiss all')
    await all.click()
    await expect(rows(page)).toHaveCount(0)
    expect(await storedKeys(page)).toEqual(expect.arrayContaining([
      'keybox|connect', 'netbox|connect', 'proxybox|connect', 'barebox|claude_missing|2.1.280', 'signbox|claude_not_logged_in|2.1.280',
    ]))
    await expect(banner(page).locator('[data-testid="setup-banner-sign-in"]')).toBeVisible()
    await expect(banner(page).getByRole('button', { name: 'Dismiss all' })).toHaveCount(0)
  })
})

/**
 * The same buttons against the SERVER's host fixture (no routing): the real
 * check and connect routes, the real readiness store, frames pushed by the server.
 */
test.describe('home attention banner: the real routes behind Check again and Install', () => {
  test.beforeEach(async ({ page }) => { await isolatePrefs(page) })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('Check again: Checking..., the fixture clears it during the check, then the ready sentence (C55 banner half)', async ({ page, request }) => {
    await loadFixture(request, fixtureFile({
      devbox: { label: 'Dev box', hostname: 'dev.example.com', phase: 'connected', claude: HEALTHY },
      signbox: { label: 'Sign box', hostname: 'sign.example.com', phase: 'connected', claude: { version: '2.1.281', auth: 'not-logged-in', installMethod: 'native' } },
    }))
    await hostFixture(request, { action: 'check-slow', host: 'signbox', ms: 1_200 })
    await loadApp(page)
    const r = bannerRow(page, 'signbox')
    await expect(r).toHaveAttribute('data-kind', 'claude_not_logged_in', { timeout: 20_000 })
    // The next answer is healthy: the user signed in from a terminal.
    await hostFixture(request, { action: 'set-check-result', host: 'signbox' })
    await r.getByTestId('hpb-check').click()
    await expect(r.getByTestId('hpb-check')).toHaveText('Checking...')
    await expect(bannerRow(page, 'signbox')).toHaveText(/^(\u2713 )?Sign box is ready \(Claude Code 2\.1\.281\)$/, { timeout: 10_000 })
    expect((await fixtureCounters(request)).check.signbox).toBe(1)
  })

  test('Install: the row reads Installing Claude Code on Fix box... until the re-check answers, never the old warning (C29 banner half)', async ({ page, request }) => {
    await loadFixture(request, FIX_FILE)
    await loadApp(page)
    const r = bannerRow(page, 'fixbox')
    await expect(r).toHaveAttribute('data-kind', 'claude_missing', { timeout: 20_000 })
    const warning = (await r.locator('.hpb-message').innerText()).trim()
    expect(warning).toBe('Claude Code is not installed on Fix box.')
    await expect(r.getByTestId('hpb-fix')).toHaveText('Install')
    await page.mouse.move(2, 2)
    await r.getByTestId('hpb-fix').click()
    const samples: string[] = []
    const deadline = Date.now() + 20_000
    for (;;) {
      const t = await bannerRow(page, 'fixbox').innerText().catch(() => '')
      samples.push(t)
      if (/^(\u2713 )?Fix box is ready/.test(t.trim())) break
      if (Date.now() > deadline) throw new Error(`never ready: ${JSON.stringify(samples.slice(-3))}`)
      await page.waitForTimeout(250)
    }
    const during = samples.slice(0, -1)
    expect(during.length).toBeGreaterThan(8)
    for (const t of during) {
      expect(t).toContain('Installing Claude Code on Fix box...')
      expect(t).not.toContain(warning)
    }
    expect((await fixtureCounters(request)).connect.fixbox).toBe(1)
  })

  test('a slow Install shows its time after 5s, then Still installing with Check again after 3 minutes (C95 banner half)', async ({ page, request }) => {
    await loadFixture(request, FIX_FILE)
    await hostFixture(request, { action: 'autofix-slow', host: 'fixbox', ms: 200_000 })
    await loadApp(page)
    const r = bannerRow(page, 'fixbox')
    await expect(r).toHaveAttribute('data-kind', 'claude_missing', { timeout: 20_000 })
    await r.getByTestId('hpb-fix').click()
    const fixing = r.getByTestId('hpb-fixing')
    await expect(fixing).toHaveText(/^Installing Claude Code on Fix box\.\.\.$/)
    await page.waitForTimeout(6_000)
    await expect(fixing).toHaveText(/^Installing Claude Code on .+\.\.\. \d+s$/)
    await hostFixture(request, { action: 'advance-clock', ms: 180_000 })
    await expect(fixing).toHaveText(/^Still installing Claude Code on Fix box\.\.\. 3m \d+s\s*Check again$/, { timeout: 5_000 })
    await expect(fixing.getByRole('button', { name: 'Check again' })).toBeVisible()
  })
})
