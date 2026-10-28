/**
 * The session panel's ⋮ menu carries the session's metadata: Created and
 * Updated (the session's own times, as "how long ago", the exact time on
 * hover) and Host (which machine it runs on). 2026-09-28: the user could not
 * find a created or updated time anywhere in the session panel, then asked
 * for exactly two times plus the host, relative only. Since the menu was grouped
 * (2026-10-27) they are one quiet line, "Created X · Updated Y · Host", at the foot
 * of the Copy & open group.
 *
 * Checked against the API, not just for presence: each hover time must be
 * the record's own time, and a message sent from the composer must move
 * Updated on every reopening.
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { openBell } from './host-problems-fixture-helpers'
import { railButton } from './banner-placement-helpers'
import { openKebabGroup } from './kebab-group-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SCREENSHOT_DIR = '/tmp/session-kebab-times'
const FIXTURE_SID = 'pw-normal-session' // local session, task pw-task-001

test.setTimeout(150_000)
test.describe.configure({ mode: 'serial' })

let fixtureRoot = ''
const litter: string[] = []

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
})

test.afterEach(async ({ request }) => {
  for (const id of litter.splice(0)) {
    await request.delete(`/api/tasks/${id}`).catch(() => undefined)
  }
})

const shot = (name: string) => `${SCREENSHOT_DIR}/${test.info().project.name}-${name}.png`

async function openColumn(page: Page, sid: string): Promise<Locator> {
  await page.addInitScript((id) => {
    try {
      sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id, locked: false }]))
    } catch { /* ignore */ }
  }, sid)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  return panel
}

/** Open the menu and its Copy & open group, where the metadata line lives. */
async function openMenu(page: Page, panel: Locator): Promise<Locator> {
  const kebab = panel.locator('.session-panel-header .task-kebab-btn')
  await expect(kebab).toBeVisible({ timeout: 15_000 })
  await kebab.click()
  const menu = page.locator('.task-kebab-menu')
  await expect(menu).toBeVisible()
  await openKebabGroup(menu, 'session-kebab-copy-open')
  return menu
}

/** The keys of the metadata line's parts, in order. */
const metaKeys = (meta: Locator) => meta.locator('[data-meta]').evaluateAll((els) => els.map((el) => el.getAttribute('data-meta')))

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
}

/** The hover form (`Mon, Sep 28, 2026, 3:02:05 PM`) in the BROWSER's timezone. */
function exactOf(page: Page, iso: string): Promise<string> {
  // Date and time joined with ", " in every engine: toLocaleString joins them with
  // " at " in JavaScriptCore, which the menu deliberately does not copy.
  return page.evaluate((v) => {
    const d = new Date(v)
    const date = d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    return `${date}, ${time}`.replace(/[\u202f\u00a0]/g, ' ')
  }, iso)
}

async function readSession(request: APIRequestContext, sid: string) {
  const res = await request.get(`/api/sessions/${sid}`)
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json() as { session: { taskId: string; startedAt: string; lastActiveAt: string } }).session
}

const AGO = String.raw`(just now|\d+(m|h|d|w|mo|y) ago)`
/** One part of the line: "Created 2h ago", " · Updated just now" (the separator rides the later part). */
const part = (label: string) => new RegExp(String.raw`^\s*(·\s*)?${label} ${AGO}$`)

test('Copy & open ends with Created, Updated and Host from the session record', async ({ page, request }) => {
  const panel = await openColumn(page, FIXTURE_SID)
  const session = await readSession(request, FIXTURE_SID)

  const menu = await openMenu(page, panel)
  const copyOpen = menu.getByTestId('session-kebab-copy-open').locator('.task-kebab-group-body')
  const meta = copyOpen.getByTestId('session-kebab-meta')
  await expect(meta).toBeVisible()
  // One line, the group's last.
  await expect(meta).toHaveText(new RegExp(String.raw`^Created ${AGO} · Updated ${AGO} · Local$`))
  expect(await metaKeys(meta)).toEqual(['created', 'updated', 'host'])
  expect(await copyOpen.evaluate((el) => el.lastElementChild?.getAttribute('data-testid'))).toBe('session-kebab-meta')

  for (const [key, label, iso] of [['created', 'Created', session.startedAt], ['updated', 'Updated', session.lastActiveAt]] as const) {
    const row = meta.locator(`[data-meta="${key}"]`)
    // Relative only on screen; the exact time is the hover.
    await expect(row, `${key} value`).toHaveText(part(label))
    await expect(row, `${key} hover`).toHaveAttribute('title', await exactOf(page, iso))
  }
  await expect(meta.locator('[data-meta="host"]')).toHaveText(/^\s*(·\s*)?Local$/)
  await expect(meta.locator('[data-meta="host"]')).toHaveAttribute('title', 'Local')
  // The host lives in the metadata line now: no separate SSH line.
  await expect(menu.getByText(/^SSH: /)).toHaveCount(0)

  // Every Session row draws an SVG icon, never an emoji or text glyph (every group open).
  await openKebabGroup(menu, 'session-kebab-views')
  await openKebabGroup(menu, 'session-kebab-debug')
  const icons = await menu.locator('.task-kebab-section').last().locator('.task-kebab-icon').evaluateAll((els) =>
    els.map((el) => ({ row: (el.parentElement?.textContent ?? '').trim(), svg: !!el.querySelector('svg'), text: (el.textContent ?? '').trim() })))
  expect(icons.length).toBeGreaterThanOrEqual(10)
  for (const icon of icons) expect(icon, icon.row).toMatchObject({ svg: true, text: '' })
  const copyRows = copyOpen.locator('.task-kebab-item').filter({ hasText: /^Copy / })
  await expect(copyRows).toContainText(['Copy session ID', 'Copy resume command'])
  // The debug capture (Debug group) still draws the copy icon: it copies every related id.
  const capture = menu.getByTestId('session-kebab-debug-snapshot')
  await expect(capture).toHaveText('Capture debug snapshot')
  const shape = (row: Locator) => row.locator('.task-kebab-icon').innerHTML()
  expect(await shape(capture)).toBe(await shape(copyRows.filter({ hasText: 'Copy session ID' })))

  // Still inside the viewport.
  const box = await menu.boundingBox()
  const vp = page.viewportSize()!
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1)
  await meta.evaluate((el) => el.scrollIntoView({ block: 'end' }))
  await expect(meta).toBeInViewport()
  await menu.screenshot({ path: shot('01-menu') })
  await meta.screenshot({ path: shot('02-meta-rows') })

  // The same menu opened by right-clicking the header carries the line too.
  await closeMenu(page)
  await panel.locator('.session-panel-header').click({ button: 'right', position: { x: 40, y: 12 } })
  const rightClicked = page.locator('.task-kebab-menu')
  await expect(rightClicked.getByTestId('session-kebab-meta')).toHaveCount(0)
  await openKebabGroup(rightClicked, 'session-kebab-copy-open')
  await expect(rightClicked.getByTestId('session-kebab-meta')).toBeVisible()
  await closeMenu(page)
})

test('a remote session shows its host alias, the full hostname on hover', async ({ page }) => {
  // The fixture seeds no remote session; dress the local one as remote on the wire.
  await page.route(`**/api/sessions/${FIXTURE_SID}`, async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { session: Record<string, unknown> }
    body.session.host = 'devbox'
    body.session.hostname = 'devbox.example.test'
    await route.fulfill({ response: res, json: body })
  })
  const panel = await openColumn(page, FIXTURE_SID)
  const menu = await openMenu(page, panel)
  const host = menu.locator('[data-meta="host"]')
  await expect(host).toHaveText(/^\s*(·\s*)?devbox$/, { timeout: 15_000 })
  await expect(host).toHaveAttribute('title', 'devbox.example.test')
  await expect(menu.getByText(/^SSH: /)).toHaveCount(0)

  // The metadata line closes Copy & open; the menu itself still ends with Terminate.
  const groupTail = await menu.getByTestId('session-kebab-copy-open').locator('.task-kebab-group-body').evaluate((el) =>
    Array.from(el.children).slice(-2).map((c) =>
      c.getAttribute('data-testid') === 'session-kebab-meta' ? 'meta' : (c.textContent ?? '').trim()))
  expect(groupTail).toEqual(['Copy resume command', 'meta'])
  const menuTail = await menu.locator('.task-kebab-section').last().evaluate((el) =>
    (el.lastElementChild?.textContent ?? '').trim())
  expect(menuTail).toBe('Terminate')
  await host.evaluate((el) => el.scrollIntoView({ block: 'end' }))
  await expect(host).toBeInViewport()
  await menu.screenshot({ path: shot('03-remote') })
  await closeMenu(page)
})

test('sending a message moves Updated; Created stays; every reopening agrees', async ({ page, request }) => {
  const start = await request.post('/api/sessions/quick-start', {
    data: { cwd: `${fixtureRoot}/projects/walnut`, message: '' },
  })
  expect(start.ok(), await start.text()).toBeTruthy()
  const { sessionId } = await start.json() as { sessionId: string }
  litter.push((await readSession(request, sessionId)).taskId)

  const panel = await openColumn(page, sessionId)
  let menu: Locator = page.locator('.task-kebab-menu')
  const tip = (key: string) => menu.locator(`[data-meta="${key}"]`).getAttribute('title')

  /** Open the menu and require both hover times to equal the session's CURRENT
   *  record, read fresh each try (a new session is still settling). */
  async function expectMatchesServer(what: string) {
    let s = await readSession(request, sessionId)
    await expect(async () => {
      menu = await openMenu(page, panel)
      try {
        s = await readSession(request, sessionId)
        expect(await tip('created')).toBe(await exactOf(page, s.startedAt))
        expect(await tip('updated')).toBe(await exactOf(page, s.lastActiveAt))
      } finally {
        await closeMenu(page)
      }
    }, what).toPass({ timeout: 30_000 })
    return s
  }

  const before = await expectMatchesServer('the new session')

  // Second-resolution hover times: let the clock tick so the send is distinguishable.
  await page.waitForTimeout(1_100)
  const composer = panel.locator('textarea.chat-input-textarea')
  await composer.click()
  await composer.fill(`kebab meta ping ${Date.now()}`)
  await composer.press('Enter')
  await expect.poll(async () => Date.parse((await readSession(request, sessionId)).lastActiveAt), {
    message: 'the send reached the session record', timeout: 60_000,
  }).toBeGreaterThan(Date.parse(before.lastActiveAt))

  for (let round = 1; round <= 3; round++) {
    const s = await expectMatchesServer(`round ${round}: Updated follows the send`)
    expect(s.startedAt, `round ${round}: Created unchanged`).toBe(before.startedAt)
    menu = await openMenu(page, panel)
    await expect(menu.locator('[data-meta="updated"]')).toHaveText(/^\s*(·\s*)?Updated (just now|1m ago)$/)
    if (round === 3) {
      const meta = menu.getByTestId('session-kebab-meta')
      await meta.evaluate((el) => el.scrollIntoView({ block: 'end' }))
      await meta.screenshot({ path: shot('04-after-send') })
    }
    await closeMenu(page)
  }
})

// 2026-10-04: the user removed the per-session Memory and CPU readout ("really
// not necessary"): no rows at the foot of this menu, no pill on the tool row,
// no Machine load card in the System section, and nothing asks for it.
test('a live session shows no memory or CPU anywhere, and nothing samples it', async ({ page, request }) => {
  const asked: string[] = []
  page.on('request', (r) => { if (/\/api\/resources\b/.test(r.url())) asked.push(r.url()) })
  // snapshot-clean-turn: the mock CLI answers and stays alive, a live process the old readout measured.
  const start = await request.post('/api/sessions/quick-start', {
    data: { cwd: `${fixtureRoot}/projects/walnut`, message: `snapshot-clean-turn:no readout ${Date.now()}` },
  })
  expect(start.ok(), await start.text()).toBeTruthy()
  const { sessionId } = await start.json() as { sessionId: string }
  litter.push((await readSession(request, sessionId)).taskId)
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${sessionId}`)).json()) as { session?: { pid?: number } }).session?.pid ?? null,
    { timeout: 60_000 }).toBeTruthy()

  const panel = await openColumn(page, sessionId)
  const menu = await openMenu(page, panel)
  const meta = menu.getByTestId('session-kebab-meta')
  await expect.poll(() => metaKeys(meta)).toEqual(['created', 'updated', 'host'])
  // The old rows landed within a few seconds of the menu opening; give them that long.
  await page.waitForTimeout(3_000)
  expect(await metaKeys(meta)).toEqual(['created', 'updated', 'host'])
  await expect(menu.locator('[data-meta="memory"], [data-meta="cpu"]')).toHaveCount(0)
  await meta.evaluate((el) => el.scrollIntoView({ block: 'end' }))
  await menu.screenshot({ path: shot('05-live-no-readout') })
  await closeMenu(page)
  await expect(panel.locator('[data-header-id="resources"], [data-testid="session-resource-pill"]')).toHaveCount(0)

  await openBell(page)
  const system = railButton(page, 'System')
  if (await system.getAttribute('aria-current') !== 'true') await system.click()
  await expect(system).toHaveAttribute('aria-current', 'true')
  await expect(page.locator('.notification-panel .notification-card').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-testid="nfc-machine-load"]')).toHaveCount(0)
  await page.screenshot({ path: shot('06-system-no-machine-load'), clip: { x: 0, y: 0, width: 1280, height: 720 } })
  expect(asked, 'no request for session resources').toEqual([])
  expect((await request.get('/api/resources')).status()).toBe(404)
})
