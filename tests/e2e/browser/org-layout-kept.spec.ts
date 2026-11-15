/**
 * The Org page keeps what the user closed when they leave the page and come back (2026-11-15, the
 * user: "I close tread, and go out and go ack in it hsow the thread again, can each page literally
 * remmerbt hte last setting, permenently"). On a VP node with a panel Home locked beside it:
 *  1. close the side bar (Threads) and the Home-locked panel beside the chat;
 *  2. go to Home and back to Org, several times: both stay closed;
 *  3. reload: both stay closed; Home's own lock is untouched throughout;
 *  4. the side bar's switch brings the side bar back, and that is kept too.
 * The same with a storage that drops the writes (the Mac app, 2026-11-15: WebKit's storage database
 * was locked, every write failed in the background and WebKit put the page's storage back to what
 * was on disk): here the page's keys are put back past the wrapped methods, as WebKit did.
 * The fixture is shared, so this file makes its own project and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Layout kept ${STAMP}`
const NODE = `project:${PROJECT.trim().toLowerCase()}`
const made: string[] = []
const ids = { lead: '', leadSid: '', work: '', workSid: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function sessionOf(request: APIRequestContext, id: string): Promise<string> {
  await expect.poll(async () => (await (await request.get(`/api/tasks/${id}`)).json()).task?.session_id ?? '', { timeout: 90_000 }).not.toBe('')
  return (await (await request.get(`/api/tasks/${id}`)).json()).task.session_id
}

test.beforeAll(async ({ request }) => {
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const cwd = `${fixtureRoot}/projects/walnut`
  ids.work = (await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Kept work ${STAMP}`, project: PROJECT, source: 'local' })).task.id
  made.push(ids.work)
  await post(request, '/api/sessions/quick-start', { cwd, message: `snapshot-clean-turn:Work ${STAMP}.`, taskId: ids.work })
  ids.workSid = await sessionOf(request, ids.work)
  // A second team, so the project gets a VP of its own (with Threads), as the user's Walnut VP.
  made.push((await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Kept review ${STAMP}`, project: PROJECT, source: 'local' })).task.id)
  ids.lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  expect(ids.lead, 'the project has a VP of its own').not.toBe(ids.work)
  made.push(ids.lead)
  await post(request, '/api/sessions/quick-start', { cwd, message: 'snapshot-clean-turn:Started.', taskId: ids.lead })
  ids.leadSid = await sessionOf(request, ids.lead)
})

test.afterAll(async ({ request }) => {
  for (const sid of [ids.workSid, ids.leadSid]) if (sid) await request.post(`/api/v1/sessions/${sid}/terminate`, { data: { force: true } })
  for (const id of made) {
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

const detail = (page: Page) => page.getByTestId('org-detail')
const homePanel = (page: Page) => page.locator(`[data-testid="org-side-strip"] [data-testid="org-side"][data-session-id="${ids.workSid}"]`)
const homeColumn = (page: Page) => page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.workSid}"]`)

/**
 * The server's ui-prefs, kept for this page only (the shared fixture's are never touched): GET
 * answers what was PUT, last writer per key, as the real route does.
 */
async function ownUiPrefs(page: Page): Promise<void> {
  const prefs: Record<string, { v: string | null; ts: number }> = { 'open-walnut-home-chat-visible': { v: 'false', ts: 1 } }
  await page.route(/\/api\/ui-prefs(\?|$)/, async (route) => {
    const req = route.request()
    if (req.method() === 'PUT') {
      const body = req.postDataJSON() as { prefs?: Record<string, { v: string | null; ts: number }> }
      for (const [k, e] of Object.entries(body.prefs ?? {})) if (!prefs[k] || e.ts >= prefs[k].ts) prefs[k] = e
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
      return
    }
    const key = new URL(req.url()).searchParams.get('key')
    const out = key ? (key in prefs ? { [key]: prefs[key] } : {}) : prefs
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prefs: out }) })
  })
}

async function toOrg(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await expect(detail(page)).toHaveAttribute('data-key', NODE, { timeout: 30_000 })
  await expect(detail(page).locator(`[data-testid="org-chat"] .session-panel[data-session-id="${ids.leadSid}"]`)).toBeVisible({ timeout: 30_000 })
}

async function toHome(page: Page): Promise<void> {
  await page.locator('.sidebar-home-group a').first().click()
  await expect(page.locator('.todo-panel').first()).toBeVisible({ timeout: 30_000 })
}

test('what was closed on a VP node stays closed after leaving the page, coming back and reloading', async ({ page }) => {
  await ownUiPrefs(page)
  await page.setViewportSize({ width: 1600, height: 940 })
  // Home shows the work task's session column, locked (the user's layout record).
  await page.addInitScript((sid) => {
    if (sessionStorage.getItem('pw-layout-kept')) return
    sessionStorage.setItem('pw-layout-kept', '1')
    localStorage.setItem('open-walnut-layout:home-columns', JSON.stringify({ v: 1, value: [{ id: sid, locked: true }] }))
  }, ids.workSid)
  await loadHome(page)
  await expect(homeColumn(page)).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('sidebar-org').click()
  await page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`).click()
  await expect(detail(page)).toHaveAttribute('data-key', NODE)
  // The node opens on its Threads, with the panel Home locked beside it.
  await expect(detail(page).getByTestId('org-rail')).toBeVisible({ timeout: 30_000 })
  await expect(homePanel(page)).toBeVisible({ timeout: 30_000 })
  await expect(detail(page).getByTestId('org-top-threads')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/org-layout-kept-before-${test.info().project.name}.png` })

  // What the storage held before the closes (what a locked WebKit database puts back).
  // The write stamps too: WebKit put the whole storage back.
  const KEYS = ['open-walnut-view:org.node.railHidden', 'open-walnut-view:org.homeLocksOff', 'open-walnut-view:org.node.view', 'open-walnut-ui-prefs-sync-meta']
  const disk = await page.evaluate((keys) => {
    const raw = (Storage.prototype as unknown as Record<symbol, { get: Storage['getItem'] }>)[Symbol.for('open-walnut.ui-prefs-sync.raw-storage')]
    return keys.map((k) => [k, raw.get.call(localStorage, k)] as const)
  }, KEYS)

  // Close both.
  await detail(page).getByTestId('org-rail-close').click()
  await expect(detail(page).getByTestId('org-rail')).toHaveCount(0)
  await homePanel(page).locator('.session-panel-close, [data-testid="org-side-close"]').first().click()
  await expect(homePanel(page)).toHaveCount(0)
  // The storage drops both writes.
  await page.evaluate((entries) => {
    const raw = (Storage.prototype as unknown as Record<symbol, { set: Storage['setItem']; remove: Storage['removeItem'] }>)[Symbol.for('open-walnut.ui-prefs-sync.raw-storage')]
    for (const [k, v] of entries) { if (v === null) raw.remove.call(localStorage, k); else raw.set.call(localStorage, k, v) }
  }, disk)

  for (let round = 0; round < 3; round++) {
    await toHome(page)
    // Home's own lock is the user's, untouched by closing it on Org.
    await expect(homeColumn(page)).toBeVisible()
    await expect(homeColumn(page).locator('.session-panel-lock.is-locked')).toBeVisible()
    await toOrg(page)
    await expect(detail(page).getByTestId('org-rail'), `round ${round}: the side bar stays closed`).toHaveCount(0)
    await expect(homePanel(page), `round ${round}: the panel stays closed`).toHaveCount(0)
    // Settle a moment: nothing reopens after the page has drawn.
    await page.waitForTimeout(1500)
    await expect(detail(page).getByTestId('org-rail')).toHaveCount(0)
    await expect(homePanel(page)).toHaveCount(0)
  }

  await page.reload()
  await expect(detail(page)).toHaveAttribute('data-key', NODE, { timeout: 30_000 })
  await expect(detail(page).locator(`[data-testid="org-chat"] .session-panel[data-session-id="${ids.leadSid}"]`)).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1500)
  await expect(detail(page).getByTestId('org-rail')).toHaveCount(0)
  await expect(homePanel(page)).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/org-layout-kept-after-${test.info().project.name}.png` })

  // Opened again from the header, Threads is back and kept that way.
  await detail(page).getByTestId('org-rail-toggle').click()
  await expect(detail(page).getByTestId('org-rail')).toBeVisible()
  await toHome(page)
  await toOrg(page)
  await expect(detail(page).getByTestId('org-rail')).toBeVisible()
  await expect(homePanel(page)).toHaveCount(0)
})
