/**
 * The update notice's `server` kind (live self-update, web half): the running
 * server's own install and restart, as the sidebar notice shows and drives it.
 *
 * The fixture server is a source checkout that never updates, so the spec routes
 * GET /api/system/update and the install/restart POSTs in the browser, and sits
 * in the middle of the WS to hand the page `system:update` pushes (the server's
 * own ones are dropped, so a real broadcast cannot undo the routed state) and to
 * drop the socket the way a restart does.
 *
 * Run: walnut-dev run bun x playwright test tests/e2e/browser/live-server-update.spec.ts --project chromium --retries=0
 *      walnut-dev run -e PW_WEBKIT=1 bun x playwright test tests/e2e/browser/live-server-update.spec.ts --project webkit --retries=0
 */
import fs from 'node:fs'
import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'
import { isolatePrefs } from './host-problems-helpers'
import { loadApp, openBell } from './host-problems-fixture-helpers'
import { healthyGitSync, railButton } from './banner-placement-helpers'

const SHOTS = process.env.LIVE_UPDATE_SHOTS ?? '/tmp/live-server-update/shots'
test.describe.configure({ timeout: 90_000 })
test.beforeAll(() => { fs.mkdirSync(SHOTS, { recursive: true }) })

type LiveState = 'off' | 'idle' | 'downloading' | 'installed' | 'waiting' | 'restarting' | 'failed'
interface Live {
  state: LiveState; version: string | null; error: string | null; canInstall: boolean; held: string | null; updatesAuto: boolean
  idle: { ready: boolean; userIdleMs: number | null; turnsRunning: number; waitingSince: string | null }
}

const NPM_INSTALL = { kind: 'npm', sourceDir: null, packageRoot: '/usr/local/lib/node_modules/open-walnut', manager: 'npm', updateCommand: 'npm install -g open-walnut@latest' }
const IDLE = { ready: false, userIdleMs: 5_000, turnsRunning: 0, waitingSince: null }
const live = (over: Partial<Live>): Live => ({ state: 'idle', version: null, error: null, canInstall: true, held: null, updatesAuto: true, idle: IDLE, ...over })
function status(over: Record<string, unknown> = {}, liveOver?: Partial<Live>) {
  return {
    enabled: true, install: NPM_INSTALL, current: '0.5.1', channel: 'stable', latest: '0.9.0', tags: { latest: '0.9.0', nightly: null },
    available: true, autoUpdate: true, checkedAt: new Date().toISOString(), error: null, checking: false,
    packageUrl: 'https://www.npmjs.com/package/open-walnut', ...over, ...(liveOver ? { live: live(liveOver) } : {}),
  }
}

interface Routes {
  set(next: unknown): void
  gets: () => number
  installs: () => number
  restarts: () => number
}

async function routeUpdate(page: Page, first: unknown, answers: { install?: () => { status: number; json: unknown }; restart?: () => { status: number; json: unknown } } = {}): Promise<Routes> {
  let cur = first
  let gets = 0, installs = 0, restarts = 0
  await page.route('**/api/system/update', (r) => { gets++; return r.fulfill({ json: cur }) })
  await page.route('**/api/system/update/install', (r) => {
    installs++
    const a = answers.install?.() ?? { status: 202, json: cur }
    return r.fulfill({ status: a.status, json: a.json })
  })
  await page.route('**/api/system/update/restart', (r) => {
    restarts++
    const a = answers.restart?.() ?? { status: 202, json: cur }
    return r.fulfill({ status: a.status, json: a.json })
  })
  return { set: (next) => { cur = next }, gets: () => gets, installs: () => installs, restarts: () => restarts }
}

/** The page's socket, through the spec: drops the server's own system:update frames. */
async function routeSocket(page: Page): Promise<() => WebSocketRoute | null> {
  let socket: WebSocketRoute | null = null
  await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
    socket = ws
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => {
      try { if (JSON.parse(m.toString()).name === 'system:update') return } catch { /* not JSON: pass it on */ }
      ws.send(m)
    })
  })
  return () => socket
}

function push(sock: WebSocketRoute | null, data: unknown): void {
  sock!.send(JSON.stringify({ type: 'event', name: 'system:update', data, seq: -1 }))
}

const pill = (page: Page) => page.locator('#primary-sidebar .sidebar-update-dock > .stale-build-pill')
const heading = (page: Page) => pill(page).locator('.stale-build-pill-text')
const action = (page: Page) => pill(page).locator('button.stale-build-pill-action')

/** The heading shows all of its words: nothing cut by the ellipsis or the two-line clamp. */
async function expectWhole(page: Page): Promise<void> {
  // Polled: the rail's open/close is animated, and mid-way the heading has almost no width.
  const fit = () => heading(page).evaluate((el) => ({
    whole: el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight + 1,
    lines: Math.round((el.clientHeight - parseFloat(getComputedStyle(el).paddingTop) - parseFloat(getComputedStyle(el).paddingBottom))
      / parseFloat(getComputedStyle(el).lineHeight)),
  }))
  // Whole, in at most two lines, and still so a moment later (the width has settled).
  await expect.poll(async () => { const f = await fit(); return f.whole && f.lines <= 2 }, { timeout: 10_000 }).toBe(true)
  await page.waitForTimeout(400)
  expect(await fit()).toMatchObject({ whole: true })
  expect((await fit()).lines).toBeLessThanOrEqual(2)
}

async function shoot(page: Page, name: string): Promise<void> {
  await pill(page).screenshot({ path: `${SHOTS}/${name}-${test.info().project.name}.png` })
}

test.beforeEach(async ({ page }) => {
  await isolatePrefs(page)
  await healthyGitSync(page)
  await page.setViewportSize({ width: 1200, height: 800 })
})

test('available -> Update -> updating -> ready -> Restart -> restarting -> back on the new version, with the panel never opened', async ({ page }) => {
  const sock = await routeSocket(page)
  const r = await routeUpdate(page, status({}, { state: 'off', updatesAuto: false }))
  await loadApp(page)
  // At app start, from the store the notice itself started: nobody opened the panel.
  await expect(pill(page)).toHaveAttribute('data-update-kind', 'server', { timeout: 20_000 })
  await expect(heading(page)).toHaveText('Walnut 0.9.0 available')
  await expect(action(page)).toHaveText('Update')
  await expect(page.locator('.notification-panel')).toHaveCount(0)
  // The collapsed rail shows the short verb; the open sidebar shows the words.
  if (await page.locator('.sidebar.collapsed').count()) {
    await shoot(page, '0-available-collapsed')
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
  await shoot(page, '1-available')

  // Update: the POST answers 202 with the status, the server pushes `downloading`.
  r.set(status({}, { state: 'downloading', version: '0.9.0', updatesAuto: false }))
  await action(page).click()
  await expect.poll(r.installs).toBe(1)
  await expect.poll(() => sock() !== null).toBe(true)
  push(sock(), status({}, { state: 'downloading', version: '0.9.0', updatesAuto: false }))
  await expect(heading(page)).toHaveText('Updating Walnut to 0.9.0…')
  await expect(pill(page)).toHaveAttribute('data-status', 'updating')
  await expect(action(page)).toHaveCount(0)
  // Nothing to click: the open sidebar shows only the words and the ×.
  await expect(pill(page).locator('.stale-build-pill-action.is-status')).toBeHidden()
  await shoot(page, '1b-updating')

  // Installed: Restart, with the idle tooltip.
  const ready = status({ installed: '0.9.0' }, { state: 'installed', version: '0.9.0', updatesAuto: false })
  r.set(ready)
  push(sock(), ready)
  await expect(heading(page)).toHaveText('Walnut 0.9.0 is ready')
  await expect(action(page)).toHaveText('Restart')
  await expect(action(page)).toHaveAttribute('title', 'Restarts by itself once you have been away 10 minutes')
  await shoot(page, '2-ready')

  // Restart: the server says restarting, then goes away.
  const restarting = status({ installed: '0.9.0' }, { state: 'restarting', version: '0.9.0', updatesAuto: false })
  r.set(restarting)
  await action(page).click()
  await expect.poll(r.restarts).toBe(1)
  await expect(heading(page)).toHaveText('Restarting into Walnut 0.9.0…')
  await expect(pill(page)).toHaveAttribute('data-status', 'restarting')
  // While it restarts the × does nothing.
  await expect(pill(page).locator('.stale-build-pill-later')).toHaveAttribute('aria-disabled', 'true')
  await shoot(page, '2b-restarting')

  // The server comes back on 0.9.0; the socket reconnects and the page reads the status again.
  r.set(status({ current: '0.9.0', available: false }, { state: 'idle', updatesAuto: false }))
  const before = r.gets()
  await sock()!.close()
  await expect.poll(r.gets, { timeout: 30_000 }).toBeGreaterThan(before)
  await expect(pill(page)).toHaveAttribute('data-update-kind', 'updated')
  await expect(heading(page)).toHaveText('Walnut updated to 0.9.0')
  await shoot(page, '3-updated')
  // Read: the × dismisses it for this tab (no 30-minute snooze of the next real update).
  await pill(page).locator('.stale-build-pill-later').click()
  await expect(pill(page)).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('open-walnut-update-notice-snooze'))).toBeNull()
})

test('a nightly reads "0.6.25 nightly" untruncated in the open rail; the collapsed rail says Wait with a turning icon while it installs and restarts', async ({ page }) => {
  const v = '0.6.25-nightly.20261103.9000002'
  const nightly = (l: Partial<Live>) => status({ current: '0.6.24-nightly.20261102.9000001', latest: v, channel: 'nightly', tags: { latest: '0.6.24', nightly: v } }, l)
  const sock = await routeSocket(page)
  await routeUpdate(page, nightly({ state: 'downloading', version: v }))
  await loadApp(page)
  await expect(pill(page)).toHaveAttribute('data-status', 'updating', { timeout: 20_000 })
  const busyWord = () => pill(page).locator('.stale-build-pill-action.is-status').evaluate((el) => getComputedStyle(el, '::after').content)
  const spinning = () => pill(page).locator('.stale-build-pill-action.is-status .stale-build-pill-icon').evaluate((el) => getComputedStyle(el).animationName)
  // Collapsed rail (the fixture's default): "Wait" and a turning icon, never a bare "…".
  if (!(await page.locator('.sidebar.collapsed').count())) await page.locator('.sidebar-collapse-btn').click()
  await expect(page.locator('.sidebar.collapsed')).toHaveCount(1)
  expect(await busyWord()).toBe('"Wait"')
  expect(await spinning()).toBe('stale-build-pill-spin')
  // The word fits the rail's card.
  const card = (await pill(page).boundingBox())!
  const word = (await pill(page).locator('.stale-build-pill-action.is-status').boundingBox())!
  expect(word.x + word.width).toBeLessThanOrEqual(card.x + card.width + 0.5)
  await shoot(page, '5-nightly-updating-rail')
  // Open rail: the short form, whole, the full version on the heading's tooltip.
  await page.locator('.sidebar-collapse-btn').click()
  await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  await expect(heading(page)).toHaveText('Updating Walnut to 0.6.25 nightly…')
  await expect(heading(page)).toHaveAttribute('title', `Walnut ${v}`)
  await expectWhole(page)
  await shoot(page, '5-nightly-updating')
  // Ready and restarting, both untruncated; restarting says Wait in the collapsed rail too.
  for (const [state, text] of [['installed', 'Walnut 0.6.25 nightly is ready'], ['restarting', 'Restarting into Walnut 0.6.25 nightly…']] as const) {
    push(sock(), nightly({ state, version: v }))
    await expect(heading(page)).toHaveText(text)
    await expectWhole(page)
    await shoot(page, `5-nightly-${state}`)
  }
  await page.locator('.sidebar-collapse-btn').click()
  await expect(page.locator('.sidebar.collapsed')).toHaveCount(1)
  expect(await busyWord()).toBe('"Wait"')
  expect(await spinning()).toBe('stale-build-pill-spin')
  await shoot(page, '5-nightly-restarting-rail')
})

test('a copy that cannot update itself: "How to update" opens the command with Copy; Done closes it', async ({ page, browserName }) => {
  await routeUpdate(page, status({}, { state: 'off', canInstall: false, updatesAuto: true }))
  await loadApp(page)
  await expect(heading(page)).toHaveText('Walnut 0.9.0 available', { timeout: 20_000 })
  await expect(action(page)).toHaveText('How to update')
  await action(page).click()
  const dialog = page.getByRole('dialog', { name: 'Update Walnut to 0.9.0' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('how-to-update-command-0')).toHaveText('npm install -g open-walnut@latest')
  if (browserName === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await dialog.getByTestId('how-to-update-copy-0').click()
  await expect(dialog.getByTestId('how-to-update-copy-0')).toHaveText(browserName === 'chromium' ? 'Copied' : /Copied|Select and copy/)
  if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npm install -g open-walnut@latest')
  await page.locator('.app-modal').screenshot({ path: `${SHOTS}/4-how-to-update-${test.info().project.name}.png` })
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(pill(page)).toBeVisible()
})

test('auto on: "Updating Walnut to X…" shows at start, and the panel\'s System dot is there on its first open', async ({ page }) => {
  const r = await routeUpdate(page, status({}, { state: 'idle', updatesAuto: true }))
  await loadApp(page)
  await expect(heading(page)).toHaveText('Updating Walnut to 0.9.0…', { timeout: 20_000 })
  expect(r.gets()).toBeGreaterThanOrEqual(1)
  // × hides it, like any update notice.
  await pill(page).locator('.stale-build-pill-later').click()
  await expect(pill(page)).toHaveCount(0)
  await openBell(page)
  await expect(railButton(page, 'System').locator('.nfc-rail-dot')).toHaveCount(1)
})

test('failed: Try again installs again; a refused install opens the command instead', async ({ page }) => {
  const r = await routeUpdate(page, status({}, { state: 'failed', version: '0.9.0', error: 'EACCES: permission denied' }), {
    install: () => ({ status: 409, json: { error: 'cannot_install', fix: 'sudo npm install -g open-walnut@latest' } }),
  })
  await loadApp(page)
  await expect(heading(page)).toHaveText('Walnut 0.9.0 did not install', { timeout: 20_000 })
  await expect(action(page)).toHaveText('Try again')
  await expect(action(page)).toHaveAttribute('title', /EACCES/)
  await action(page).click()
  await expect.poll(r.installs).toBe(1)
  const dialog = page.getByRole('dialog', { name: 'Update Walnut to 0.9.0' })
  await expect(dialog.getByTestId('how-to-update-command-0')).toHaveText('sudo npm install -g open-walnut@latest')
  await dialog.getByRole('button', { name: 'Done' }).click()
})

test('an older server (no live field) shows no server notice, as before', async ({ page }) => {
  const r = await routeUpdate(page, status({}))
  await loadApp(page)
  await expect.poll(r.gets, { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
  // Give the answer a moment to render anything it would.
  await page.waitForTimeout(500)
  await expect(page.locator('.stale-build-pill')).toHaveCount(0)
})
