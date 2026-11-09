import { bunRuntime } from '../../helpers/bun-runtime.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test } from './shortcut-test-fixture'
import { type Locator, type Page } from '@playwright/test'

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
 *   4. A button closes the popover at once and runs the plugin's own op, again and again;
 *      a slow op shows on the item (pulsing, "Slow…") and locks the buttons until it
 *      answers; a failing op reopens the popover with the reason and a retry works.
 *   5. Its footer opens the plugin's App (SPA navigation).
 *   6. Disabling the plugin takes the item away live, a reload brings it back, and a
 *      page reload shows what is live now (the first GET).
 *   7. Rhythm, the real plugin: off, its ring's one Start begins a focus block (a blue
 *      ring that names when it started and ends), and Stop block turns it off again.
 *   8. Rhythm never starts on its own: keyboard time banked for 90 minutes and a page
 *      reload leave the ring at "Rhythm is off", with no countdown.
 *   9. A notice (toast) button closes its toast at once, before a slow op answers; a
 *      failing one answers in its own error toast.
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

/**
 * A toast that came up or moved under the pointer ignores a click until it has settled
 * (useShiftClickGuard, d8a7fd515: a click there was meant for what was under it before), and the
 * corner moves a new toast once more as it makes room for it (above System attention). Settled:
 * no mark and no move for a whole guard window (SHIFT_GUARD_MS, 450 ms).
 */
async function settledToast(toast: Locator): Promise<void> {
  await expect.poll(() => toast.evaluate((el) => new Promise<boolean>((resolve) => {
    const top = el.getBoundingClientRect().top
    if (el.hasAttribute('data-settling')) { resolve(false); return }
    setTimeout(() => resolve(!el.hasAttribute('data-settling') && el.getBoundingClientRect().top === top), 500)
  })), { timeout: 15_000 }).toBe(true)
}

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
  // The popover fades in over 0.16s; a shot taken inside it shows a ghost, not the design.
  if (pop) await popover(page).evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))))
  const right = Math.max(rail!.x + rail!.width, pop ? pop.x + pop.width : 0) + 16
  const top = Math.max(0, Math.min(rail!.y + rail!.height - 330, pop ? pop.y - 16 : Infinity))
  await page.screenshot({ timeout: 60_000, path: `${SHOTS}/${name}.png`, clip: { x: 0, y: top, width: Math.min(1280, right), height: rail!.y + rail!.height - top } })
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await fs.mkdir(SHOTS, { recursive: true })
  const port = await reservePort()
  child = spawn(bunRuntime(), ['tests/e2e/browser/status-items-server.ts'], {
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

test('an item shows up above the bell, ticks from its timer, and leaves no gap when cleared', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${base()}/`)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await setCollapsed(page, true)

  await expect(item(page)).toBeVisible({ timeout: 30_000 })
  await expect(item(page)).toHaveAttribute('aria-label', 'Probe ready')
  // Above the bell, inside the notification area.
  const order = await page.locator('.sidebar-notification-area > .sidebar-link').evaluateAll((els) => els.map((el) => el.className))
  // Every item (the probe, and Rhythm's ring, which the fixture also loads) sits right above the bell.
  const last = order.map((name) => name.includes('sidebar-status-item')).lastIndexOf(true)
  expect(last).toBeGreaterThanOrEqual(0)
  expect(order[last + 1]).toContain('sidebar-notification-btn')
  const railBox = await page.locator('.sidebar-notification-btn').boundingBox()
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
  await expect(item(page)).toHaveCount(0)
  // No leftover wrapper or spacer where it was (the update notice's empty slot takes no room):
  // only the items still shown (Rhythm's ring) come before the bell.
  const visible = await page.locator('.sidebar-notification-area > *:visible').evaluateAll((els) => els.map((el) => el.className))
  const bell = visible.findIndex((name) => name.includes('sidebar-notification-btn'))
  expect(bell).toBeGreaterThanOrEqual(0)
  expect(visible.slice(0, bell).every((name) => name.includes('sidebar-status-item'))).toBe(true)
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
  // A plugin with no panel of its own (status-item.panel) keeps exactly the buttons it published.
  await expect(popover(page).locator('.status-item-popover-panel')).toBeHidden()
  await expect(popover(page)).not.toHaveAttribute('data-panel', 'true')
  await expect(item(page)).toHaveAttribute('aria-expanded', 'true')

  // Beside the rail, bottom level with the item, fully on screen. Measured at rest: the
  // popover slides in 4px, and a fast run otherwise reads it mid-animation.
  await popover(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined))))
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

test('a button answers at once even when its op is slow; a failure reopens with the reason', async ({ page }) => {
  await page.goto(`${base()}/`)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await setCollapsed(page, true)
  const choices = {
    title: 'Probe choices', tone: 'neutral',
    actions: [{ label: 'Refuse', op: 'refuse', primary: true }, { label: 'Slow', op: 'slow' }, { label: 'Ack', op: 'ack' }],
  }
  await show(page, choices)

  // The op takes 3s on the server. The popover must be gone while it is still running,
  // and the item must say so: closing only when the op answered is the reported bug.
  await item(page).click()
  const clicked = Date.now()
  await popover(page).getByRole('button', { name: 'Slow' }).click()
  await expect(popover(page)).toHaveCount(0)
  const closedMs = Date.now() - clicked
  await expect(item(page)).toHaveAttribute('aria-busy', 'true')
  await expect(item(page)).toHaveAttribute('aria-label', 'Slow…')
  await expect(item(page)).toHaveClass(/is-pending/)
  test.info().annotations.push({ type: 'popover-closed-ms', description: String(closedMs) })
  // Opened again while it runs: the buttons wait instead of stacking a second op.
  await item(page).click()
  await expect(popover(page).locator('.status-item-btn').first()).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(item(page)).toHaveAttribute('aria-label', 'Slow one finished', { timeout: 15_000 })
  await expect(item(page)).not.toHaveAttribute('aria-busy', 'true')
  await expect(item(page)).not.toHaveClass(/is-pending/)

  // A refusal: closes on the click, then reopens at its item with the reason, and a
  // retry from there works.
  await show(page, choices)
  await item(page).click()
  await popover(page).getByRole('button', { name: 'Refuse' }).click()
  await expect(popover(page).locator('.status-item-popover-error')).toContainText('Probe refused on purpose')
  await expect(popover(page).locator('.status-item-btn').first()).toBeEnabled()
  await shootRail(page, '04-popover-error')
  await popover(page).getByRole('button', { name: 'Ack' }).click()
  await expect(popover(page)).toHaveCount(0)
  await expect(item(page)).toHaveAttribute('aria-label', /^Acknowledged \d+$/)

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

test('Rhythm: the off ring\'s panel picks the lengths and music, Start begins the block, its running panel stops it', async ({ page }) => {
  await page.goto(`${base()}/`)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await setCollapsed(page, true)
  await probe(page, 'hide')
  const rhythm = item(page, 'walnut-rhythm:rhythm')
  await expect(rhythm).toHaveAttribute('aria-label', 'Rhythm is off', { timeout: 30_000 })
  await rhythm.click()
  // Rhythm draws its own Start form in the popover (status-item.panel): the item's one button steps aside.
  const form = popover(page).getByTestId('rhythm-start-form')
  await expect(form).toBeVisible({ timeout: 20_000 })
  await expect(popover(page)).toHaveAttribute('data-panel', 'true')
  await expect(popover(page).locator('.status-item-btn')).toHaveCount(0)
  await expect(form.getByTestId('rhythm-start-focus-input')).toHaveValue('25')
  await expect(form.getByTestId('rhythm-start-break-input')).toHaveValue('5')
  // The fixture's music folder is empty: Start says plainly it plays nothing.
  await expect(form.getByTestId('rhythm-start-music-none')).toHaveAttribute('aria-checked', 'true')
  await expect(form.getByTestId('rhythm-start-plays')).toHaveText('Start plays no music.')
  await form.getByTestId('rhythm-start-focus-15').click()
  await form.getByTestId('rhythm-start-break-input').fill('10')
  await expect(form.getByTestId('rhythm-start-button')).toHaveText('Start 15 min focus')
  await expect(form.getByTestId('rhythm-start-then')).toHaveText('then a 10 min break')
  // A typed length out of range blocks Start and says the range.
  await form.getByTestId('rhythm-start-focus-input').fill('2')
  await expect(form.getByTestId('rhythm-start-invalid')).toHaveText('Focus is 5 to 180 minutes.')
  await expect(form.getByTestId('rhythm-start-button')).toBeDisabled()
  await form.getByTestId('rhythm-start-focus-input').fill('15')
  await shootRail(page, '05-rhythm-off')

  await form.getByTestId('rhythm-start-button').click()
  await expect(popover(page)).toHaveCount(0, { timeout: 20_000 })
  await expect(rhythm).toHaveAttribute('data-tone', 'accent', { timeout: 30_000 })
  const status = await page.request.post(`${base()}/api/plugin-runtime/walnut-rhythm/ops/walnut_rhythm_status`, { data: {} })
  const running = ((await status.json()) as { result: { focus: { endsAt: number; minutes: number }; config: { focusMinutes: number; breakMinutes: number } } }).result
  const endsAt = running.focus.endsAt
  expect(running.focus.minutes).toBe(15)
  // The pick is the next default: Rhythm's settings now say 15 and 10.
  expect(running.config).toMatchObject({ focusMinutes: 15, breakMinutes: 10 })
  await expect.poll(async () => (await rhythm.getAttribute('aria-label')) === `Focus · ${minutesLeft(endsAt)} min left`).toBe(true)
  await expect.poll(async () => (await rhythm.locator('svg text').textContent()) === String(minutesLeft(endsAt))).toBe(true)
  await rhythm.click()
  await expect(popover(page).locator('.status-item-popover-detail')).toHaveText(/^Started \d\d:\d\d, ends \d\d:\d\d\. Walnut is quiet until it ends\.$/)
  // While a block runs the panel says what plays and offers the music to switch, with its own Stop block.
  const runningPanel = popover(page).getByTestId('rhythm-running-panel')
  await expect(runningPanel).toBeVisible()
  await expect(popover(page).getByTestId('rhythm-start-form')).toHaveCount(0)
  await expect(runningPanel.getByTestId('rhythm-now-playing-line')).toHaveText('No music is playing.')
  await expect(runningPanel.getByTestId('rhythm-now-music-none')).toHaveAttribute('aria-checked', 'true')
  await expect(popover(page).getByRole('button', { name: 'Open Rhythm' })).toBeVisible()
  await shootRail(page, '06-rhythm-focus')

  await runningPanel.getByTestId('rhythm-panel-stop').click()
  await expect(popover(page)).toHaveCount(0)
  await expect(rhythm).toHaveAttribute('aria-label', 'Rhythm is off')
  await rhythm.click()
  await expect(popover(page).locator('.status-item-popover-detail')).toHaveText(/^Last run \d\d:\d\d to \d\d:\d\d\. Nothing runs until you start a block\.$/)
  await expect(popover(page).getByTestId('rhythm-start-focus-input')).toHaveValue('15')
  await expect(popover(page).getByTestId('rhythm-start-break-input')).toHaveValue('10')
  await page.keyboard.press('Escape')
  const after = await page.request.post(`${base()}/api/plugin-runtime/walnut-rhythm/ops/walnut_rhythm_status`, { data: {} })
  expect(((await after.json()) as { result: { focus: { phase: string } } }).result.focus.phase).toBe('idle')
})

test('Rhythm never starts on its own: keyboard time and a reload leave it off, with no countdown', async ({ page }) => {
  await page.goto(`${base()}/`)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await setCollapsed(page, true)
  await probe(page, 'hide')
  // Ninety minutes at the keyboard, banked the way the console's own heartbeat banks it:
  // the old stand-up reminder counted exactly this.
  const now = Date.now()
  const banked = await page.request.post(`${base()}/api/time/heartbeats`, {
    data: { samples: [{ ts: new Date(now - 90 * 60_000).toISOString(), durationMs: 90 * 60_000, kind: 'triage' }] },
  })
  expect(banked.status()).toBe(204)
  const rhythm = item(page, 'walnut-rhythm:rhythm')
  for (let round = 0; round < 2; round++) {
    await expect(rhythm).toHaveAttribute('aria-label', 'Rhythm is off', { timeout: 30_000 })
    await expect(rhythm).toHaveAttribute('data-tone', 'neutral')
    // The pause glyph, never a number of minutes.
    await expect(rhythm.locator('svg text')).toHaveCount(0)
    await rhythm.click()
    await expect(popover(page).getByTestId('rhythm-start-form')).toBeVisible({ timeout: 20_000 })
    await expect(popover(page).locator('.status-item-btn')).toHaveCount(0)
    if (round === 0) await shootRail(page, '07-rhythm-off-after-keyboard-time')
    await page.keyboard.press('Escape')
    const status = await page.request.post(`${base()}/api/plugin-runtime/walnut-rhythm/ops/walnut_rhythm_status`, { data: {} })
    expect(((await status.json()) as { result: { focus: { phase: string } } }).result.focus.phase).toBe('idle')
    await page.reload()
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  }
})

test('a notice button closes its toast at once and runs the op after; a failure answers in its own toast', async ({ page }) => {
  await page.goto(`${base()}/`)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await setCollapsed(page, true)
  const toastTitled = (title: string) => page.locator('.notification-toast', { has: page.locator('.notification-toast-title', { hasText: title }) })
  const toast = toastTitled('Probe reminder')
  await probe(page, 'notice')
  await expect(toast).toBeVisible({ timeout: 30_000 })

  await settledToast(toast)
  // The op takes 3s: the toast must be gone before it answers (it sets the rail item when done).
  const clicked = Date.now()
  await toast.getByRole('button', { name: 'Slow notice' }).click()
  await expect(toast).toHaveCount(0)
  const goneMs = Date.now() - clicked
  expect(await item(page).count() === 0 || (await item(page).getAttribute('aria-label')) !== 'Slow notice finished').toBe(true)
  test.info().annotations.push({ type: 'toast-closed-ms', description: String(goneMs) })
  await expect(item(page)).toHaveAttribute('aria-label', 'Slow notice finished', { timeout: 15_000 })

  // A failing button: its toast closes too, and an error toast says what did not happen and why.
  await probe(page, 'notice')
  await expect(toast).toBeVisible({ timeout: 30_000 })
  // It comes up under the pointer that pressed the first toast's button.
  await settledToast(toast)
  await toast.getByRole('button', { name: 'Refuse' }).click()
  await expect(toast).toHaveCount(0)
  const failed = toastTitled('"Refuse" did not run')
  await expect(failed).toBeVisible()
  await expect(failed.locator('.notification-toast-body')).toContainText('Probe refused on purpose')
  await expect(failed.locator('.notification-toast-body')).toContainText('still in the notifications panel')
  await failed.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))))
  const box = (await failed.boundingBox())!
  await page.screenshot({ path: `${SHOTS}/08-toast-error.png`, clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: Math.min(1280 - Math.max(0, box.x - 16), box.width + 32), height: box.height + 32 } })
})
