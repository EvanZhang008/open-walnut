/**
 * The session panel's ⋮ menu ends with the session's metadata: Created and
 * Updated (the session's own times, as "how long ago", the exact time on
 * hover) and Host (which machine it runs on). 2026-09-28: the user could not
 * find a created or updated time anywhere in the session panel, then asked
 * for exactly two times plus the host, relative only.
 *
 * Checked against the API, not just for presence: each hover time must be
 * the record's own time, and a message sent from the composer must move
 * Updated on every reopening.
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'

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

async function openMenu(page: Page, panel: Locator): Promise<Locator> {
  const kebab = panel.locator('.session-panel-header .task-kebab-btn')
  await expect(kebab).toBeVisible({ timeout: 15_000 })
  await kebab.click()
  const menu = page.locator('.task-kebab-menu')
  await expect(menu).toBeVisible()
  return menu
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
}

/** The hover form (`Mon, Sep 28, 2026, 3:02:05 PM`) in the BROWSER's timezone. */
function exactOf(page: Page, iso: string): Promise<string> {
  return page.evaluate((v) => new Date(v).toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  }).replace(/[\u202f\u00a0]/g, ' '), iso)
}

async function readSession(request: APIRequestContext, sid: string) {
  const res = await request.get(`/api/sessions/${sid}`)
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json() as { session: { taskId: string; startedAt: string; lastActiveAt: string } }).session
}

const RELATIVE = /^(just now|\d+(m|h|d|w|mo|y) ago)$/

test('the menu ends with Created, Updated and Host from the session record', async ({ page, request }) => {
  const panel = await openColumn(page, FIXTURE_SID)
  const session = await readSession(request, FIXTURE_SID)

  const menu = await openMenu(page, panel)
  const meta = menu.getByTestId('session-kebab-meta')
  await expect(meta).toBeVisible()
  await expect(meta.locator('.task-kebab-meta-label')).toHaveText(['Created', 'Updated', 'Host'])

  for (const [key, iso] of [['created', session.startedAt], ['updated', session.lastActiveAt]] as const) {
    const row = meta.locator(`[data-meta="${key}"]`)
    // Relative only on screen; the exact time is the hover.
    await expect(row.locator('.task-kebab-meta-value'), `${key} value`).toHaveText(RELATIVE)
    await expect(row, `${key} hover`).toHaveAttribute('title', await exactOf(page, iso))
  }
  await expect(meta.locator('[data-meta="host"] .task-kebab-meta-value')).toHaveText('Local')
  // The host lives in the metadata rows now: no separate SSH line.
  await expect(menu.getByText(/^SSH: /)).toHaveCount(0)

  // Every Session row draws an SVG icon, never an emoji or text glyph, and the
  // debug capture reads as the copy it is, beside the other Copy rows.
  const icons = await menu.locator('.task-kebab-section').last().locator('.task-kebab-icon').evaluateAll((els) =>
    els.map((el) => ({ row: (el.parentElement?.textContent ?? '').trim(), svg: !!el.querySelector('svg'), text: (el.textContent ?? '').trim() })))
  expect(icons.length).toBeGreaterThanOrEqual(10)
  for (const icon of icons) expect(icon, icon.row).toMatchObject({ svg: true, text: '' })
  const copyRows = menu.locator('.task-kebab-item').filter({ hasText: /^Copy / })
  await expect(copyRows).toHaveText(['Copy session ID', 'Copy resume cmd', 'Copy debug snapshot'])
  const shape = (row: Locator) => row.locator('.task-kebab-icon').innerHTML()
  expect(await shape(copyRows.nth(2))).toBe(await shape(copyRows.nth(0)))

  // Still inside the viewport.
  const box = await menu.boundingBox()
  const vp = page.viewportSize()!
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1)
  await meta.evaluate((el) => el.scrollIntoView({ block: 'end' }))
  await expect(meta).toBeInViewport()
  await menu.screenshot({ path: shot('01-menu') })
  await meta.screenshot({ path: shot('02-meta-rows') })

  // The same menu opened by right-clicking the header carries the rows too.
  await closeMenu(page)
  await panel.locator('.session-panel-header').click({ button: 'right', position: { x: 40, y: 12 } })
  await expect(page.locator('.task-kebab-menu').getByTestId('session-kebab-meta')).toBeVisible()
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
  await expect(host.locator('.task-kebab-meta-value')).toHaveText('devbox', { timeout: 15_000 })
  await expect(host).toHaveAttribute('title', 'devbox.example.test')
  await expect(menu.getByText(/^SSH: /)).toHaveCount(0)

  // One divider after the last action, then the metadata block, then nothing.
  const tail = await menu.locator('.task-kebab-section').last().evaluate((el) =>
    Array.from(el.children).slice(-3).map((c) =>
      c.classList.contains('task-kebab-divider') ? 'divider'
        : c.getAttribute('data-testid') === 'session-kebab-meta' ? 'meta'
          : (c.textContent ?? '').trim()))
  expect(tail).toEqual(['Terminate', 'divider', 'meta'])
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
    await expect(menu.locator('[data-meta="updated"] .task-kebab-meta-value')).toHaveText(/^(just now|1m ago)$/)
    if (round === 3) {
      const meta = menu.getByTestId('session-kebab-meta')
      await meta.evaluate((el) => el.scrollIntoView({ block: 'end' }))
      await meta.screenshot({ path: shot('04-after-send') })
    }
    await closeMenu(page)
  }
})
