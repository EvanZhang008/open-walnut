/**
 * Back in front, the phone catches up (spec 4.5 R; C36, C62, C63, C88).
 * A phone that slept holds a socket that is OPEN on paper and silent in fact.
 * On visible / online / pageshow the console pings it, reconnects at once
 * when it does not answer, and refetches, without reloading the page. Offline
 * for 5 s, a row under the bar says so; when the host server answers alone
 * (the Mac asleep), the row says that instead. The socket is routed so the
 * spec can make it half dead, refuse it, or let it through.
 */
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { PHONE, menuButton } from './phone-helpers'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

interface Wire {
  sockets: WebSocketRoute[]
  /** Frames the page sent, parsed. */
  sent: { method?: string; type?: string }[]
  /** Swallow every frame both ways on the sockets open now. */
  deaden: () => void
  /** Close the open sockets and refuse new ones until `allow()`. */
  refuse: () => void
  allow: () => void
}

async function routeWire(page: Page): Promise<Wire> {
  const wire: Wire = { sockets: [], sent: [], deaden: () => {}, refuse: () => {}, allow: () => {} }
  let refused = false
  const dead = new WeakSet<WebSocketRoute>()
  await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
    if (refused) { void route.close({ code: 1011, reason: 'refused by test' }); return }
    wire.sockets.push(route)
    const server = route.connectToServer()
    route.onMessage((m) => {
      try { wire.sent.push(JSON.parse(String(m))) } catch { /* not json */ }
      if (!dead.has(route)) server.send(m)
    })
    server.onMessage((m) => { if (!dead.has(route)) route.send(m) })
  })
  wire.deaden = () => { for (const s of wire.sockets) dead.add(s) }
  wire.refuse = () => {
    refused = true
    for (const s of wire.sockets) void s.close({ code: 1011, reason: 'refused by test' })
  }
  wire.allow = () => { refused = false }
  return wire
}

async function bootHome(page: Page, path = '/'): Promise<void> {
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    // A visibility switch the spec can flip (Playwright pages are always visible).
    const w = window as unknown as { __vis: DocumentVisibilityState; __boots: number }
    w.__vis = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => w.__vis })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => w.__vis === 'hidden' })
    try {
      sessionStorage.setItem('phone-resync-boots', String(Number(sessionStorage.getItem('phone-resync-boots') ?? '0') + 1))
      localStorage.setItem('open-walnut-home-chat-visible', 'false')
    } catch { /* storage off */ }
  })
  await page.goto(path)
  if (path !== '/') return
  await expect(menuButton(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
}

async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((s) => {
    (window as unknown as { __vis: string }).__vis = s
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

const boots = (page: Page) => page.evaluate(() => Number(sessionStorage.getItem('phone-resync-boots')))

/**
 * N2-04: the row pushes the page down. The search field (and the first row of
 * home controls) start below it, and a tap at their center reaches them.
 */
async function expectRowCoversNothing(page: Page, rowTestId: string): Promise<void> {
  const row = (await page.getByTestId(rowTestId).boundingBox())!
  const search = (await page.locator('.todo-search-input').boundingBox())!
  expect(search.y, 'search starts below the status row').toBeGreaterThanOrEqual(row.y + row.height - 0.5)
  const hit = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.todo-search-input')!
    const r = el.getBoundingClientRect()
    const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!t && (t === el || el.contains(t) || t.contains(el))
  })
  expect(hit, 'a tap on the search field reaches it').toBe(true)
}
const sync = (page: Page) => page.locator('.phone-topbar-sync.is-active')

test('a half-dead socket: visible again pings, reconnects at once and refetches, with no reload', async ({ page }) => {
  const wire = await routeWire(page)
  await bootHome(page)
  await expect.poll(() => wire.sockets.length).toBe(1)
  const bootsBefore = await boots(page)
  // The home list scrolled a little: it must stay where it is.
  const scroller = page.locator('.todo-panel-list, .todo-list-scroll, .todo-panel-scroll').first()
  const hasScroller = await scroller.count() > 0
  if (hasScroller) await scroller.evaluate((el) => { el.scrollTop = Math.min(120, el.scrollHeight) })
  const scrollBefore = hasScroller ? await scroller.evaluate((el) => el.scrollTop) : 0

  wire.deaden()
  await setVisibility(page, 'hidden')
  // Ten minutes "later": the 25 s silence rule applies, the socket is not trusted.
  await page.clock.install()
  await page.clock.fastForward('10:00')
  await page.clock.resume()
  const tasksRefetch = page.waitForRequest((r) => r.method() === 'GET' && /\/api\/tasks(\?|$)/.test(new URL(r.url()).pathname + new URL(r.url()).search), { timeout: 15_000 })
  // The notification center reloads its feed too (C62): letters that came while the socket was dead.
  const feedRefetch = page.waitForRequest((r) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/notifications', { timeout: 15_000 })
  await setVisibility(page, 'visible')
  await expect(sync(page)).toBeVisible({ timeout: 2_000 })
  await expect.poll(() => wire.sent.some((f) => f.method === 'ping'), { timeout: 3_000 }).toBe(true)
  await expect.poll(() => wire.sockets.length, { timeout: 10_000 }).toBe(2)
  await tasksRefetch
  await feedRefetch
  await expect(sync(page)).toHaveCount(0, { timeout: 10_000 })

  expect(await boots(page), 'the page was not reloaded').toBe(bootsBefore)
  if (hasScroller) expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - scrollBefore)).toBeLessThanOrEqual(1)
  await expect(page.locator('.todo-search-input')).toBeVisible()
  await expect(page.locator('[class*="skeleton"]')).toHaveCount(0)
})

for (const event of ['online', 'pageshow'] as const) {
  test(`the ${event} event runs the same resync`, async ({ page }) => {
    const wire = await routeWire(page)
    await bootHome(page)
    await expect.poll(() => wire.sockets.length).toBe(1)
    wire.deaden()
    await page.clock.install()
    await page.clock.fastForward('01:00')
    await page.clock.resume()
    await page.evaluate((name) => window.dispatchEvent(new Event(name)), event)
    await expect(sync(page)).toBeVisible({ timeout: 2_000 })
    await expect.poll(() => wire.sent.some((f) => f.method === 'ping'), { timeout: 3_000 }).toBe(true)
    await expect.poll(() => wire.sockets.length, { timeout: 10_000 }).toBe(2)
  })
}

test('offline for 5 s: a row under the bar with Retry; the right slot stays the page slot; it goes when back', async ({ page }, info) => {
  const wire = await routeWire(page)
  await bootHome(page)
  await expect.poll(() => wire.sockets.length).toBe(1)
  wire.refuse()
  const row = page.getByTestId('phone-status-offline')
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row).toContainText('Not connected. Retrying...')
  const retry = row.getByRole('button', { name: 'Retry' })
  const r = (await retry.boundingBox())!
  expect(r.width).toBeGreaterThanOrEqual(44)
  expect(r.height).toBeGreaterThanOrEqual(44)
  expect((await row.boundingBox())!.y).toBeGreaterThanOrEqual(44 - 0.5)
  await expect(page.locator('.phone-topbar-right .phone-topbar-slot')).toHaveCount(1)
  await expect(page.locator('.phone-topbar-right')).not.toContainText('Not connected')
  await expectRowCoversNothing(page, 'phone-status-offline')
  await page.screenshot({ path: `/tmp/mobile-web/phone-resync-${info.project.name}-offline.png`, scale: 'css' })
  wire.allow()
  await retry.click()
  await expect(row).toHaveCount(0, { timeout: 10_000 })
})

/** A tap at the element's center reaches it (nothing is drawn over it). */
const tapReaches = (page: Page, selector: string) => page.evaluate((sel) => {
  const el = document.querySelector<HTMLElement>(sel)
  if (!el) return 'missing'
  const r = el.getBoundingClientRect()
  const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return !!t && (t === el || el.contains(t)) ? 'reached' : `covered by ${t ? String((t as HTMLElement).className || t.tagName) : 'nothing'}`
}, selector)

test('N2-04: offline, the row stays under the drawer and above the notification center, covering none of their controls', async ({ page }) => {
  const wire = await routeWire(page)
  await bootHome(page)
  await expect.poll(() => wire.sockets.length).toBe(1)
  wire.refuse()
  const row = page.getByTestId('phone-status-offline')
  await expect(row).toBeVisible({ timeout: 15_000 })
  // The drawer is drawn over the row, and its current item takes the tap.
  await menuButton(page).tap()
  await expect(page.locator('.sidebar.open')).toBeVisible()
  await page.waitForTimeout(300)
  expect(await tapReaches(page, '.sidebar.open [aria-current="page"]')).toBe('reached')
  await page.keyboard.press('Escape')
  await expect(page.locator('.sidebar.open')).toHaveCount(0)
  // The notification center starts under the row: its header controls take the tap.
  await page.locator('.phone-topbar').getByTestId('phone-bell').tap()
  await expect(page.locator('.notification-panel')).toBeVisible()
  await page.waitForTimeout(300)
  const rowBox = (await row.boundingBox())!
  const header = (await page.locator('.notification-panel-header').boundingBox())!
  expect(header.y, 'the center header starts under the row').toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 0.5)
  expect(await tapReaches(page, '.notification-panel-header .nfc-quiet-toggle button, .notification-panel-header .nfc-quiet-toggle')).toBe('reached')
  wire.allow()
})

test('the Mac not answering: the host server line replaces the offline line, old data stays, no reload', async ({ page }, info) => {
  const wire = await routeWire(page)
  await bootHome(page)
  await expect.poll(() => wire.sockets.length).toBe(1)
  const bootsBefore = await boots(page)
  let away = true
  await page.route('**/api/v1/me', (route) => (away
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'leader_away', message: 'Walnut is away.' }, why: 'test' }) })
    : route.continue()))
  wire.refuse()
  const row = page.getByTestId('phone-status-mac-away')
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row).toContainText('Your Mac is not answering. Showing what this phone last saw.')
  const open = row.getByRole('link', { name: 'Open quick view' })
  const b = (await open.boundingBox())!
  expect(b.height).toBeGreaterThanOrEqual(44)
  await expect(page.getByTestId('phone-status-offline')).toHaveCount(0)
  await expect(page.locator('.todo-search-input')).toBeVisible()
  await expectRowCoversNothing(page, 'phone-status-mac-away')
  // Open quick view keeps a margin from the screen edge.
  expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width - 8)
  await page.screenshot({ path: `/tmp/mobile-web/phone-resync-${info.project.name}-mac-away.png`, scale: 'css' })
  away = false
  wire.allow()
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(row).toHaveCount(0, { timeout: 15_000 })
  expect(await boots(page)).toBe(bootsBefore)
})

test('C62: at 150 ms per request, the data is fresh within 2 s of visible, before the ping deadline', async ({ page }) => {
  const wire = await routeWire(page)
  await bootHome(page)
  await expect.poll(() => wire.sockets.length).toBe(1)
  // Every API request now takes an extra 150 ms (a phone on a slow tunnel).
  await page.route('**/api/**', async (route) => { await new Promise((r) => setTimeout(r, 150)); await route.fallback() })
  wire.deaden()
  await setVisibility(page, 'hidden')
  await page.clock.install()
  await page.clock.fastForward('10:00')
  await page.clock.resume()
  const fresh = (path: RegExp) => page.waitForResponse((r) => r.request().method() === 'GET' && path.test(new URL(r.url()).pathname), { timeout: 10_000 })
  const tasks = fresh(/^\/api\/tasks$/)
  const feed = fresh(/^\/api\/notifications$/)
  const t0 = Date.now()
  await setVisibility(page, 'visible')
  await Promise.all([tasks, feed])
  const ms = Date.now() - t0
  // Both answered while the old socket was still being pinged (one socket so far).
  expect(ms).toBeLessThan(2_000)
  expect(wire.sockets.length).toBe(1)
  // Then the dead socket is replaced as before.
  await expect.poll(() => wire.sockets.length, { timeout: 10_000 }).toBe(2)
})

test('C62: a prompt answered on another device leaves the open session within 2 s of visible, at 150 ms per request', async ({ page }) => {
  const SID = 'pw-resync-prompt-session'
  const wire = await routeWire(page)
  let pending: Array<Record<string, unknown>> = [{ requestId: 'req-resync-1', toolName: 'Bash', input: { command: 'ls ./garden' }, reason: 'ask req-resync-1' }]
  await page.route(`**/api/sessions/${SID}`, (route) => route.fulfill({ json: {
    session: { claudeSessionId: SID, taskId: 'pw-task-resync-prompt', project: 'Walnut', process_status: 'running', mode: 'default',
      startedAt: new Date(Date.now() - 600_000).toISOString(), lastActiveAt: new Date().toISOString(), messageCount: 2, title: 'Resync prompt fixture' },
    pendingPermissions: pending,
  } }))
  await page.route(`**/api/sessions/${SID}/history**`, (route) => route.fulfill({ json: { messages: [
    { role: 'user', text: 'List the garden folder', timestamp: new Date(Date.now() - 60_000).toISOString(), msgId: 'u-1' },
  ], cursor: 1, delta: false } }))
  await bootHome(page, `/?s1=${SID}`)
  const overlay = page.locator(`.main-page-session-column.is-mobile-active .session-panel[data-session-id="${SID}"]`)
  await expect(overlay).toBeVisible({ timeout: 30_000 })
  const allow = overlay.locator('.permission-request-card').getByRole('button', { name: /^(Allow|Approve)/ })
  await expect(allow.first()).toBeVisible({ timeout: 20_000 })
  // Answered on the computer while this phone slept: the server lists nothing now.
  pending = []
  await page.route('**/api/**', async (route) => { await new Promise((r) => setTimeout(r, 150)); await route.fallback() })
  wire.deaden()
  await setVisibility(page, 'hidden')
  await page.clock.install()
  await page.clock.fastForward('10:00')
  await page.clock.resume()
  const t0 = Date.now()
  await setVisibility(page, 'visible')
  await expect(allow).toHaveCount(0, { timeout: 2_000 })
  const ms = Date.now() - t0
  expect(ms).toBeLessThan(2_000)
  // Still the dead socket: the card went before the ping deadline and the reconnect.
  expect(wire.sockets.length).toBe(1)
})
