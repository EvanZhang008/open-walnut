/**
 * The session panel's ⋮ menu says when things happened: Created and Updated
 * (the task's own times, as the task detail shows them) and Last active (the
 * session), each as a clock time plus how long ago, with the full timestamp
 * on hover. 2026-09-28: the user could not find a created or updated time
 * anywhere in the session panel.
 *
 * Checked against the API, not just for presence: every value must carry the
 * clock time of the record it names, and after the task is edited a reopened
 * menu must show the new updated time.
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SCREENSHOT_DIR = '/tmp/session-kebab-times'
const FIXTURE_SID = 'pw-normal-session' // local session, task pw-task-001

test.setTimeout(120_000)
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

/** The clock part (`3:02 PM`) of a timestamp, formatted in the BROWSER's timezone. */
function clockOf(page: Page, iso: string): Promise<string> {
  return page.evaluate((v) => new Date(v).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/[\u202f\u00a0]/g, ' '), iso)
}

/** The tooltip's full form (`Mon, Sep 28, 2026, 3:02:05 PM`), browser timezone. */
function fullOf(page: Page, iso: string): Promise<string> {
  return page.evaluate((v) => new Date(v).toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  }).replace(/[\u202f\u00a0]/g, ' '), iso)
}

async function readTask(request: APIRequestContext, id: string) {
  const res = await request.get(`/api/tasks/${id}`)
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json() as { task: { created_at: string; updated_at: string } }).task
}

async function readSession(request: APIRequestContext, sid: string) {
  const res = await request.get(`/api/sessions/${sid}`)
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json() as { session: { taskId: string; startedAt: string; lastActiveAt: string; host?: string } }).session
}

const VALUE_SHAPE = /^(Today|Yesterday|[A-Z][a-z]{2} \d{1,2}(, \d{4})?,) \d{1,2}:\d{2} [AP]M · (just now|\d+(m|h|d|w|mo|y) ago)$/

test('the menu footer shows Created, Updated and Last active from the real records', async ({ page, request }) => {
  const panel = await openColumn(page, FIXTURE_SID)
  const session = await readSession(request, FIXTURE_SID)
  const task = await readTask(request, session.taskId)

  const menu = await openMenu(page, panel)
  const times = menu.getByTestId('session-kebab-times')
  await expect(times).toBeVisible()
  const rows = times.locator('.task-kebab-time-row')
  await expect(rows.locator('.task-kebab-time-label')).toHaveText(['Created', 'Updated', 'Last active'])

  const cases = [
    { key: 'created', iso: task.created_at, tip: 'Task created' },
    { key: 'updated', iso: task.updated_at, tip: 'Task last changed' },
    { key: 'active', iso: session.lastActiveAt, tip: 'Session last active' },
  ]
  for (const c of cases) {
    const row = times.locator(`[data-time="${c.key}"]`)
    const value = (await row.locator('.task-kebab-time-value').textContent()) ?? ''
    expect(value, `${c.key} value shape`).toMatch(VALUE_SHAPE)
    expect(value, `${c.key} shows its record's clock time`).toContain(await clockOf(page, c.iso))
    const title = (await row.getAttribute('title')) ?? ''
    expect(title.split('\n')[0], `${c.key} tooltip`).toBe(`${c.tip} ${await fullOf(page, c.iso)}`)
  }

  // A local session: the footer has the times and no SSH line.
  await expect(menu.getByText(/^SSH: /)).toHaveCount(0)

  // Still inside the viewport: the menu grew by three rows.
  const box = await menu.boundingBox()
  const vp = page.viewportSize()!
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1)
  await times.scrollIntoViewIfNeeded()
  await menu.screenshot({ path: `${SCREENSHOT_DIR}/${test.info().project.name}-01-menu-with-times.png` })
  await times.screenshot({ path: `${SCREENSHOT_DIR}/${test.info().project.name}-02-times-footer.png` })

  // The same menu opened by right-clicking the header carries the rows too.
  await closeMenu(page)
  await panel.locator('.session-panel-header').click({ button: 'right', position: { x: 40, y: 12 } })
  await expect(page.locator('.task-kebab-menu').getByTestId('session-kebab-times')).toBeVisible()
  await closeMenu(page)
})

test('a remote session keeps its SSH line under the times, one divider above both', async ({ page }) => {
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
  const ssh = menu.locator('.task-kebab-info').filter({ hasText: 'SSH: devbox' })
  await expect(ssh).toBeVisible({ timeout: 15_000 })
  await expect(ssh).toHaveAttribute('title', 'devbox.example.test')

  // Order and dividers, read straight off the section's children.
  const tail = await menu.locator('.task-kebab-section').last().evaluate((el) =>
    Array.from(el.children).slice(-4).map((c) =>
      c.classList.contains('task-kebab-divider') ? 'divider'
        : c.getAttribute('data-testid') === 'session-kebab-times' ? 'times'
          : c.classList.contains('task-kebab-info') ? 'ssh'
            : (c.textContent ?? '').trim()))
  expect(tail).toEqual(['Debug snapshot', 'divider', 'times', 'ssh'])
  // The small test viewport makes the menu scroll: bring its foot into view.
  await ssh.evaluate((el) => el.scrollIntoView({ block: 'end' }))
  await expect(menu.getByTestId('session-kebab-times')).toBeInViewport()
  await expect(ssh).toBeInViewport()
  await menu.screenshot({ path: `${SCREENSHOT_DIR}/${test.info().project.name}-04-remote-footer.png` })
  await closeMenu(page)
})

test('editing the task moves Updated; Created stays; reopening again stays right', async ({ page, request }) => {
  const start = await request.post('/api/sessions/quick-start', {
    data: { cwd: `${fixtureRoot}/projects/walnut`, message: '' },
  })
  expect(start.ok(), await start.text()).toBeTruthy()
  const { sessionId } = await start.json() as { sessionId: string }
  const session = await readSession(request, sessionId)
  litter.push(session.taskId)

  const panel = await openColumn(page, sessionId)
  let menu: Locator = page.locator('.task-kebab-menu')
  const updatedTip = () => menu.locator('[data-time="updated"]').getAttribute('title')
  const createdTip = () => menu.locator('[data-time="created"]').getAttribute('title')

  /** Open the menu and require its Updated tooltip to equal the task's CURRENT
   *  updated_at. Read fresh each try: a quick-started task keeps being touched
   *  by the server (session linking) for a few seconds after it is born. */
  async function expectUpdatedMatchesServer(what: string): Promise<string> {
    let iso = ''
    await expect(async () => {
      menu = await openMenu(page, panel)
      try {
        iso = (await readTask(request, session.taskId)).updated_at
        expect(await updatedTip()).toBe(`Task last changed ${await fullOf(page, iso)}`)
      } finally {
        await closeMenu(page)
      }
    }, what).toPass({ timeout: 20_000 })
    return iso
  }

  const beforeIso = await expectUpdatedMatchesServer('Updated matches the new task')
  menu = await openMenu(page, panel)
  const createdBefore = await createdTip()
  expect(createdBefore).toMatch(/^Task created /)
  await closeMenu(page)

  // Second-resolution tooltips: let the clock tick so the edit is distinguishable.
  await page.waitForTimeout(1_100)
  const edit = await request.patch(`/api/tasks/${session.taskId}`, { data: { title: `Kebab times edited ${Date.now()}` } })
  expect(edit.ok(), await edit.text()).toBeTruthy()

  // Repeat open/close: every reopen reads the current task, not a stale copy.
  for (let round = 1; round <= 3; round++) {
    const iso = await expectUpdatedMatchesServer(`round ${round}: Updated follows the edit`)
    expect(Date.parse(iso), `round ${round}: the edit moved updated_at`).toBeGreaterThan(Date.parse(beforeIso))
    menu = await openMenu(page, panel)
    expect(await createdTip(), `round ${round}: Created unchanged`).toBe(createdBefore)
    await expect(menu.locator('[data-time="updated"] .task-kebab-time-value')).toHaveText(/^Today .* · just now$|^Today .* · 1m ago$/)
    if (round === 3) await menu.getByTestId('session-kebab-times').screenshot({ path: `${SCREENSHOT_DIR}/${test.info().project.name}-03-after-edit.png` })
    await closeMenu(page)
  }
})
