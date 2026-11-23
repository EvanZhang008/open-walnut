/**
 * A thread acted on in the Org page moves its node's dot and number in the same frame
 * (2026-11-19, the user: he acknowledged a thread and "the little red dot outside did not
 * go away, it went about twenty seconds later ... this is an instant thing").
 *
 * Why it lagged: the thread cards were optimistic, but the node's row reads its count off
 * `task.user_status.threads`, a field the SERVER derives (src/core/user-status-sync.ts), and
 * that derive waited 1.5 s of debounce queued behind passes of every task (2 to 11 s each on
 * his data): 20 to 35 s on production.
 *
 * Two halves, both held here:
 *  - this window: the page predicts the derived count from the list it draws
 *    (web/src/hooks/status-prediction.ts), so the row changes on the click. Proven by holding
 *    the PATCH at the network layer: the server cannot have answered, and the row has moved.
 *  - another window: the server derives a hand's change on its fast lane and pushes it, so a
 *    second window follows well inside a second with nothing held.
 *
 * Scenario matrix:
 *  1. Acknowledge with the write held: the row's dot label and the Threads tab count drop inside
 *     INSTANT_MS with zero responses answered; after the release the echoes do not put it back.
 *  2. a write the server refuses: the dot's count and the card come back, with the reason.
 *  3. two windows, nothing held: the other window's dot follows inside OTHER_WINDOW_MS.
 *  4. acted on again while the first write is still out (snooze the second thread): both count.
 * The fixture is shared, so this file makes its own project and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const LED = `Dot led ${STAMP}`
const HOLD_MS = 4_000
/** One frame is the claim; the budget covers a loaded test machine. */
const INSTANT_MS = 700
const OTHER_WINDOW_MS = 1_500
const made: string[] = []
const ids = { lead: '', leadSid: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const rowKey = `project:${LED.trim().toLowerCase()}`

async function post<T>(request: APIRequestContext, url: string, data: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await request.post(url, { data, ...(headers ? { headers } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

/** The node opens a thread with an answer for the user to read, as its thread_create op does: it
 *  counts on his row and its card has Acknowledge (a Needs you card answers in its ask row instead,
 *  with no Acknowledge, since 2026-11-20). */
async function openThread(request: APIRequestContext, title: string): Promise<string> {
  const { thread } = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.lead}/threads/open`,
    { title, text: `${title}: the answer is in.`, from: 'node', state: 'answered' }, { 'x-walnut-caller-sid': ids.leadSid })
  return thread.id
}

async function shownThreads(request: APIRequestContext): Promise<number> {
  const task = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task as { user_status?: { threads?: { shown?: number } } }
  return task.user_status?.threads?.shown ?? 0
}

async function removeTask(request: APIRequestContext, id: string): Promise<void> {
  const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
  if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
  for (let i = 0; i < 10; i++) {
    const res = await request.delete(`/api/tasks/${id}?force=true`)
    if (res.ok() || res.status() === 404) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

// The row's red dot (OrgListRow): its label is the count his view shows ("2 threads").
const badge = (page: Page) => page.locator(`[data-testid="org-channel"][data-key="${rowKey}"] [data-testid="org-channel-dot"]`)
const threads = (n: number | string) => `${n} thread${Number(n) === 1 ? '' : 's'}`
const card = (page: Page, id: string) => page.locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)
const tabCount = (page: Page) => page.getByTestId('org-detail').getByTestId('org-top-threads').locator('.org-top-count')

async function openNode(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey}"]`).click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', rowKey)
  await expect(page.getByTestId('org-detail').getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
}

/** Hold every thread write of this node at the network layer; `release` lets them through. */
async function holdThreadWrites(page: Page): Promise<{ answered: () => number; sent: () => number; release: () => Promise<void> }> {
  let answered = 0
  let sent = 0
  const held: Route[] = []
  let open = false
  await page.route(`**/api/v1/tasks/${ids.lead}/threads/*`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    sent += 1
    if (open) { await route.continue(); answered += 1; return }
    held.push(route)
  })
  return {
    answered: () => answered,
    sent: () => sent,
    release: async () => {
      open = true
      for (const r of held.splice(0)) { await r.continue(); answered += 1 }
    },
  }
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const cwd = `${fixtureRoot}/projects/walnut`
  // Two teams, so the project is answered by a lead (one team alone IS the contact: resolveOrgContact).
  for (const title of [`Dot work ${STAMP}`, `Dot other ${STAMP}`]) {
    const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: LED, source: 'local' })
    made.push(task.id)
  }
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: LED })
  ids.lead = contact.task.id
  made.push(ids.lead)
  await post(request, '/api/sessions/quick-start', { cwd, message: 'snapshot-clean-turn:Started.', taskId: ids.lead })
  await expect.poll(async () => (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? '', { timeout: 90_000 }).not.toBe('')
  ids.leadSid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task.session_id
})

test.afterAll(async ({ request }) => {
  for (const id of made) await removeTask(request, id)
})

test('the node row follows an Acknowledge before the server has answered, and the echoes do not undo it', async ({ page, request }) => {
  const a = await openThread(request, `Dot A ${STAMP}`)
  const b = await openThread(request, `Dot B ${STAMP}`)
  const c = await openThread(request, `Dot C ${STAMP}`)
  await expect.poll(() => shownThreads(request), { timeout: 30_000 }).toBe(3)
  await openNode(page)
  await expect(badge(page)).toHaveAttribute('aria-label', threads('3'), { timeout: 30_000 })
  await expect(card(page, a)).toBeVisible()
  await expect(tabCount(page)).toHaveText('3')

  const hold = await holdThreadWrites(page)
  await card(page, a).getByTestId('org-thread-ack').click()
  // The claim: the row outside the card has moved while the write is still on the wire.
  await expect(badge(page)).toHaveAttribute('aria-label', threads('2'), { timeout: INSTANT_MS })
  await expect(tabCount(page)).toHaveText('2', { timeout: INSTANT_MS })
  expect(hold.answered(), 'the server answered before the row moved: the row may have followed the server').toBe(0)
  expect(await shownThreads(request), 'the server still counts 3: nothing reached it').toBe(3)
  await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/org-thread-dot-held-${test.info().project.name}.png` }).catch(() => {})

  // Scenario 4: a second action while the first write is still out.
  await card(page, b).getByTestId('org-thread-ack').click()
  await expect(badge(page)).toHaveAttribute('aria-label', threads('1'), { timeout: INSTANT_MS })
  expect(hold.answered()).toBe(0)

  await hold.release()
  await expect.poll(() => hold.answered(), { timeout: 15_000 }).toBe(2)
  await expect.poll(() => shownThreads(request), { timeout: 15_000 }).toBe(1)
  // Every echo has had time to land (the write's event, the derived status, the list re-read).
  await page.waitForTimeout(2_500)
  await expect(badge(page)).toHaveAttribute('aria-label', threads('1'))
  await expect(tabCount(page)).toHaveText('1')
  await expect(card(page, c)).toBeVisible()
})

test('a write the server refuses puts the count back and says so', async ({ page, request }) => {
  const before = (await shownThreads(request)) + 1
  const d = await openThread(request, `Dot D ${STAMP}`)
  await expect.poll(() => shownThreads(request), { timeout: 30_000 }).toBe(before)
  await openNode(page)
  await expect(badge(page)).toHaveAttribute('aria-label', threads(String(before)), { timeout: 30_000 })
  await page.route(`**/api/v1/tasks/${ids.lead}/threads/*`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    await new Promise((r) => setTimeout(r, 1_200))
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'disk full' } }) })
  })
  await card(page, d).getByTestId('org-thread-ack').click()
  await expect(badge(page)).toHaveAttribute('aria-label', threads(String(before - 1)), { timeout: INSTANT_MS })
  // Refused: the row and the card are back, and the page says it did not save.
  await expect(badge(page)).toHaveAttribute('aria-label', threads(String(before)), { timeout: 10_000 })
  await expect(card(page, d).getByTestId('org-thread-ack')).toBeVisible()
  await expect(page.getByTestId('org-detail')).toContainText('did not save')
  expect(await shownThreads(request)).toBe(before)
})

test('another window follows inside a second, with nothing held', async ({ page, context, request }) => {
  const before = (await shownThreads(request)) + 1
  const e = await openThread(request, `Dot E ${STAMP}`)
  await expect.poll(() => shownThreads(request), { timeout: 30_000 }).toBe(before)
  await openNode(page)
  const other = await context.newPage()
  await openNode(other)
  await expect(badge(page)).toHaveAttribute('aria-label', threads(String(before)), { timeout: 30_000 })
  await expect(badge(other)).toHaveAttribute('aria-label', threads(String(before)), { timeout: 30_000 })

  await card(page, e).getByTestId('org-thread-ack').click()
  // The other window only has the server to learn it from: the fast lane, then the push.
  await expect(badge(other)).toHaveAttribute('aria-label', threads(String(before - 1)), { timeout: OTHER_WINDOW_MS })
  await expect(card(other, e).getByTestId('org-thread-ack')).toHaveCount(0, { timeout: 5_000 })
  await other.close()
})
