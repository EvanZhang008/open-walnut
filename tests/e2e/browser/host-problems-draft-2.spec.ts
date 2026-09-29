/**
 * The draft and session surfaces against the SERVER's host fixture, part 2
 * (part 1: host-problems-draft.spec.ts):
 *
 *   fresh redial   Start on a failed host dials once more first: a renewed
 *                  credential starts at once (C46); a still-broken host is
 *                  refused with the NEW attempt's kind and words (C47)
 *   shell_setup    a check that runs the host's shell_setup sees the newer
 *                  Claude Code, so Start goes through (C52)
 *   pills, chips   the Folder/Host pill and a quick chip wear the tab's dot and
 *                  sentence (C69); off hosts: no chips, an off ring, host_off (C79)
 *   the gate bar   follows the host live and per 2.2 (C80); a removed host's
 *                  history row is refused host_removed (C73)
 *   slot hidden    the compact banner in the draft column (C66) once the task panel and the
 *                  slot are both hidden, without the gate bar's host
 *                  (a signed-out Sign box: an outdated Build box takes no banner row at all)
 *   session        the error bar names the host and the last cause (C70)
 *
 * Run with --workers=1 next to the banner specs (every describe loads its own
 * server fixture). page.goto only loads the app.
 *
 * Run: PW_TEST_PORT=35993 npx playwright test host-problems-draft-2 --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35993 npx playwright test host-problems-draft-2 --project=webkit --workers=1
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { draftCwdPill, draftQuickChips, openDraft, draftSend } from './draft-helpers'
import {
  HEALTHY, fixtureCounters, fixtureFile, gateBar, hostFixture, hostTab, isolatePrefs, loadApp, loadFixture, openPicker,
  pickFolder, picker, resetServerHostFixture, start, startOnHost, tasksBanner, wireHost,
} from './host-problems-fixture-helpers'
import { hideTaskPanel } from './host-problems-helpers'

const SHOTS = '/tmp/walnut-host-problems-slice/fix2'
const REMOTE_OFF = 'Remote hosts are off on this test server.'
const REMOVED = 'This host is no longer in Settings.'

test.beforeEach(async ({ page }) => { await isolatePrefs(page) })
test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

test.describe('Start on a failed host is a fresh redial', () => {
  test.beforeEach(async ({ request }) => { await loadFixture(request, 'host-problems') })

  test('Cert box renewed while its countdown still runs: Start dials once, clears the failure cache, spawns once (C46)', async ({ page, request }) => {
    const wire = await wireHost(request, 'certbox')
    expect(wire.kind).toBe('cert_expired')
    expect(wire.retryAt! - Date.now()).toBeGreaterThan(60_000)
    await loadApp(page)
    const panel = await openPicker(page)
    await pickFolder(page, panel, 'certbox', '~/work/api', { live: false })
    await hostFixture(request, { action: 'renew-credential', host: 'certbox' })
    const before = await fixtureCounters(request)

    const res = await start(page, panel, 'build it on the cert box')
    expect(res.status()).toBe(200)
    const sid = (await res.json() as { sessionId: string }).sessionId
    await expect(page.locator(`.session-panel[data-session-id="${sid}"]`)).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="host-gate-bar"]')).toHaveCount(0)
    const after = await fixtureCounters(request)
    expect((after.connect.certbox ?? 0) - (before.connect.certbox ?? 0)).toBe(1)
    expect((after.failureCacheCleared.certbox ?? 0) - (before.failureCacheCleared.certbox ?? 0)).toBe(1)
    expect(after.spawns.length - before.spawns.length).toBe(1)
    expect((await wireHost(request, 'certbox')).connected).toBe(true)
  })

  test('Key box still broken: 409 host_unreachable carries the NEW attempt (timeout), inside 22s (C47, C80 connect buttons)', async ({ page, request }) => {
    expect((await wireHost(request, 'keybox')).kind).toBe('auth')
    await loadApp(page)
    const panel = await openPicker(page)
    await pickFolder(page, panel, 'keybox', '~/work/api', { live: false })
    // Between the old frame and the Start's own attempt, the host's failure changes.
    await hostFixture(request, { action: 'set-next-connect', host: 'keybox', result: 'timeout' })
    const t0 = Date.now()
    const res = await start(page, panel, 'deploy from the key box')
    expect(Date.now() - t0).toBeLessThanOrEqual(22_000)
    expect(res.status()).toBe(409)
    const body = await res.json() as { code: string; kind: string; headline: string; hint: string; error: string }
    const fresh = await wireHost(request, 'keybox')
    expect(body.code).toBe('host_unreachable')
    expect(body.kind).toBe('timeout')
    expect(fresh.kind).toBe('timeout')
    expect(body.headline).toBe('Connecting to Key box timed out')
    expect(body.hint).toBe(fresh.hint)
    expect(body.error).toBe(`${body.headline}. ${body.hint}`)

    const bar = gateBar(panel)
    await expect(bar).toHaveAttribute('data-code', 'host_unreachable')
    await expect(bar.locator('.hft-headline')).toHaveText('Connecting to Key box timed out')
    await expect(bar.locator('.hft-hint')).toHaveText(body.hint.replace(/`/g, ''))
    // timeout is retryable: Retry, and no Open Settings (spec 2.2).
    await expect(bar.getByRole('button', { name: 'Retry' })).toBeVisible()
    await expect(bar.getByRole('button', { name: 'Open Settings' })).toHaveCount(0)
    await expect(bar.getByRole('button', { name: /Check again|Start anyway/ })).toHaveCount(0)
    await bar.screenshot({ path: `${SHOTS}/gate-bar-keybox-timeout.png` })
  })

  test('shell_setup puts a newer Claude Code on PATH: the check sees it, the dot turns green, Start goes through (C52)', async ({ page, request }) => {
    expect((await wireHost(request, 'buildbox')).readiness!.problems[0].kind).toBe('claude_outdated')
    await hostFixture(request, { action: 'set-shell-setup', host: 'buildbox', claudeVersion: '2.1.281' })
    await loadApp(page)
    const panel = await openPicker(page)
    await expect(hostTab(page, 'buildbox').locator('.sps-host-dot')).toHaveAttribute('data-kind', 'warn')
    await pickFolder(page, panel, 'buildbox', '~/work/api')
    const res = await start(page, panel, 'run the build with the newer CLI')
    expect(res.status()).toBe(200)
    const wire = await wireHost(request, 'buildbox')
    expect(wire.readiness!.problems).toEqual([])
    expect(wire.readiness!.claude!.version).toBe('2.1.281')
    expect(wire.readiness!.claude!.versionOk).toBe(true)
    // A new draft's picker: the Build box dot is no longer the warn square.
    await openPicker(page)
    await expect(hostTab(page, 'buildbox').locator('.sps-host-dot')).toHaveAttribute('data-kind', 'connected')
  })
})

test.describe('the gate bar lives with the host', () => {
  test.beforeEach(async ({ request }) => { await loadFixture(request, 'host-problems') })

  async function refuseOnBuildbox(page: Page) {
    await loadApp(page)
    const panel = await openPicker(page)
    await pickFolder(page, panel, 'buildbox', '~/work/api')
    const res = await start(page, panel, 'try the old build box')
    expect(res.status()).toBe(409)
    await expect(gateBar(panel)).toHaveAttribute('data-code', 'host_not_ready')
    return panel
  }

  test('cleared by the fixture: the bar goes on that frame and the ready sentence holds 3s; buttons per 2.2 (C80)', async ({ page, request }) => {
    const panel = await refuseOnBuildbox(page)
    const bar = gateBar(panel)
    // Readiness: Check again, Start anyway (allowOverride), Open Settings; never Retry.
    // (Trimmed: WebKit's innerText ends a button's stacked label with a newline.)
    expect((await bar.locator('.host-gate-actions button').allInnerTexts()).map((t) => t.trim())).toEqual(['Check again', 'Start anyway', 'Open Settings'])
    await hostFixture(request, { action: 'clear-problems', host: 'buildbox' })
    const ready = panel.locator('[data-testid="host-gate-ready"]')
    await expect(ready).toHaveText(/^✓ Build box is ready \(Claude Code 2\.1\.281\)$/)
    await expect(bar).toHaveCount(0)
    await expect(ready).toHaveCount(0, { timeout: 5_000 })
    await expect(draftSend(panel)).toBeEnabled()
  })

  test('another host on the draft clears the bar at once (C80)', async ({ page }) => {
    const panel = await refuseOnBuildbox(page)
    await draftCwdPill(panel).click()
    await expect(picker(page)).toBeVisible()
    await pickFolder(page, panel, 'devbox', '~/work/web')
    await expect(gateBar(panel)).toHaveCount(0, { timeout: 500 })
    await expect(panel.locator('[data-testid="host-gate-ready"]')).toHaveCount(0)
  })
})

test.describe('the Folder/Host pill and quick chips wear the tab\'s dot', () => {
  test.beforeAll(async ({ request }) => {
    await loadFixture(request, 'host-problems')
    await startOnHost(request, 'buildbox', '~/work/web', { overrideReadiness: true })
  })

  test('Build box as the draft host: pill and chip carry the warn dot and the tab\'s own title (C69)', async ({ page }) => {
    await loadApp(page)
    const panel = await openDraft(page)
    const chip = draftQuickChips(panel).filter({ has: page.locator('.draft-quick-chip-host', { hasText: 'Build box' }) }).first()
    await expect(chip).toBeVisible({ timeout: 20_000 })
    await expect(chip.locator('.draft-pill-dot')).toHaveAttribute('data-kind', 'warn')
    await draftCwdPill(panel).click()
    await expect(hostTab(page, 'buildbox')).toBeVisible({ timeout: 20_000 })
    const tabTitle = await hostTab(page, 'buildbox').getAttribute('title')
    expect(tabTitle).toMatch(/^Build box: Claude Code on Build box is 2\.1\.220/)
    expect(await chip.getAttribute('title')).toBe(tabTitle)
    await pickFolder(page, panel, 'buildbox', '~/work/api')
    const pill = draftCwdPill(panel)
    await expect(pill.locator('.draft-pill-dot')).toHaveAttribute('data-kind', 'warn')
    expect(await pill.getAttribute('title')).toBe(tabTitle)
    expect(await page.locator('body').innerText()).not.toContain('Last connect failed:')
    await panel.locator('.draft-launch-bar').screenshot({ path: `${SHOTS}/draft-pill-chip-warn.png` })
  })
})

test.describe('a host that left Settings, and hosts that are off', () => {
  test('a Removed hosts history row: Start is refused host_removed with the same sentence, no buttons (C73)', async ({ page, request }) => {
    await loadFixture(request, fixtureFile({
      oldbox: { label: 'Old box', hostname: 'old.example.com', phase: 'connected', claude: HEALTHY },
      devbox: { label: 'Dev box', hostname: 'dev.example.com', phase: 'connected', claude: HEALTHY },
    }))
    await startOnHost(request, 'oldbox', '~/work/api')
    await hostFixture(request, { action: 'remove-host', host: 'oldbox' })
    await loadApp(page)
    const panel = await openPicker(page)
    await picker(page).locator('.sps-host-tab[data-host="__removed__"]').click()
    await expect(picker(page).locator('.sps-host-note-removed')).toHaveText(REMOVED)
    // Removed hosts also holds disabled hosts' history: take the Old box row.
    await picker(page).locator('.sps-path-item').filter({ hasText: /Old box|oldbox/ }).first().click()
    await picker(page).locator('.sps-search-input').press('Shift+Enter')
    await expect(picker(page)).toBeHidden()
    const res = await start(page, panel, 'back to the old box')
    expect(res.status()).toBe(409)
    const body = await res.json() as { code: string; error: string; host: string }
    expect(body).toMatchObject({ code: 'host_removed', error: REMOVED, host: 'oldbox' })
    const bar = gateBar(panel)
    await expect(bar).toHaveAttribute('data-code', 'host_removed')
    await expect(bar.locator('.session-error-banner-text')).toHaveText(REMOVED)
    await expect(bar.getByRole('button')).toHaveCount(0)
  })

  test('ephemeral fixture: no remote quick chip, an off ring on the pill, host_off on Start with no dial (C79)', async ({ page, request }) => {
    // History on a remote host first (a real, allowed Start), then the test server turns remotes off.
    await loadFixture(request, 'host-problems')
    await startOnHost(request, 'devbox', '~/work/api')
    const dirs = await (await request.get('/api/sessions/working-dirs')).json() as { dirs?: Array<{ host?: string | null }> }
    expect((dirs.dirs ?? []).some((d) => d.host === 'devbox'), 'a devbox history row exists').toBe(true)
    await loadFixture(request, 'host-problems-ephemeral')
    await loadApp(page)
    const panel = await openDraft(page)
    await expect(draftQuickChips(panel).first()).toBeVisible({ timeout: 20_000 })
    await expect(draftQuickChips(panel).locator('.draft-quick-chip-host')).toHaveCount(0)
    await draftCwdPill(panel).click()
    await expect(hostTab(page, 'devbox')).toBeVisible({ timeout: 20_000 })
    await pickFolder(page, panel, 'devbox', '~/work/api', { live: false })
    const pill = draftCwdPill(panel)
    const ring = pill.locator('.draft-pill-dot')
    await expect(ring).toHaveAttribute('data-kind', 'off')
    expect(await ring.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
    expect(await pill.getAttribute('title')).toBe('Dev box: Off on this test server')
    const before = await fixtureCounters(request)
    const res = await start(page, panel, 'try a remote on the test server')
    expect(res.status()).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'host_off', error: REMOTE_OFF, host: 'devbox' })
    const after = await fixtureCounters(request)
    expect(after.connect.devbox ?? 0).toBe(before.connect.devbox ?? 0)
    expect(after.spawns.length).toBe(before.spawns.length)
    const bar = gateBar(panel)
    await expect(bar.locator('.session-error-banner-text')).toHaveText(REMOTE_OFF)
    await expect(bar.getByRole('button')).toHaveCount(0)
  })
})

/**
 * host-problems plus a fifth banner problem (Lan box, unreachable), so the cap
 * folds rows: Key box, Cert box, Net box, then 'and 2 more' (Lan box, Sign box).
 * Build box (claude_outdated) takes no banner row and is not one of the five.
 */
function fiveBannerProblems(): Record<string, unknown> {
  const file = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'tests/e2e/browser/fixtures/host-problems.json'), 'utf-8')) as { hosts: Record<string, unknown> }
  file.hosts.lanbox = { label: 'Lan box', hostname: 'lan.example.com', phase: 'failed', error: 'ssh: connect to host lan.example.com port 22: No route to host' }
  return file
}

test.describe('the Ask Walnut slot hidden', () => {
  test.beforeAll(async ({ request }) => { await loadFixture(request, fiveBannerProblems()) })

  test('the draft column carries the compact banner with the task panel\'s rows; no second banner exists (C66)', async ({ page, browser }) => {
    test.setTimeout(90_000) // two app loads (task panel shown, then hidden) in one test
    await loadApp(page)
    const tasksRows = tasksBanner(page).locator('li.hpb-row[data-host]')
    await expect(tasksRows.first()).toBeVisible({ timeout: 20_000 })
    const rowsOf = (els: Element[]) => els.map((e) => `${e.getAttribute('data-host')}|${e.getAttribute('data-type')}|${e.getAttribute('data-kind')}`)
    const inTasks = await tasksRows.evaluateAll(rowsOf)

    const ctx = await browser.newContext()
    const hidden = await ctx.newPage()
    try {
      await isolatePrefs(hidden)
      await hidden.addInitScript(() => localStorage.setItem('open-walnut-home-chat-visible', 'false'))
      await loadApp(hidden)
      // A draft from the toolbar, then the task panel hidden: the draft column is the one mount left.
      const draft = await openDraft(hidden)
      await hideTaskPanel(hidden)
      const compact = draft.locator('[data-testid="attention-banner"].attention-banner-compact')
      await expect(compact).toBeVisible({ timeout: 10_000 })
      await expect(compact).toHaveAttribute('data-mount', 'draft')
      await expect(hidden.locator('[data-testid="attention-banner"]')).toHaveCount(1)
      await expect(compact.locator('.setup-banner-title')).toHaveCount(0)
      expect(await compact.locator('li.hpb-row[data-host]').evaluateAll(rowsOf)).toEqual(inTasks)
      await expect(compact.locator('.hpb-more')).toHaveText(await tasksBanner(page).locator('.hpb-more').innerText())
      await expect(hidden.locator('.host-connect-banner')).toHaveCount(0)
      await draft.screenshot({ path: `${SHOTS}/draft-compact-banner.png` })
    } finally {
      await ctx.close()
    }
    // The old second implementation is gone from the tree.
    const web = path.resolve(process.cwd(), 'web/src')
    expect(fs.existsSync(path.join(web, 'components/common/HostConnectBanner.tsx'))).toBe(false)
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(tsx?|css)$/.test(e.name) && /host-connect-banner|HostConnectBanner/.test(fs.readFileSync(p, 'utf-8'))) hits.push(p)
      }
    }
    walk(web)
    expect(hits).toEqual([])
  })

  test('a refused Start: the compact banner leaves out the host its gate bar speaks for, and keeps the rest (review fix 22)', async ({ browser }) => {
    test.setTimeout(90_000)
    const ctx = await browser.newContext()
    const hidden = await ctx.newPage()
    try {
      await isolatePrefs(hidden)
      await hidden.addInitScript(() => localStorage.setItem('open-walnut-home-chat-visible', 'false'))
      await loadApp(hidden)
      // Task panel and slot hidden with a draft open: the compact card in the draft column.
      const panel = await openDraft(hidden)
      await hideTaskPanel(hidden)
      await draftCwdPill(panel).click()
      await expect(picker(hidden)).toBeVisible({ timeout: 10_000 })
      await expect(hostTab(hidden, 'devbox')).toBeVisible({ timeout: 20_000 })
      const compact = panel.locator('[data-testid="attention-banner"].attention-banner-compact')
      const hostsIn = () => compact.locator('li.hpb-row[data-host]').evaluateAll((els) => els.map((e) => e.getAttribute('data-host')))
      // Five banner problems: three rows and 'and 2 more' (Sign box is one of the two).
      await expect(compact.locator('.hpb-more')).toHaveText('and 2 more', { timeout: 20_000 })
      await expect(hidden.locator('[data-testid="attention-banner"]')).toHaveCount(1)
      expect(await hostsIn()).not.toContain('signbox')
      expect(await hostsIn()).not.toContain('buildbox')
      await pickFolder(hidden, panel, 'signbox', '~/work/api')
      const res = await start(hidden, panel, 'try the signed-out box')
      expect(res.status()).toBe(409)
      expect(await res.json()).toMatchObject({ code: 'host_not_ready', kind: 'claude_not_logged_in', host: 'signbox' })
      await expect(gateBar(panel)).toHaveAttribute('data-host', 'signbox')
      // Sign box speaks once, in the bar; the four others fit without 'and N more'.
      await expect(compact.locator('.hpb-more')).toHaveCount(0)
      await expect(compact.locator('li.hpb-row[data-host]')).toHaveCount(4)
      expect(await hostsIn()).not.toContain('signbox')
      await expect(compact.locator('li.hpb-row[data-host="lanbox"]')).toBeVisible()
      await expect(compact.locator('li.hpb-row[data-host="keybox"]')).toBeVisible()
      await expect(hidden.locator('[data-testid="attention-banner"]')).toHaveCount(1)
      await panel.screenshot({ path: `${SHOTS}/draft-compact-banner-gate.png` })
    } finally {
      await ctx.close()
    }
  })
})

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'

/** The fixture session, as a devbox session that lost its connection (only its HTTP answers are shaped). */
async function devboxSessionInError(page: Page, errorMessage: string, activity?: string): Promise<void> {
  const shape = (s: Record<string, unknown>) => ({
    ...s, host: 'devbox', hostname: 'dev.example.com', process_status: 'error', errorMessage, ...(activity ? { activity } : {}),
  })
  await page.route(/\/api\/sessions\/pw-vscode-session(\?|$)/, async (route) => {
    const body = await (await route.fetch()).json() as { session?: Record<string, unknown> }
    await route.fulfill({ json: { ...body, session: shape(body.session ?? {}) } })
  })
  await page.route(/\/api\/sessions\/status\?/, async (route) => {
    const body = await (await route.fetch()).json() as { statuses?: Record<string, Record<string, unknown>> }
    const statuses = { ...(body.statuses ?? {}) }
    const cur = statuses[SESSION_ID]
    if (cur) statuses[SESSION_ID] = { ...shape(cur), statusRevision: Number(cur.statusRevision ?? 0) + 1000, statusUpdatedAt: new Date().toISOString() }
    await route.fulfill({ json: { ...body, statuses } })
  })
  await page.route(/\/api\/sessions\/pw-vscode-session\/recheck$/, (route) => route.fulfill({ json: {
    sessionId: SESSION_ID, checked: false, reachable: false, processStatus: 'error', infraClaim: true, reason: 'no_pooled_connection',
  } }))
}

test.describe('a session on a reconnecting host', () => {
  test.beforeAll(async ({ request }) => {
    await loadFixture(request, fixtureFile({ devbox: { label: 'Dev box', hostname: 'dev.example.com', phase: 'connected', claude: HEALTHY } }))
    await hostFixture(request, { action: 'start-reconnect', host: 'devbox' })
    await hostFixture(request, { action: 'inject-failure', host: 'devbox', kind: 'timeout' })
  })
  // The shaped session routes fetch the real answer: drop them before the page closes.
  test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

  async function openFixtureSession(page: Page) {
    await loadApp(page)
    await page.locator('.todo-search-input').fill(SESSION_ID)
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(task).toBeVisible()
    await task.locator('.todo-item-title').click()
    const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
    return { panel, banner: panel.locator('.session-error-banner').first() }
  }

  test('connection lost: the error bar names Dev box and the last attempt, never "remote host" (C70)', async ({ page }) => {
    await devboxSessionInError(page, 'Connection lost: unable to reach remote host', 'Reconnecting...')
    const { panel, banner } = await openFixtureSession(page)
    const bar = panel.locator('[data-testid="session-host-reconnecting"]')
    await expect(bar).toBeVisible({ timeout: 20_000 })
    await expect(bar.locator('.session-error-banner-text')).toHaveText('Reconnecting to Dev box')
    await expect(bar.locator('.hpb-last')).toHaveText('Last attempt: Connecting to Dev box timed out')
    await expect(banner).not.toContainText('Reconnecting to remote host')
    await banner.screenshot({ path: `${SHOTS}/session-error-reconnecting.png` })
  })

  test('a remote exit on a host with a problem: the host line speaks, the generic suggestion stays quiet (C70)', async ({ page, request }) => {
    await devboxSessionInError(page, 'Remote session exited with code 255')
    const { panel, banner } = await openFixtureSession(page)
    const bar = panel.locator('[data-testid="session-host-reconnecting"]')
    await expect(bar.locator('.hpb-last')).toHaveText('Last attempt: Connecting to Dev box timed out', { timeout: 20_000 })
    await expect(banner).not.toContainText('Check remote host configuration.')
    // Control: once the host has nothing to say, the generic suggestion is back (the guard, not a missing rule).
    await hostFixture(request, { action: 'set-status', host: 'devbox', phase: 'connected' })
    await expect(banner).toContainText('Check remote host configuration.', { timeout: 10_000 })
    await expect(bar).toHaveCount(0)
  })
})
