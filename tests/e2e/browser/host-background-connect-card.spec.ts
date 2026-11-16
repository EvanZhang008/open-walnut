/**
 * The card a host's first connect shows in the corner while it runs in the background
 * (web/src/components/hosts/HostConnectCard.tsx). 2026-11-13, the user: "why isn't there some
 * progress bar? ... make it clear, close & run background that make it clear that it will still
 * running ... make it maybe collapse into an always on notification like this" (the approval card).
 *
 *  - first run: Add a host, the dialog's way out reads Run in background; it closes the dialog and
 *    the card shows the connect: the step, the bytes, the bar, and that it keeps going;
 *  - "–" puts it down to one line ("Connecting to lab-mac · 34%") that stays; a click opens it;
 *  - connected: "<name> is connected" for a few seconds, then the card is gone;
 *  - a reload during the connect shows the card again (the server still flags it);
 *  - a failure lets the host go (the Notifications panel says why); the server's retry loop never
 *    brings it back, a fresh attempt does;
 *  - an established host reconnecting shows no card;
 *  - it never takes the focus from what the person types in.
 *
 * Host statuses are the test's: the found-answer reply, GET /api/hosts/status and host:status
 * pushes on the real SPA WebSocket (the server's own host:status frames are held back).
 * WebKit: `PW_WEBKIT=1 bun x playwright test host-background-connect-card --project=webkit --workers=1`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Locator, type Page, type Route, type WebSocketRoute } from '@playwright/test'
import { dropFakes } from './route-teardown'

test.setTimeout(180_000)

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/wn-host-background-connect'
const MB = 1_048_576
const STEPS = [
  ['ssh', 'SSH'], ['probe', 'Probe'], ['install-runtime', 'Install runtime'],
  ['upload', 'Upload daemon'], ['start', 'Start daemon'], ['tunnel', 'Tunnel'], ['handshake', 'Handshake'],
] as const

/** A host's status at `phase`, the steps before it done; `bytes` puts a transfer on the upload step. */
function statusOf(host: string, phase: string, over: Record<string, unknown> = {}, bytes?: { done: number; total: number }) {
  const active = STEPS.findIndex(([p]) => p === phase)
  const connected = phase === 'connected'
  return {
    host, label: host, hostname: `${host}.example.test`, connected, phase,
    phaseLabel: phase === 'upload' ? `Uploading the session daemon to ${host}` : connected ? '' : `Connecting to ${host}: ${phase}`,
    steps: STEPS.map(([p, label], i) => ({
      phase: p, label,
      status: connected || (active >= 0 && i < active) ? 'done' : i === active ? 'active' : 'todo',
      ...(i === active && bytes ? { progress: { via: 'upload', ...bytes } } : {}),
    })),
    phaseElapsedMs: 0, connectElapsedMs: 0, at: Date.now(),
    ...(connected ? { connectedAt: Date.now() } : {}),
    ...over,
  }
}
const firstUpload = (host: string) => statusOf(host, 'upload', { firstConnect: true }, { done: 23 * MB, total: 67 * MB })
const failed = (host: string, over: Record<string, unknown> = {}) => statusOf(host, 'failed', { error: `ssh: connect to host ${host}.example.test port 22: Connection refused`, kind: 'refused', ...over })

interface Fake {
  pending: string[]
  statuses: Record<string, Record<string, unknown>>
  found: Record<string, Record<string, unknown>>
  push(status: Record<string, unknown>): void
}

async function serve(page: Page, baseURL: string, opts: { pending?: string[]; statuses?: Record<string, Record<string, unknown>>; found?: Record<string, Record<string, unknown>> } = {}): Promise<Fake> {
  let socket: WebSocketRoute | undefined
  const fake: Fake = {
    pending: [...(opts.pending ?? [])],
    statuses: { ...(opts.statuses ?? {}) },
    found: { ...(opts.found ?? {}) },
    push(status) {
      fake.statuses[status.host as string] = status
      expect(socket, 'the SPA WebSocket is connected').toBeDefined()
      socket!.send(JSON.stringify({ type: 'event', name: 'host:status', data: status, seq: Date.now() }))
    },
  }
  await page.routeWebSocket('**/ws*', (ws) => {
    socket = ws
    const server = ws.connectToServer()
    // The real socket stays; only the server's own host frames are held back, so the test's are the truth.
    server.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as { type?: string; name?: string }
      if (frame.type !== 'event' || frame.name !== 'host:status') ws.send(message)
    })
  })
  await page.route((url) => url.pathname === '/api/first-run', (route) => route.fulfill({ json: { pending: fake.pending } }))
  await page.route((url) => url.pathname === '/api/first-run/answer', async (route) => {
    const { step } = route.request().postDataJSON() as { step: string }
    fake.pending = fake.pending.filter((s) => s !== step)
    await route.fulfill({ json: { ok: true, pending: fake.pending } })
  })
  await page.route((url) => url.pathname === '/api/hosts/status', (route) => route.fulfill({ json: { hosts: Object.values(fake.statuses) } }))
  await page.route((url) => url.pathname === '/api/config', async (route: Route) => {
    if (route.request().method() !== 'GET') { await route.fulfill({ json: { ok: true } }); return }
    const res = await route.fetch()
    const body = await res.json() as { config: { hosts?: Record<string, unknown> } }
    await route.fulfill({ response: res, json: { ...body, config: { ...body.config, hosts: { ...(body.config.hosts ?? {}), ...fake.found } } } })
  })
  await page.route('**/api/hosts/*/found-answer', async (route: Route) => {
    const host = decodeURIComponent(route.request().url().split('/api/hosts/')[1].split('/')[0])
    const { answer } = route.request().postDataJSON() as { answer: string }
    fake.found[host] = { ...fake.found[host], connect: answer, enabled: answer === 'yes' }
    if (answer === 'yes') fake.statuses[host] = firstUpload(host)
    await route.fulfill({ json: { ok: true, host, answer, ...(answer === 'yes' ? { status: fake.statuses[host] } : {}) } })
  })
  await page.route('**/api/hosts/*/ssh-key', (route) => route.fulfill({ json: { key: null } }))
  // Open the console with a real click (no page.goto into the SPA).
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect.poll(() => !!socket, { timeout: 60_000 }).toBe(true)
  return fake
}

async function shot(page: Page, name: string, region: Locator) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test.afterEach(async ({ page }) => { await dropFakes(page) })

const card = (page: Page) => page.getByTestId('host-connect-card')
const pill = (page: Page) => page.getByTestId('host-connect-pill')

test('Run in background closes the setup and the corner card follows the connect to its end', async ({ page, baseURL }) => {
  const fake = await serve(page, baseURL!, {
    pending: ['hosts'],
    found: { 'lab-mac': { hostname: '10.0.0.9', user: 'sam', discovered: true, connect: 'ask', enabled: false } },
  })
  const dialog = page.getByTestId('first-run-dialog')
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('first-run-add-lab-mac').click()
  // The way out says the connect goes on without the dialog.
  await expect(page.getByTestId('first-run-primary')).toHaveText('Run in background')
  await expect(page.getByTestId('first-run-later')).toHaveText('Connecting keeps going in the background: you can close this.')
  await shot(page, 'setup-run-in-background', dialog.locator('.fr-modal'))
  await page.getByTestId('first-run-primary').click()
  await expect(dialog).toHaveCount(0)

  // The card: which host, the step, the bytes and the bar, and that it keeps going.
  await expect(card(page)).toBeVisible()
  const row = page.getByTestId('host-connect-row-lab-mac')
  await expect(row).toContainText('Connecting to lab-mac')
  await expect(row).toContainText('Uploading the session daemon to lab-mac')
  await expect(row).toContainText('23 of 67 MB sent')
  await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '34')
  await expect(page.getByTestId('host-connect-note')).toHaveText('Keeps going in the background. You can close this window.')
  // In the notice stack at the top of the window, inside it.
  const box = (await card(page).boundingBox())!
  const view = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeLessThanOrEqual(view.height / 2)
  expect(box.x + box.width).toBeLessThanOrEqual(view.width)
  expect(box.y + box.height).toBeLessThanOrEqual(view.height)
  expect(await card(page).evaluate((el) => !!el.closest('.corner-stack'))).toBe(true)
  await shot(page, 'card', card(page))

  // "–": one line that stays, with how far it is; a click opens the card again.
  await page.getByTestId('host-connect-minimize').click()
  await expect(card(page)).toHaveCount(0)
  await expect(pill(page)).toBeVisible()
  await expect(pill(page)).toHaveAccessibleName('Connecting to lab-mac · 34%')
  await expect(pill(page)).toContainText('34%')
  await shot(page, 'pill', pill(page))
  // Still there a while later: it stays until the connect ends.
  await page.waitForTimeout(1_500)
  await expect(pill(page)).toBeVisible()
  await pill(page).click()
  await expect(card(page)).toBeVisible()

  // Connected: it says so for a few seconds, then the card is gone.
  fake.push(statusOf('lab-mac', 'connected'))
  await expect(row).toHaveText(/lab-mac is connected/)
  await expect(page.getByTestId('host-connect-note')).toHaveCount(0)
  await shot(page, 'connected', card(page))
  await expect(card(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(pill(page)).toHaveCount(0)
})

test('a reload during the connect shows the card again, at the same place in the connect', async ({ page, baseURL }) => {
  await serve(page, baseURL!, { statuses: { 'build-box': firstUpload('build-box') } })
  await expect(page.getByTestId('host-connect-row-build-box')).toContainText('23 of 67 MB sent', { timeout: 30_000 })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  const row = page.getByTestId('host-connect-row-build-box')
  await expect(row).toContainText('Connecting to build-box', { timeout: 30_000 })
  await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '34')
  await shot(page, 'after-reload', card(page))
})

test('a failure lets the host go from the card, and a new attempt of it brings it back', async ({ page, baseURL }) => {
  const fake = await serve(page, baseURL!, { statuses: { 'build-box': firstUpload('build-box'), 'lab-box': statusOf('lab-box', 'install-runtime', { firstConnect: true }) } })
  await expect(page.getByTestId('host-connect-row-build-box')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('host-connect-row-lab-box')).toContainText('2 of 7 steps complete')
  const firstTry = Date.now() - 60_000
  fake.push(failed('build-box', { attemptStartedAt: firstTry }))
  await expect(page.getByTestId('host-connect-row-build-box')).toHaveCount(0)
  await expect(page.getByTestId('host-connect-row-lab-box')).toBeVisible()
  // The retry loop's pause after it, then one of its dials (a new attempt carrying the loop's last
  // failure): still out, so a machine that is switched off never pops the card up again by itself.
  fake.push(statusOf('build-box', 'reconnecting', { firstConnect: true, attemptStartedAt: firstTry, lastError: 'Connection refused' }))
  fake.push(statusOf('build-box', 'ssh', { firstConnect: true, attemptStartedAt: Date.now(), lastError: 'Connection refused' }))
  await page.waitForTimeout(500)
  await expect(page.getByTestId('host-connect-row-build-box')).toHaveCount(0)
  // The other one failing too: nothing left, no card.
  fake.push(failed('lab-box'))
  await expect(card(page)).toHaveCount(0)
  await expect(pill(page)).toHaveCount(0)
  // A fresh attempt with no failure before it: back in the card.
  fake.push(statusOf('build-box', 'ssh', { firstConnect: true, attemptStartedAt: Date.now() }))
  await expect(page.getByTestId('host-connect-row-build-box')).toContainText('Connecting to build-box')
  await shot(page, 'retry-shown-again', card(page))
})

test('an established host reconnecting shows no card', async ({ page, baseURL }) => {
  const fake = await serve(page, baseURL!, { statuses: { 'old-box': statusOf('old-box', 'connected') } })
  await expect.poll(() => page.evaluate(() => document.readyState)).toBe('complete')
  await page.waitForTimeout(1_500)
  // The link drops and the reconnect walks the steps again: no first connect flag, no card.
  fake.push(statusOf('old-box', 'reconnecting', { reconnectSince: Date.now() }))
  for (const phase of ['ssh', 'probe', 'tunnel', 'handshake']) fake.push(statusOf('old-box', phase))
  await page.waitForTimeout(1_500)
  await expect(card(page)).toHaveCount(0)
  await expect(pill(page)).toHaveCount(0)
  fake.push(statusOf('old-box', 'connected'))
  await page.waitForTimeout(500)
  await expect(card(page)).toHaveCount(0)
})

test('the card never takes the focus from what the person types in', async ({ page, baseURL }) => {
  const fake = await serve(page, baseURL!)
  // The task list's search box: on Home whatever the board holds or which columns are open.
  const composer = page.getByRole('textbox', { name: /Search tasks/ }).first()
  await expect(composer).toBeVisible({ timeout: 60_000 })
  await composer.click()
  await page.keyboard.type('hello')
  // A first connect starts while the person types: the card shows, the caret stays.
  fake.push(firstUpload('build-box'))
  await expect(card(page)).toBeVisible()
  await expect(composer).toBeFocused()
  await page.keyboard.type(' there')
  await expect(composer).toHaveValue(/hello there$/)
  // A mouse click on its "–" and on its line leaves the caret where it was too.
  await page.getByTestId('host-connect-minimize').click()
  await expect(pill(page)).toBeVisible()
  await expect(composer).toBeFocused()
  await pill(page).click()
  await expect(card(page)).toBeVisible()
  await expect(composer).toBeFocused()
  await page.keyboard.type('!')
  await expect(composer).toHaveValue(/hello there!$/)
  await composer.fill('')
})
