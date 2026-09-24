/**
 * A host:port service a session printed opens INSIDE Walnut, in the session
 * panel's Web view, instead of a browser tab the user may not be able to reach.
 *
 * Seed (test-server.ts, pw-service-session): the transcript prints the
 * addresses of real loopback http servers the fixture started — a report page,
 * the same server's docs under a bare `127.0.0.1:port/docs`, a page that sends
 * X-Frame-Options, and a port nothing listens on yet. It also prints an ssh -L
 * spec (must stay text) and an external https link (must stay a new tab).
 *
 * The session is local, so this exercises the whole click → resolve → probe →
 * iframe path for real; the remote SSH-forward half is pinned by
 * tests/web/routes/sessions-service-preview.test.ts (no sshd on the test box).
 */
import http from 'node:http'
import fs from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-service-session'
const TASK_ID = 'pw-task-service'
const SHOTS = process.env.PW_EVIDENCE_DIR ?? '/tmp/walnut-service-preview'

test.setTimeout(120_000)
test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }))

async function openSessionPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible({ timeout: 20_000 })
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('.session-panel-chat-col').getByText('Both pages are up')).toBeVisible({ timeout: 20_000 })
  return panel
}

const chat = (panel: Locator) => panel.locator('.session-panel-chat-col')
const webView = (panel: Locator) => panel.locator('.session-web-panel')
const address = (panel: Locator) => webView(panel).locator('.session-web-address')
const frame = (panel: Locator) => panel.frameLocator('.session-web-iframe')

async function shot(page: Page, name: string, testInfo: { project: { name: string } }): Promise<void> {
  // CSS pixels: WebKit's device profile is 2x, and review shots stay <= 1280 wide.
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-${name}.png`, scale: 'css' })
}

/** Port the transcript printed for a link, read back from the rendered href. */
async function portOf(link: Locator): Promise<number> {
  const href = (await link.getAttribute('href')) ?? ''
  return Number(new URL(href).port)
}

test('a localhost link opens the page in the Web view, and every other shape keeps its own behavior', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  let loads = 0
  page.on('load', () => { loads++ })
  const popups: string[] = []
  context.on('page', (p) => popups.push(p.url()))
  // The external link must never reach the real network.
  await context.route('https://example.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<h1>external</h1>' }))

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const loadsAfterBoot = loads
  const panel = await openSessionPanel(page)

  // ── Shapes that must NOT become in-Walnut links ──
  // The ssh -L spec stays plain text (no anchor anywhere around it).
  await expect(chat(panel).getByText('ssh -N -L 8080:localhost:8080 dev-box')).toBeVisible()
  await expect(chat(panel).locator('a', { hasText: 'localhost:8080' })).toHaveCount(0)

  // ── The report link: click → Web view with the real page ──
  const report = chat(panel).locator('a[href*="/report"]')
  await expect(report).toHaveCount(1)
  const servicePort = await portOf(report)
  await report.click()
  await expect(webView(panel)).toBeVisible({ timeout: 15_000 })
  await expect(address(panel)).toHaveValue(`http://localhost:${servicePort}/report`)
  await expect(frame(panel).getByText('SERVICE_REPORT_MARKER')).toBeVisible({ timeout: 20_000 })
  await expect(frame(panel).getByText('25 stages to 13 stages')).toBeVisible()
  await expect(webView(panel).locator('.session-code-host')).toHaveText('Local')
  // The chat stays beside it, and nothing navigated or opened a tab.
  await expect(chat(panel).getByText('Both pages are up')).toBeVisible()
  expect(loads - loadsAfterBoot, 'the console navigated away').toBe(0)
  expect(popups, 'a browser tab opened').toEqual([])
  await shot(page, '01-report-in-web-view', testInfo)

  // ── The bare `127.0.0.1:port/docs` (no scheme) is a link too, and switches the view ──
  const docs = chat(panel).locator('a', { hasText: `127.0.0.1:${servicePort}/docs` })
  await expect(docs).toHaveCount(1)
  await expect(docs).toHaveAttribute('href', `http://127.0.0.1:${servicePort}/docs`)
  await docs.click()
  await expect(address(panel)).toHaveValue(`http://127.0.0.1:${servicePort}/docs`)
  await expect(frame(panel).getByText('SERVICE_DOCS_MARKER')).toBeVisible({ timeout: 20_000 })

  // ── The address bar: shorthand `:port/path` opens that page ──
  await address(panel).fill(`:${servicePort}/typed`)
  await address(panel).press('Enter')
  await expect(address(panel)).toHaveValue(`http://localhost:${servicePort}/typed`)
  await expect(frame(panel).getByText('SERVICE_TYPED_MARKER')).toBeVisible({ timeout: 20_000 })
  // Garbage is refused in place and the page stays.
  await address(panel).fill('not a url at all')
  await address(panel).press('Enter')
  await expect(address(panel)).toHaveClass(/session-web-address-invalid/)
  await expect(frame(panel).getByText('SERVICE_TYPED_MARKER')).toBeVisible()

  // ── Clicking the same link again RELOADS it: the iframe element is replaced ──
  // (a marker that is already on screen proves nothing, so tag the element).
  await report.click()
  await expect(frame(panel).getByText('SERVICE_REPORT_MARKER')).toBeVisible({ timeout: 20_000 })
  for (let round = 0; round < 2; round++) {
    await panel.locator('.session-web-iframe').evaluate((el) => { (el as HTMLElement).dataset.pwStale = '1' })
    await report.click()
    await expect(panel.locator('.session-web-iframe[data-pw-stale]')).toHaveCount(0, { timeout: 15_000 })
    await expect(frame(panel).getByText('SERVICE_REPORT_MARKER')).toBeVisible({ timeout: 20_000 })
  }

  // ── An external link keeps its new tab ──
  const external = chat(panel).locator('a[href^="https://example.com/"]')
  await expect(external).toHaveAttribute('target', '_blank')
  const [popup] = await Promise.all([context.waitForEvent('page'), external.click()])
  await popup.close()
  await expect(address(panel)).toHaveValue(`http://localhost:${servicePort}/report`)

  // ── A modified click is "give me a real tab", not the Web view ──
  await docs.scrollIntoViewIfNeeded()
  const [tab] = await Promise.all([
    context.waitForEvent('page'),
    docs.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] }),
  ])
  await tab.close()
  await expect(address(panel)).toHaveValue(`http://localhost:${servicePort}/report`)

  expect(loads - loadsAfterBoot, 'the console navigated away').toBe(0)
  await shot(page, '02-after-all-shapes', testInfo)
})

test('a page that forbids framing gets a card with a way out, not a blank pane', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openSessionPanel(page)

  const locked = chat(panel).locator('a', { hasText: /^http:\/\/localhost:\d+\/$/ }).first()
  // The fixture prints two bare-root links (locked, then not-started); the locked one is first.
  await locked.click()
  const card = webView(panel).locator('.session-code-error-card')
  await expect(card).toContainText('does not allow being shown inside another page', { timeout: 15_000 })
  await expect(card).toContainText('X-Frame-Options')
  await expect(card.getByRole('link', { name: 'Open in tab' })).toHaveAttribute('href', await locked.getAttribute('href') ?? '')
  await expect(webView(panel).locator('iframe')).toHaveCount(0)
  await shot(page, '03-framing-refused', testInfo)
})

test('a service that is not up yet explains itself, and Retry recovers once it starts', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openSessionPanel(page)

  const pending = chat(panel).locator('a', { hasText: /^http:\/\/localhost:\d+\/$/ }).nth(1)
  const port = await portOf(pending)
  await pending.click()
  const card = webView(panel).locator('.session-code-error-card')
  await expect(card).toContainText(`Can't open localhost:${port}`, { timeout: 15_000 })
  await expect(card).toContainText('Nothing is answering')
  // The card IS the report. A designed "not up yet" answer must not also raise
  // the app-wide "This API endpoint is failing (HTTP 502)" incident toast.
  await page.waitForTimeout(3_000)
  await expect(page.getByText('This API endpoint is failing (HTTP 502).')).toHaveCount(0)
  await shot(page, '04-not-up-yet', testInfo)

  // The user starts the server (here: the spec), then presses Retry.
  const srv = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end('<h1>SERVICE_LATE_MARKER</h1>')
  })
  await new Promise<void>((resolve) => srv.listen(port, '127.0.0.1', resolve))
  try {
    await card.getByRole('button', { name: 'Retry' }).click()
    await expect(frame(panel).getByText('SERVICE_LATE_MARKER')).toBeVisible({ timeout: 20_000 })
    await shot(page, '05-recovered-after-retry', testInfo)
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
})

test('the kebab opens an empty Web view to type an address, and toggles it closed and back', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openSessionPanel(page)
  const servicePort = await portOf(chat(panel).locator('a[href*="/report"]'))

  const openMenu = async () => {
    await panel.getByRole('button', { name: 'More actions' }).click()
    const menu = page.locator('.task-kebab-menu:visible')
    await expect(menu).toBeVisible({ timeout: 15_000 })
    return menu.locator('.task-kebab-item').filter({ hasText: 'Web preview' })
  }

  await (await openMenu()).click()
  await expect(webView(panel)).toBeVisible()
  await expect(webView(panel)).toContainText('Open a service this session started')
  await expect(address(panel)).toBeFocused()
  await shot(page, '06-empty-web-view', testInfo)

  await address(panel).fill(`localhost:${servicePort}/docs`)
  await address(panel).press('Enter')
  await expect(frame(panel).getByText('SERVICE_DOCS_MARKER')).toBeVisible({ timeout: 20_000 })

  // Toggle closed, then back: the last page comes back.
  const item = await openMenu()
  await expect(item).toHaveClass(/task-kebab-item-active/)
  await item.click()
  await expect(webView(panel)).toHaveCount(0)
  await (await openMenu()).click()
  await expect(address(panel)).toHaveValue(`http://localhost:${servicePort}/docs`)
  await expect(frame(panel).getByText('SERVICE_DOCS_MARKER')).toBeVisible({ timeout: 20_000 })
})

test('a slow answer for an older click never replaces the page the user clicked last', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  let releaseSlow: () => void = () => {}
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
  let heldReport = false
  await page.route('**/api/sessions/pw-service-session/service-preview', async (route) => {
    const body = route.request().postDataJSON() as { url?: string }
    if (body.url?.includes('/report')) { heldReport = true; await slowGate }
    // The client aborts a superseded request; continuing an aborted one throws.
    try { await route.continue() } catch { /* aborted by the page: expected */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openSessionPanel(page)

  const report = chat(panel).locator('a[href*="/report"]')
  const servicePort = await portOf(report)
  await report.click()
  await expect.poll(() => heldReport).toBe(true)
  await expect(webView(panel)).toContainText('Connecting to')

  const docs = chat(panel).locator('a', { hasText: `127.0.0.1:${servicePort}/docs` })
  await docs.click()
  await expect(frame(panel).getByText('SERVICE_DOCS_MARKER')).toBeVisible({ timeout: 20_000 })

  releaseSlow()
  await page.waitForTimeout(2_000)
  await expect(address(panel)).toHaveValue(`http://127.0.0.1:${servicePort}/docs`)
  await expect(frame(panel).getByText('SERVICE_DOCS_MARKER')).toBeVisible()
  await expect(frame(panel).getByText('SERVICE_REPORT_MARKER')).toHaveCount(0)
  await shot(page, '07-late-answer-ignored', testInfo)
})
