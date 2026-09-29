import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test } from './shortcut-test-fixture'
import { type Page } from '@playwright/test'

/**
 * The rail's plugin status items (walnut.ui.statusItem), end to end in a real browser.
 *
 * What it pins:
 *   1. An item a plugin publishes shows up live in the rail, ABOVE Voice, and leaves no
 *      gap when it is cleared.
 *   2. The ring ticks from the timer alone: the centre reads minutes left in the
 *      collapsed rail, the title's `{remaining}` is filled in, and the expanded rail
 *      shows words instead of the number.
 *   3. The popover opens beside the rail (never over it, never off-screen), primary
 *      button first; Escape, an outside click and a second click on the item close it.
 *   4. A button runs the plugin's own op and the popover closes on success, again and
 *      again; a failing op keeps it open with the reason and a retry works; a slow op
 *      locks the buttons until it answers.
 *   5. Its footer opens the plugin's App (SPA navigation).
 *   6. Disabling the plugin takes the item away live, a reload brings it back, and a
 *      page reload shows what is live now (the first GET).
 *   7. Rhythm, the real plugin: starting a focus block draws its blue ring, and its
 *      Stop block button ends the block.
 *   8. Rhythm's Stand up now starts the stand-up break (a green countdown), not a new
 *      sitting round; End break starts the sitting count again.
 *
 * Runs against its own server (tests/e2e/browser/status-items-server.ts).
 */

const SHOTS = '/tmp/walnut-rhythm-timer/e2e'
const MIN = 60_000

interface Fixture { port: number; apiPort: number; home: string }

let child: ChildProcessWithoutNullStreams | null = null
let fixture: Fixture | null = null
let output = ''

// Generous: under memory pressure a cold fixture plus one test's clicks took minutes.
test.setTimeout(480_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 820 } })

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function waitForReady(): Promise<Fixture> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Status items fixture did not start\n${output.slice(-8000)}`)), 180_000)
    const timer = setInterval(() => {
      const match = /STATUS_ITEMS_READY (\{.*\})/.exec(output)
      if (match) {
        clearInterval(timer)
        clearTimeout(deadline)
        resolve(JSON.parse(match[1]!) as Fixture)
      } else if (child?.exitCode !== null && child?.exitCode !== undefined) {
        clearInterval(timer)
        clearTimeout(deadline)
        reject(new Error(`Status items fixture exited early (${child.exitCode})\n${output.slice(-8000)}`))
      }
    }, 250)
  })
}

const base = () => `http://127.0.0.1:${fixture!.port}`

async function probe(page: Page, op: string, args: Record<string, unknown> = {}): Promise<void> {
  const res = await page.request.post(`${base()}/api/plugin-runtime/probe/ops/probe_${op}`, { data: args })
  const text = await res.text()
  // The route answers 200 with `{ ok: false }` when the op itself threw.
  expect(res.ok() && (JSON.parse(text) as { ok?: unknown }).ok === true, text).toBe(true)
}

async function show(page: Page, state: Record<string, unknown>): Promise<void> {
  await probe(page, 'show', { state })
}

/** Minutes left on a timer ending at `endsAt`, as the rail rounds them, read at call time. */
const minutesLeft = (endsAt: number) => Math.ceil((endsAt - Date.now()) / MIN)

const item = (page: Page, key = 'probe:probe') => page.locator(`.sidebar-status-item[data-status-key="${key}"]`)
const popover = (page: Page) => page.locator('.status-item-popover')

async function setCollapsed(page: Page, collapsed: boolean): Promise<void> {
  const isCollapsed = (await page.locator('.sidebar.collapsed').count()) > 0
  if (isCollapsed !== collapsed) await page.locator('.sidebar-collapse-btn').click()
  await expect(page.locator('.sidebar.collapsed')).toHaveCount(collapsed ? 1 : 0)
}

async function shootRail(page: Page, name: string): Promise<void> {
  const rail = await page.locator('.sidebar').boundingBox()
  // count() first: boundingBox() on a missing element WAITS for it, which ate the whole
  // test timeout whenever no popover was open.
  const pop = (await popover(page).count()) > 0 ? await popover(page).boundingBox() : null
  const right = Math.max(rail!.x + rail!.width, pop ? pop.x + pop.width : 0) + 16
  const top = Math.max(0, Math.min(rail!.y + rail!.height - 330, pop ? pop.y - 16 : Infinity))
  await page.screenshot({ timeout: 60_000, path: `${SHOTS}/${name}.png`, clip: { x: 0, y: top, width: Math.min(1280, right), height: rail!.y + rail!.height - top } })
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await fs.mkdir(SHOTS, { recursive: true })
  const port = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/status-items-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_STATUS_ITEMS_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  fixture = await waitForReady()
})

test.afterAll(async () => {
  if (!child) return
  child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 2000))
  if (child.exitCode === null) child.kill('SIGKILL')
})

test('an item shows up above Voice, ticks from its timer, and leaves no gap when cleared', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${base()}/`)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await setCollapsed(page, true)

  await expect(item(page)).toBeVisible({ timeout: 30_000 })
  await expect(item(page)).toHaveAttribute('aria-label', 'Probe ready')
  // Above Voice, inside the notification area.
  const order = await page.locator('.sidebar-notification-area > .sidebar-link').evaluateAll((els) => els.map((el) => el.className))
  const at = order.findIndex((name) => name.includes('sidebar-status-item'))
  expect(at).toBeGreaterThanOrEqual(0)
  expect(order[at + 1]).toContain('sidebar-voice-btn')
  const railBox = await page.locator('.sidebar-voice-btn').boundingBox()
  const itemBox = await item(page).boundingBox()
  expect(Math.round(itemBox!.height)).toBe(Math.round(railBox!.height))

  const now = Date.now()
  const startedAt = now - 5 * MIN
  const endsAt = now + 25 * MIN - 2_000
  await show(page, {
    title: 'Focus · {remaining} left', tone: 'accent',
    timer: { startedAt, endsAt, mode: 'drain' },
    actions: [{ label: 'Stop block', op: 'hide' }],
  })
  // Read against the clock at assertion time, so a slow machine cannot turn 25 into 24.
  await expect.poll(async () => (await item(page).getAttribute('aria-label')) === `Focus · ${minutesLeft(endsAt)} min left`).toBe(true)
  await expect(item(page)).toHaveAttribute('data-tone', 'accent')
  await expect.poll(async () => (await item(page).locator('svg text').textContent()) === String(minutesLeft(endsAt))).toBe(true)
  // Drain: the arc is the share of the 30-minute window still left.
  const drawn = await item(page).locator('.status-ring-arc').evaluate((el) => {
    const c = Number(el.getAttribute('stroke-dasharray'))
    return 1 - Number(el.getAttribute('stroke-dashoffset')) / c
  })
  const expected = (endsAt - Date.now()) / (endsAt - startedAt)
  expect(Math.abs(drawn - expected)).toBeLessThan(0.02)
  await shootRail(page, '01-collapsed-focus')

  await setCollapsed(page, false)
  await expect.poll(async () => (await item(page).locator('.sidebar-label').textContent()) === `Focus · ${minutesLeft(endsAt)} min left`).toBe(true)
  await expect(item(page).locator('svg text')).toBeHidden()
  await shootRail(page, '02-expanded-focus')

  await probe(page, 'hide')
  await expect(page.locator('.sidebar-status-item')).toHaveCount(0)
  // No leftover wrapper or spacer where it was.
  const first = await page.locator('.sidebar-notification-area > *').first().getAttribute('class')
  expect(first).toContain('sidebar-voice-btn')
  expect(errors).toEqual([])
})

test('the popover opens beside the rail, and a button runs the op again and again', async ({ page, browserName }) => {
  await page.goto(`${base()}/`)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await setCollapsed(page, true)
  await show(page, {
    title: 'Time to stand up', detail: '1h 02m at the keyboard. Walk for a couple of minutes.',
    tone: 'warning', glyph: 'stand',
    actions: [{ label: 'Snooze 10 min', op: 'hide' }, { label: 'Got it', op: 'ack', primary: true }],
  })
  await expect(item(page)).toHaveAttribute('data-tone', 'warning')
  await expect(item(page).locator('.status-ring-glyph')).toHaveCount(1)
  await expect(item(page).locator('svg text')).toHaveCount(0)

  await item(page).click()
  await expect(popover(page)).toBeVisible()
  await expect(popover(page).locator('.status-item-popover-title')).toHaveText('Time to stand up')
  await expect(popover(page).locator('.status-item-popover-detail')).toHaveText('1h 02m at the keyboard. Walk for a couple of minutes.')
  await expect(popover(page).locator('.status-item-btn')).toHaveText(['Got it', 'Snooze 10 min'])
  await expect(popover(page).locator('.status-item-btn.is-primary')).toHaveText('Got it')
  await expect(item(page)).toHaveAttribute('aria-expanded', 'true')

  // Beside the rail, bottom level with the item, fully on screen. Measured at rest: the
  // popover slides in 4px, and a fast run otherwise reads it mid-animation.
  await popover(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  const rail = (await page.locator('.sidebar').boundingBox())!
  const trigger = (await item(page).boundingBox())!
  const box = (await popover(page).boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(rail.x + rail.width)
  expect(Math.abs(box.y + box.height - (trigger.y + trigger.height))).toBeLessThanOrEqual(2)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(1280)
  await shootRail(page, '03-popover-due')

  await popover(page).getByRole('button', { name: 'Got it' }).click()
  await expect(popover(page)).toHaveCount(0)
  await expect(item(page)).toHaveAttribute('aria-label', 'Acknowledged 1')
  await expect(item(page)).toHaveAttribute('data-tone', 'success')

  // The same button, twice more: never only the first round.
  for (const n of [2, 3]) {
    await item(page).click()
    await popover(page).getByRole('button', { name: 'Again' }).click()
    await expect(popover(page)).toHaveCount(0)
    await expect(item(page)).toHaveAttribute('aria-label', `Acknowledged ${n}`)
  }

  // Keyboard: focus moves into the popover without drawing a ring around it (WebKit
  // did), Tab lands on the primary button, Enter runs it.
  await item(page).click()
  await expect(popover(page)).toBeVisible()
  expect(await popover(page).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none')
  // WebKit follows macOS: plain Tab skips buttons, Option+Tab reaches them (as in Safari).
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab')
  await expect(popover(page).getByRole('button', { name: 'Again' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(popover(page)).toHaveCount(0)
  await expect(item(page)).toHaveAttribute('aria-label', 'Acknowledged 4')

  // Closing: Escape, a second click on the item, an outside click.
  await item(page).click()
  await expect(popover(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(popover(page)).toHaveCount(0)
  await item(page).click()
  await expect(popover(page)).toBeVisible()
  await item(page).click()
  await expect(popover(page)).toHaveCount(0)
  await item(page).click()
  await page.mouse.click(900, 300)
  await expect(popover(page)).toHaveCount(0)
})

test('a failing op keeps the popover open with the reason; a slow one locks the buttons', async ({ page }) => {
  await page.goto(`${base()}/`)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await setCollapsed(page, true)
  await show(page, {
    title: 'Probe choices', tone: 'neutral',
    actions: [{ label: 'Refuse', op: 'refuse', primary: true }, { label: 'Slow', op: 'slow' }, { label: 'Ack', op: 'ack' }],
  })
  await item(page).click()
  await popover(page).getByRole('button', { name: 'Refuse' }).click()
  await expect(popover(page).locator('.status-item-popover-error')).toContainText('Probe refused on purpose')
  await expect(popover(page)).toBeVisible()
  await shootRail(page, '04-popover-error')

  await popover(page).getByRole('button', { name: 'Slow' }).click()
  await expect(popover(page).locator('.status-item-btn').first()).toBeDisabled()
  await expect(popover(page).locator('.status-item-popover-error')).toHaveCount(0)
  await expect(popover(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(item(page)).toHaveAttribute('aria-label', 'Slow one finished')

  // The item went away while its popover was open: the popover goes with it.
  await show(page, { title: 'About to vanish', actions: [{ label: 'Ack', op: 'ack' }] })
  await item(page).click()
  await expect(popover(page)).toBeVisible()
  await probe(page, 'hide')
  await expect(popover(page)).toHaveCount(0)
})

test('the footer opens the plugin App, and the item follows disable, reload and a page reload', async ({ page }) => {
  await page.goto(`${base()}/`)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await setCollapsed(page, true)
  await show(page, { title: 'Probe footer', detail: 'Opens the App.' })
  await item(page).click()
  await expect(popover(page).locator('.status-item-popover-foot')).toContainText('Probe')
  await popover(page).getByRole('button', { name: 'Open Probe' }).click()
  await expect(page.getByTestId('probe-app')).toBeVisible({ timeout: 30_000 })
  await expect(popover(page)).toHaveCount(0)

  const disabled = await page.request.post(`${base()}/api/plugin-runtime/probe/disable`, { data: {} })
  expect(disabled.ok(), await disabled.text()).toBe(true)
  await expect(page.locator('.sidebar-status-item[data-status-key="probe:probe"]')).toHaveCount(0)

  const reloaded = await page.request.post(`${base()}/api/plugin-runtime/probe/reload`, { data: {} })
  expect(reloaded.ok(), await reloaded.text()).toBe(true)
  await expect(item(page)).toHaveAttribute('aria-label', 'Probe ready', { timeout: 30_000 })

  await show(page, { title: 'Survives a page reload', tone: 'success', glyph: 'check' })
  await page.reload()
  await expect(item(page)).toHaveAttribute('aria-label', 'Survives a page reload', { timeout: 60_000 })
})

test('Rhythm: a focus block draws the blue ring, and Stop block ends it', async ({ page }) => {
  await page.goto(`${base()}/`)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await setCollapsed(page, true)
  await probe(page, 'hide')
  const started = await page.request.post(`${base()}/api/plugin-runtime/walnut-rhythm/ops/walnut_rhythm_focus_start`, { data: { minutes: 25 } })
  const startedText = await started.text()
  expect(started.ok() && (JSON.parse(startedText) as { ok?: unknown }).ok === true, startedText).toBe(true)

  const endsAt = (JSON.parse(startedText) as { result: { state: { focus: { endsAt: number } } } }).result.state.focus.endsAt
  const rhythm = item(page, 'walnut-rhythm:rhythm')
  await expect(rhythm).toHaveAttribute('data-tone', 'accent', { timeout: 30_000 })
  await expect.poll(async () => (await rhythm.getAttribute('aria-label')) === `Focus · ${minutesLeft(endsAt)} min left`).toBe(true)
  await expect.poll(async () => (await rhythm.locator('svg text').textContent()) === String(minutesLeft(endsAt))).toBe(true)
  await rhythm.click()
  await expect(popover(page).locator('.status-item-popover-detail')).toHaveText('Walnut is quiet until it ends.')
  await expect(popover(page).locator('.status-item-btn')).toHaveText(['Stop block'])
  await expect(popover(page).getByRole('button', { name: 'Open Rhythm' })).toBeVisible()
  await shootRail(page, '05-rhythm-focus')

  await popover(page).getByRole('button', { name: 'Stop block' }).click()
  await expect(popover(page)).toHaveCount(0)
  // Stopped: no block runs, so the ring is either gone or back to the grey stand-up count.
  await expect(page.locator('.sidebar-status-item[data-status-key="walnut-rhythm:rhythm"][data-tone="accent"]')).toHaveCount(0)
  const status = await page.request.post(`${base()}/api/plugin-runtime/walnut-rhythm/ops/walnut_rhythm_status`, { data: {} })
  const body = await status.json() as { ok: boolean; result: { focus: { phase: string } } }
  expect(body.result.focus.phase).toBe('idle')
})

test('Rhythm: Stand up now starts the stand-up break countdown, and End break starts the count again', async ({ page }) => {
  await page.goto(`${base()}/`)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await setCollapsed(page, true)
  await probe(page, 'hide')
  // Three minutes at the keyboard, banked the way the console's own heartbeat banks it.
  const now = Date.now()
  const banked = await page.request.post(`${base()}/api/time/heartbeats`, {
    data: { samples: [{ ts: new Date(now - 3 * 60_000).toISOString(), durationMs: 3 * 60_000, kind: 'triage' }] },
  })
  expect(banked.status()).toBe(204)

  const rhythm = item(page, 'walnut-rhythm:rhythm')
  await expect(rhythm).toHaveAttribute('data-tone', 'neutral', { timeout: 30_000 })
  await expect(rhythm).toHaveAttribute('aria-label', /^Stand up in \d+ min$/)
  await rhythm.click()
  await expect(popover(page).locator('.status-item-btn')).toHaveText(['Stand up now', 'Start focus block'])
  await shootRail(page, '06-rhythm-counting')

  // The user's report: this button must start a timer to stand up for, not a new round.
  await popover(page).getByRole('button', { name: 'Stand up now' }).click()
  await expect(popover(page)).toHaveCount(0)
  await expect(rhythm).toHaveAttribute('data-tone', 'success')
  await expect.poll(async () => rhythm.getAttribute('aria-label')).toMatch(/^Break · (10|9) min left$/)
  await expect(rhythm.locator('svg text')).toHaveText(/^(10|9)$/)
  await rhythm.click()
  await expect(popover(page).locator('.status-item-popover-detail')).toHaveText('Walk, stretch, look away from the screen. The sitting count starts when it ends.')
  await expect(popover(page).locator('.status-item-btn')).toHaveText(['End break'])
  await shootRail(page, '07-rhythm-stand-break')

  await popover(page).getByRole('button', { name: 'End break' }).click()
  await expect(popover(page)).toHaveCount(0)
  await expect(rhythm).toHaveAttribute('data-tone', 'neutral')
  await expect(rhythm).toHaveAttribute('aria-label', 'Stand up in 1 h')
  const status = await page.request.post(`${base()}/api/plugin-runtime/walnut-rhythm/ops/walnut_rhythm_status`, { data: {} })
  const body = await status.json() as { ok: boolean; result: { focus: { phase: string }; today: { breaksTaken: number } } }
  expect(body.result.focus.phase).toBe('idle')
  expect(body.result.today.breaksTaken).toBeGreaterThanOrEqual(1)
})
