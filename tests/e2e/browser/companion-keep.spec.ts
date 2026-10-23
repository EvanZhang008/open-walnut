/**
 * Settings → Phones & Cloud: what the cloud companion keeps (`cloud_bridge.keep`,
 * `cloud_bridge.copies`; 4f of docs/plan/walnut-companion-unified-replica.md). The same
 * rows and defaults as a host's (Remote Hosts), reused.
 *
 *   defaults    every switch and box on, nothing written
 *   left out    "Leave out folders or notes" saves on Enter and on blur, as a list
 *               (a folder, or one note with or without .md); the bridge url survives
 *   off         a kind turned off is written as false; the chat list off turns the
 *               chat messages off with it (and greys them); two quick clicks both stay
 *   reload      the saved choice is what the group opens with
 *   back on     turning everything back on writes no keep and no copies at all
 *   failure     a failed save puts the switch back and says why
 *   none        no cloud companion: no group
 *
 * GET /api/devices is a page.route fixture with neutral names; the config writes are
 * real, on the fixture server (the bridge is off, so it never dials). Navigation is by
 * real clicks. Runs in both engines: Chromium by default, WebKit (the Mac app is a
 * WKWebView) with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Page, type Route } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = '/tmp/g8-keep'
const LAN = { kind: 'lan', origin: 'http://192.0.2.10:3456', label: 'This network (Wi-Fi)' }
const CLOUD = { kind: 'cloud', origin: 'https://walnut.example.com', label: 'Cloud (anywhere)' }
const BRIDGE_URL = 'wss://walnut.example.com/bridge'
const NAME = 'the cloud companion'

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

async function mockDevices(page: Page, targets: unknown[]) {
  await page.route((url) => url.pathname === '/api/devices/tailscale', (route) => json(route, {
    installed: true, running: true, peers: [], install: { brew: false, job: null },
  }))
  await page.route((url) => url.pathname === '/api/devices', (route) => json(route, {
    devices: [{ name: 'Work-phone', createdAt: new Date().toISOString(), role: 'phone' }],
    cloudDevices: [],
    targets,
  }))
}

async function bridge(page: Page): Promise<Record<string, unknown> | undefined> {
  const res = await page.request.get('/api/config')
  expect(res.ok()).toBe(true)
  const body = await res.json() as { config?: Record<string, unknown> } & Record<string, unknown>
  return (body.config ?? body).cloud_bridge as Record<string, unknown> | undefined
}
const keepOf = async (page: Page) => (await bridge(page))?.keep
const copiesOf = async (page: Page) => (await bridge(page))?.copies

async function writeBridge(page: Page, cloudBridge: Record<string, unknown> | undefined) {
  const res = await page.request.put('/api/config', { data: { cloud_bridge: cloudBridge ?? {} } })
  expect(res.ok()).toBe(true)
}

async function openGroup(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  const nav = page.getByTestId('settings-nav-devices')
  await nav.click()
  await expect(nav).toHaveAttribute('aria-current', 'page')
  const group = page.getByTestId('companion-keep')
  await expect(group).toBeVisible({ timeout: 30_000 })
  return group
}

async function shot(page: Page, name: string, region: ReturnType<Page['locator']>) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.scrollIntoViewIfNeeded()
  await region.screenshot({ path: `${SHOTS}/companion-${engine}-${name}.png`, scale: 'css' })
}

const sw = (page: Page, kind: string) => page.getByRole('switch', { name: `Keep ${kind} on ${NAME}` })
const box = (page: Page, key: string) => page.locator(`#companion-copy-${key}`)

test.describe('Settings → Phones & Cloud: what the cloud companion keeps', () => {
  // One fixture server, one config: these tests write it, so they take turns.
  test.describe.configure({ mode: 'serial' })
  let saved: Record<string, unknown> | undefined

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage()
    saved = await bridge(page)
    await writeBridge(page, { enabled: false, url: BRIDGE_URL })
    await page.close()
  })

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage()
    await writeBridge(page, saved)
    await page.close()
  })

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('everything on by default; left out, off and quick clicks save as chosen', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await mockDevices(page, [LAN, CLOUD])
    const group = await openGroup(page)

    // Defaults: the same rows as a host's, every one on, nothing written.
    await expect(group).toContainText('What the cloud companion keeps')
    await expect(group).toContainText('What it does not keep is answered by this Mac, and needs this Mac while it is away.')
    for (const kind of ['notes', 'attachments', 'memory', 'skills']) await expect(sw(page, kind)).toBeChecked()
    const copies = page.getByTestId('companion-copies')
    await expect(copies).toContainText('Also kept')
    await expect(copies).toContainText('What the companion still shows while this Mac sleeps.')
    for (const key of ['sessions', 'requests', 'boards', 'inbox', 'inbox_bodies', 'conversations', 'conversation_bodies', 'routines', 'personas', 'prefs', 'config']) {
      await expect(box(page, key), key).toBeChecked()
    }
    expect(await keepOf(page)).toBeUndefined()
    expect(await copiesOf(page)).toBeUndefined()
    await shot(page, 'defaults', group)

    // Left out: a folder and one note; saved on Enter; the bridge url survives.
    const leaveOut = group.locator('.settings-row', { hasText: 'Leave out folders or notes' })
    await expect(leaveOut).toContainText('Folders or single notes that stay only on this Mac, separated by commas.')
    const field = page.getByTestId('companion-keep-exclude')
    await field.click()
    await page.keyboard.type('health, finance/taxes.md')
    // Not saved while typing.
    await page.waitForTimeout(800)
    expect(await keepOf(page)).toBeUndefined()
    await page.keyboard.press('Enter')
    await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health', 'finance/taxes.md'] })
    expect(await bridge(page)).toMatchObject({ enabled: false, url: BRIDGE_URL })
    await expect(field).toHaveValue('health, finance/taxes.md')
    // And on blur: one more note, without its .md.
    await page.keyboard.type(', work/review')
    await sw(page, 'skills').focus()
    await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health', 'finance/taxes.md', 'work/review'] })
    await shot(page, 'left-out', leaveOut)

    // Off: written as false, the list kept beside it.
    await sw(page, 'memory').click()
    await expect(sw(page, 'memory')).not.toBeChecked()
    await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health', 'finance/taxes.md', 'work/review'], memory: false })

    // The chat list off takes the chat messages with it, and greys them.
    await copies.getByText('Chat list', { exact: true }).click()
    await expect(box(page, 'conversations')).not.toBeChecked()
    await expect(box(page, 'conversation_bodies')).not.toBeChecked()
    await expect(box(page, 'conversation_bodies')).toBeDisabled()
    await expect.poll(() => copiesOf(page), { timeout: 15_000 }).toEqual({ conversations: false, conversation_bodies: false })

    // Two quick clicks: both stay (a later save never undoes an earlier one).
    await sw(page, 'skills').click()
    await copies.getByText('Boards', { exact: true }).click()
    await expect.poll(async () => [await keepOf(page), await copiesOf(page)], { timeout: 15_000 }).toEqual([
      { notes_exclude: ['health', 'finance/taxes.md', 'work/review'], memory: false, skills: false },
      { boards: false, conversations: false, conversation_bodies: false },
    ])
    expect(await bridge(page)).toMatchObject({ enabled: false, url: BRIDGE_URL })

    // Notes off hides the leave-out row and the pictures switch; back on, both are as they were.
    await sw(page, 'notes').click()
    await expect(page.getByTestId('companion-keep-exclude')).toHaveCount(0)
    await expect(page.locator('#companion-keep-attachments')).toHaveCount(0)
    await expect.poll(async () => ((await keepOf(page)) as Record<string, unknown>)?.notes, { timeout: 15_000 }).toBe(false)
    await sw(page, 'notes').click()
    await expect(page.getByTestId('companion-keep-exclude')).toHaveValue('health, finance/taxes.md, work/review')
    await expect.poll(async () => ((await keepOf(page)) as Record<string, unknown>)?.notes, { timeout: 15_000 }).toBeUndefined()
    await shot(page, 'chosen', group)
    expect(errors).toEqual([])
  })

  test('a reload opens with the saved choice; all back on writes nothing', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await mockDevices(page, [LAN, CLOUD])
    const group = await openGroup(page)
    await expect(sw(page, 'notes')).toBeChecked()
    await expect(sw(page, 'memory')).not.toBeChecked()
    await expect(sw(page, 'skills')).not.toBeChecked()
    await expect(sw(page, 'attachments')).toBeChecked()
    await expect(page.getByTestId('companion-keep-exclude')).toHaveValue('health, finance/taxes.md, work/review')
    await expect(box(page, 'boards')).not.toBeChecked()
    await expect(box(page, 'conversations')).not.toBeChecked()
    await expect(box(page, 'conversation_bodies')).toBeDisabled()
    await expect(box(page, 'sessions')).toBeChecked()

    // Everything back on, one control at a time.
    const field = page.getByTestId('companion-keep-exclude')
    await field.fill('')
    await field.press('Enter')
    await sw(page, 'memory').click()
    await sw(page, 'skills').click()
    const copies = page.getByTestId('companion-copies')
    await copies.getByText('Boards', { exact: true }).click()
    await copies.getByText('Chat list', { exact: true }).click()
    // The messages come back as a choice of their own, still off until clicked.
    await expect(box(page, 'conversation_bodies')).toBeEnabled()
    await copies.getByText('Chat messages', { exact: true }).click()
    await expect.poll(async () => [await keepOf(page), await copiesOf(page)], { timeout: 15_000 }).toEqual([undefined, undefined])
    expect(await bridge(page)).toMatchObject({ enabled: false, url: BRIDGE_URL })
    for (const kind of ['notes', 'attachments', 'memory', 'skills']) await expect(sw(page, kind)).toBeChecked()
    await shot(page, 'back-on', group)
  })

  test('typing goes on through a save, and three quick switches all stay', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await mockDevices(page, [LAN, CLOUD])
    await openGroup(page)
    // Slow saves, so their echoes land while the next change is being made.
    await page.route((url) => url.pathname === '/api/config', async (route) => {
      if (route.request().method() === 'PUT') await new Promise((r) => setTimeout(r, 400))
      await route.fallback()
    })
    const field = page.getByTestId('companion-keep-exclude')
    await field.click()
    await page.keyboard.type('health')
    await page.keyboard.press('Enter')
    // Still typing while that save and its echo come back: the text stays as typed.
    await page.keyboard.type(', fin', { delay: 60 })
    await page.waitForTimeout(1_200)
    await expect(field).toHaveValue('health, fin')
    await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health'] })
    await page.keyboard.type('ance')
    await page.keyboard.press('Enter')
    await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health', 'finance'] })
    // Three switches, each clicked before the last save came back: all three are kept.
    await sw(page, 'memory').click()
    await sw(page, 'skills').click()
    await sw(page, 'attachments').click()
    await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health', 'finance'], memory: false, skills: false, attachments: false })
    // A save's echo that lands while a later one is on its way never flips that later switch back.
    await sw(page, 'memory').click()
    await page.waitForTimeout(700)
    await sw(page, 'skills').click()
    await page.waitForTimeout(150)
    await sw(page, 'memory').click()
    const flips: boolean[] = []
    for (let i = 0; i < 24; i++) { flips.push(await sw(page, 'memory').isChecked()); await page.waitForTimeout(50) }
    expect(flips.every((on) => !on), `memory flipped back: ${flips.join(',')}`).toBe(true)
    await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health', 'finance'], memory: false, attachments: false })
    await sw(page, 'skills').click()
    await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health', 'finance'], memory: false, skills: false, attachments: false })
    await page.waitForTimeout(1_000)
    for (const kind of ['memory', 'skills', 'attachments']) await expect(sw(page, kind), kind).not.toBeChecked()
    // Back to everything for the next test.
    await field.fill('')
    await field.press('Enter')
    for (const kind of ['memory', 'skills', 'attachments']) await sw(page, kind).click()
    await expect.poll(() => keepOf(page), { timeout: 15_000 }).toBeUndefined()
  })

  test('a failed save puts the switch back and says why', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await mockDevices(page, [LAN, CLOUD])
    const group = await openGroup(page)
    const configUrl = (url: URL) => url.pathname === '/api/config'
    await page.route(configUrl, (route) =>
      route.request().method() === 'PUT' ? json(route, { error: 'Config is read-only right now' }, 500) : route.fallback())
    await sw(page, 'memory').click()
    // The error row beside the half that changed, its words under it (role=alert).
    const error = page.getByTestId('companion-keep-error')
    await expect(error).toContainText('Not saved', { timeout: 15_000 })
    await expect(copies(page).getByTestId('companion-keep-error')).toHaveCount(0)
    const alert = group.getByRole('alert').filter({ hasText: 'Config is read-only right now' })
    await expect(alert).toBeVisible()
    await expect(sw(page, 'memory')).toBeChecked()
    await shot(page, 'save-failed-keep', group)
    // A copies change that fails says so in the copies list instead.
    await copies(page).getByText('Inbox', { exact: true }).click()
    await expect(copies(page).getByTestId('companion-keep-error')).toBeVisible({ timeout: 15_000 })
    await expect(error).toHaveCount(1)
    await expect(box(page, 'inbox')).toBeChecked()
    await expect(box(page, 'inbox_bodies')).toBeChecked()
    await shot(page, 'save-failed-copies', group)
    expect(await keepOf(page)).toBeUndefined()
    expect(await copiesOf(page)).toBeUndefined()

    // Works again once the server takes writes; the error goes.
    await page.unroute(configUrl)
    await sw(page, 'memory').click()
    await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ memory: false })
    await expect(error).toHaveCount(0)
    await expect(alert).toHaveCount(0)
    await sw(page, 'memory').click()
    await expect.poll(() => keepOf(page), { timeout: 15_000 }).toBeUndefined()
  })

  test('no cloud companion: no group', async ({ page }) => {
    await mockDevices(page, [LAN])
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('link', { name: /settings/i }).first().click()
    await page.getByTestId('settings-nav-devices').click()
    const section = page.locator('#devices')
    await expect(section).not.toContainText('Loading paired phones...', { timeout: 30_000 })
    await expect(section.locator('.settings-row').first()).toBeVisible()
    await expect(page.getByTestId('companion-keep')).toHaveCount(0)
  })
})

const copies = (page: Page) => page.getByTestId('companion-copies')
