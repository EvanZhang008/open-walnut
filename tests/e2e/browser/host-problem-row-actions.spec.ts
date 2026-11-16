/**
 * The buttons of the notification panel's host problem rows: rows that never
 * move under the hand, stable button widths, Retry / Check again receipts and a
 * keyboard-only path. Same harness as host-problem-rows.spec.ts: the hydrate
 * and button requests go through page.route and every change is a
 * `host:status` frame on the app's own socket, so no remote host is dialed.
 * The last describe drives the same buttons through the SERVER's host fixture.
 *
 * Readiness rows are BANNER_READINESS_KINDS only, so a row's automatic fix is
 * Install (Claude Code missing or needing Node). Update, the fix for a
 * claude_outdated host, lives in Settings (host-problems-settings.spec.ts).
 * A host that heals leaves the list; the screen reader line
 * (host-banner-announcer) says it is ready.
 *
 * Run: walnut-dev run bun x playwright test tests/e2e/browser/host-problem-row-actions.spec.ts --project chromium-host-fixture --retries=0
 */
import { test, expect, type Page, type Locator } from '@playwright/test'
import {
  connected, connecting, failed, now, resetServerHostFixture, setup, signedOut, type HS, type Hosts,
} from './host-problems-helpers'
import { HEALTHY, fixtureCounters, fixtureFile, hostFixture, isolatePrefs, loadApp, loadFixture } from './host-problems-fixture-helpers'
import { openProblems, problemHosts, problemRow, problemRowHosts, seedFeed } from './host-attention-helpers'

/** A connected host with no Claude Code at all: the server can install it. */
const FIX_FILE = fixtureFile({
  fixbox: { label: 'Fix box', hostname: 'fix.example.com', phase: 'connected', claude: { found: false } },
})

/** Home with the routed hosts (listed in the health: the panel lists configured hosts only), the panel open on All. */
async function load(page: Page, hosts: HS[]): Promise<Hosts> {
  await seedFeed(page, [])
  const h = await setup(page, hosts, undefined, { listHosts: true })
  await openProblems(page)
  return h
}

const announcer = (page: Page): Locator => page.getByTestId('host-banner-announcer')

test.beforeAll(async ({ request }) => { await resetServerHostFixture(request) })

test.describe('host problem rows never move under the hand', () => {
  test('a row that retries by itself stays in place reading Trying again (C61)', async ({ page }) => {
    const h = await load(page, [failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable')])
    const target = problemRow(page, 'netbox')
    await expect(target).toBeVisible()
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
    // Keep sampling the settled row a little longer (enough samples on a slow machine too).
    const settledFrom = samples.length
    await expect.poll(() => samples.length - settledFrom).toBeGreaterThanOrEqual(3)
    sampling = false
    await sampler
    expect(samples.length).toBeGreaterThan(8)
    for (const s of samples) expect(s.y).toBe(y0)
    expect(samples.some((s) => s.text.includes('Trying again...'))).toBe(true)
  })

  test('Retry holds the row height until the attempt settles, then its receipt comes and goes (C62)', async ({ page }) => {
    const h = await load(page, [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')])
    h.connectDelayMs = 1500
    h.connectAnswer = (host) => failed(host, 'Net box', 'unreachable')
    const target = problemRow(page, 'netbox')
    const before = (await target.boundingBox())!.height
    await target.getByRole('button', { name: 'Retry' }).click()
    await expect(target.getByRole('button', { name: 'Retrying...' })).toBeVisible()
    await h.push(connecting('netbox', 'Net box'))
    for (let i = 0; i < 5; i++) {
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(before - 0.5)
      await page.waitForTimeout(150)
    }
    await expect(target.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 8000 })
    await expect(target.getByTestId('hpb-receipt')).toHaveCount(1, { timeout: 12_000 })
    await expect(target.getByTestId('hpb-receipt')).toHaveCount(0, { timeout: 12_000 })
    await expect.poll(() => problemRowHosts(page)).toEqual(['netbox', 'signbox'])
  })

  test('paired labels keep one width: Retry / Retrying..., Check again / Checking..., Copy / Copied (C63)', async ({ page }) => {
    const h = await load(page, [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')])
    h.connectDelayMs = 1200
    const retry = problemRow(page, 'netbox').getByTestId('hpb-retry')
    const w1 = (await retry.boundingBox())!.width
    await retry.click()
    await expect(retry).toHaveText('Retrying...')
    expect(Math.abs((await retry.boundingBox())!.width - w1)).toBeLessThanOrEqual(1)
    const check = problemRow(page, 'signbox').getByTestId('hpb-check')
    const c1 = (await check.boundingBox())!.width
    await check.click()
    await expect(check).toHaveText('Checking...')
    expect(Math.abs((await check.boundingBox())!.width - c1)).toBeLessThanOrEqual(1)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
    await problemRow(page, 'signbox').getByRole('button', { name: 'Show details' }).click()
    const copy = problemRow(page, 'signbox').locator('.hc .setup-copy-btn').first()
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

test.describe('host problem rows: buttons and keyboard', () => {
  test('Tab and Enter alone: Retry, Show details, Show SSH output, row x (C44)', async ({ page }) => {
    const h = await load(page, [failed('netbox', 'Net box', 'unreachable'), failed('keybox', 'Key box', 'auth')])
    h.connectAnswer = (host) => failed(host, 'Net box', 'unreachable')
    const first = problemRow(page, 'netbox')
    await tabTo(page, first.getByTestId('hpb-retry'))
    await page.keyboard.press('Enter')
    await expect(first.getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result')
    // Rows start closed (dense): Show details first, by keyboard too. The opened
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
    await expect(problemRow(page, 'keybox')).toBeVisible()
  })

  test('Check again: Checking..., then the row leaves when the re-check clears it, and the ready sentence is said (C55)', async ({ page }) => {
    const h = await load(page, [signedOut('signbox', 'Sign box'), failed('netbox', 'Net box', 'unreachable')])
    h.checkAnswer = (host) => connected(host, 'Sign box')
    await problemRow(page, 'signbox').getByRole('button', { name: 'Check again' }).click()
    await expect(problemRow(page, 'signbox').getByTestId('hpb-check')).toHaveText('Checking...')
    await expect(problemRow(page, 'signbox')).toHaveCount(0, { timeout: 10_000 })
    await expect(announcer(page)).toContainText('Sign box is ready (Claude Code 2.1.281)')
    await expect(problemRow(page, 'netbox')).toBeVisible()
  })

  // ('Checked just now: still <version>' is the claude_outdated wording, which takes no row.)
  test('same result still answers: Tried again just now / Checked just now: same result, for about 5s (C77)', async ({ page }) => {
    const h = await load(page, [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')])
    h.connectAnswer = (host) => failed(host, 'Net box', 'unreachable')
    h.checkAnswer = (host) => ({ ...signedOut(host, 'Sign box'), readiness: { ...signedOut(host, 'Sign box').readiness!, checkedAt: now() } })
    await problemRow(page, 'netbox').getByTestId('hpb-retry').click()
    const receipt = problemRow(page, 'netbox').getByTestId('hpb-receipt')
    await expect(receipt).toHaveText('Tried again just now: same result')
    await problemRow(page, 'signbox').getByTestId('hpb-check').click()
    const checked = problemRow(page, 'signbox').getByTestId('hpb-receipt')
    await expect(checked).toHaveText('Checked just now: same result')
    await expect(receipt).toHaveCount(0, { timeout: 7000 })
    await expect(checked).toHaveCount(0, { timeout: 7000 })
  })

  test('no Connecting... button, Other ways matches the full list (C94)', async ({ page }) => {
    const h = await load(page, [signedOut('signbox', 'Sign box'), failed('netbox', 'Net box', 'unreachable')])
    h.connectDelayMs = 800
    await problemRow(page, 'netbox').getByTestId('hpb-retry').click()
    await expect(problemHosts(page).getByRole('button', { name: /^Connecting\.\.\.$/ })).toHaveCount(0)
    const sign = problemRow(page, 'signbox')
    await sign.getByRole('button', { name: 'Show details' }).click()
    await sign.getByRole('button', { name: /Other ways/ }).click()
    const chips = await sign.locator('.hc-chip').allInnerTexts()
    expect(chips).toEqual(['ssh -t alice@sign.example.com claude', 'ssh alice@sign.example.com claude /login'])
  })
})

/**
 * The same buttons against the SERVER's host fixture (no routing): the real
 * check and connect routes, the real readiness store, frames pushed by the server.
 */
test.describe('host problem rows: the real routes behind Check again and Install', () => {
  test.beforeEach(async ({ page }) => { await isolatePrefs(page) })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('Check again: Checking..., the fixture clears it during the check, then the row leaves (C55)', async ({ page, request }) => {
    await loadFixture(request, fixtureFile({
      devbox: { label: 'Dev box', hostname: 'dev.example.com', phase: 'connected', claude: HEALTHY },
      signbox: { label: 'Sign box', hostname: 'sign.example.com', phase: 'connected', claude: { version: '2.1.281', auth: 'not-logged-in', installMethod: 'native' } },
    }))
    await hostFixture(request, { action: 'check-slow', host: 'signbox', ms: 1_200 })
    await loadApp(page)
    await openProblems(page)
    const r = problemRow(page, 'signbox')
    await expect(r).toHaveAttribute('data-kind', 'claude_not_logged_in', { timeout: 20_000 })
    // The next answer is healthy: the user signed in from a terminal.
    await hostFixture(request, { action: 'set-check-result', host: 'signbox' })
    await r.getByTestId('hpb-check').click()
    await expect(r.getByTestId('hpb-check')).toHaveText('Checking...')
    await expect(r).toHaveCount(0, { timeout: 10_000 })
    await expect(announcer(page)).toContainText('Sign box is ready (Claude Code 2.1.281)')
    expect((await fixtureCounters(request)).check.signbox).toBe(1)
  })

  test('Install: the row reads Installing Claude Code on Fix box... until the re-check answers, never the old warning (C29)', async ({ page, request }) => {
    await loadFixture(request, FIX_FILE)
    await loadApp(page)
    await openProblems(page)
    const r = problemRow(page, 'fixbox')
    await expect(r).toHaveAttribute('data-kind', 'claude_missing', { timeout: 20_000 })
    const warning = (await r.locator('.hpb-message').innerText()).trim()
    expect(warning).toBe('Claude Code is not installed on Fix box.')
    await expect(r.getByTestId('hpb-fix')).toHaveText('Install')
    await r.getByTestId('hpb-fix').click()
    // Sampled until the healed host leaves the list.
    const samples: string[] = []
    const deadline = Date.now() + 20_000
    for (;;) {
      if (await r.count() === 0) break
      samples.push(await r.innerText().catch(() => ''))
      if (Date.now() > deadline) throw new Error(`never ready: ${JSON.stringify(samples.slice(-3))}`)
      await page.waitForTimeout(250)
    }
    const during = samples.filter(Boolean)
    expect(during.length).toBeGreaterThan(8)
    for (const t of during) {
      expect(t).toContain('Installing Claude Code on Fix box...')
      expect(t).not.toContain(warning)
    }
    await expect(announcer(page)).toContainText('Fix box is ready')
    expect((await fixtureCounters(request)).connect.fixbox).toBe(1)
  })

  test('a slow Install shows its time after 5s, then Still installing with Check again after 3 minutes (C95)', async ({ page, request }) => {
    await loadFixture(request, FIX_FILE)
    await hostFixture(request, { action: 'autofix-slow', host: 'fixbox', ms: 200_000 })
    await loadApp(page)
    await openProblems(page)
    const r = problemRow(page, 'fixbox')
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
