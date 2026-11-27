/**
 * Every card and notice has its × (web/src/components/common/NoticeClose.tsx), and each × does what
 * its kind says (2026-11-22, the user: "why there is no x so that i cna close"; 2026-11-23, of a
 * question card over a session chat: asking for a way to collapse it). The source guard is
 * tests/web/notice-close-guard.test.ts; this walks one member of each kind on the real UI:
 *
 *   1. a pushed toast: × removes it now; the bell's notification center still lists it;
 *   2. an approval card in the corner: × hides it and answers nothing (still waiting, still in the
 *      notification center); a new request brings the card back;
 *   3. a session's error banner: × hides it, still hidden after a reload for the same words, shown
 *      again for new words;
 *   4. the Action needed strip above a session chat: × folds it to one line, Show brings it back,
 *      the ask stays unanswered;
 *   5. a task row's Action needed card: × folds it to a line, Show restores it;
 *   6. a Settings notice: × hides it;
 *   7. the "Not connected" line: × hides it while the same outage lasts; the next outage shows it.
 *      The "Your Mac is away" line needs the replica fixture (replica.config.ts, replica-away-*.spec.ts),
 *      which this config does not start: its × is covered by the guard and AwayLine's unit tests.
 *
 * Each test makes its own state and screenshots the member before and after its × to its output dir.
 */
import { expect, test, type APIRequestContext, type Page, type TestInfo, type WebSocketRoute } from '@playwright/test'
import { holdApprovalsLock } from './approvals-lock'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { asksOf, presetPanelDesign, setStatusSectionOpen, showSectionCard } from './status-section-helpers'
import { captureWs, injectEvent, waitForWs } from './ws-capture-helpers'
import { railButton } from './host-attention-helpers'
import { pinPageFlags } from './page-flags'
import { discoverBrowserFixture } from './codex-test-audit'
import { dropFakes } from './route-teardown'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

test.use({ viewport: { width: 1512, height: 920 } })
test.setTimeout(240_000)
// Test 2 makes and reads approvals on the shared fixture: each test holds the lock and starts and
// ends with none waiting (a request another file left would take the corner).
holdApprovalsLock('test', { clear: true })

const made: string[] = []
test.afterEach(async ({ page, request }) => {
  await dropFakes(page)
  for (const id of made.splice(0)) {
    const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`) })
}

async function call<T>(request: APIRequestContext, method: 'post' | 'patch' | 'put', url: string, data: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await request[method](url, { data, ...(headers ? { headers } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

/** What the task asks now, as its status says (empty when nothing). */
async function askOf(request: APIRequestContext, taskId: string): Promise<string> {
  const status = (await (await request.get(`/api/tasks/${taskId}`)).json()).task?.user_status as { actions?: Array<{ kind: string; summary: string }> } | undefined
  return status?.actions?.find((a) => a.kind === 'ask')?.summary ?? ''
}

/**
 * A task that asks the user (its report, as strip-fold.spec.ts makes it), with Threads off so the
 * strip above its chat is the plain Action needed card. `session`: give it a mock CLI session first.
 */
async function askingTask(request: APIRequestContext, ask: string, opts: { session: boolean }): Promise<{ taskId: string; sid: string }> {
  const s = stamp()
  const { task } = await call<{ task: { id: string } }>(request, 'post', '/api/tasks', { title: `Notice close ${s}`, project: `Notice close ${s}`, source: 'local' })
  made.push(task.id)
  let sid = ''
  if (opts.session) {
    const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
    ;({ sessionId: sid } = await call<{ sessionId: string }>(request, 'post', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: `Round ready ${s}`, taskId: task.id }))
    await expect.poll(async () => ((await (await request.get(`/api/v1/sessions/${sid}/history?tail=80`)).json()) as { messages?: Array<{ role?: string }> }).messages?.some((m) => m.role === 'assistant') ?? false, { timeout: 90_000 }).toBe(true)
  }
  await call(request, 'patch', `/api/tasks/${task.id}`, { threads_on: false })
  expect((await request.patch(`/api/tasks/${task.id}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  await call(request, 'put', `/api/v1/tasks/${task.id}/report`, { state: 'needs', ask, ask_kind: 'single', ask_options: [{ label: 'Ship it', recommended: true }, { label: 'Hold it' }] })
  await expect.poll(() => askOf(request, task.id), { timeout: 60_000 }).toBe(ask)
  return { taskId: task.id, sid }
}

// ── 1. A pushed toast ──

test('a toast: its × removes it now, and the notification center still lists it', async ({ page }, info) => {
  await isolateUiPrefs(page)
  await captureWs(page)
  await loadHome(page)
  await waitForWs(page)
  const title = `PW close toast ${stamp()}`
  // A hard error the person must see toasts (the same frame notification-center-redesign.spec.ts plays).
  await injectEvent(page, 'notification:new', {
    id: `nc-${title}`, kind: 'operation-error', needsYou: 'own-action', severity: 'error',
    title, body: 'Fixture failure', timestamp: Date.now(), read: false, dedupKey: `error:${title}`,
  })
  const toast = page.getByTestId('notification-toast').filter({ hasText: title })
  await expect(toast).toBeVisible()
  await shot(page, info, 'toast-before')
  await toast.locator('.notification-toast-close').click()
  await expect(toast).toHaveCount(0)
  await shot(page, info, 'toast-after')

  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await railButton(page, 'Errors').click()
  await expect(panel.locator('.nfc-detail .notification-feed-item').filter({ hasText: title })).toHaveCount(1)
})

// ── 2. An approval card in the corner ──

test('an approval card: its × hides it and answers nothing; a new request brings it back', async ({ page, request }, info) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  // Off Home, where no Needs you rows are listed: the corner card is the only place of a request.
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page).toHaveURL(/\/settings/)

  const ask = async (what: string) => call<{ approval: { id: string }; waitToken: string }>(request, 'post', '/api/v1/approvals', { cwd: '/work/site', command: 'release.sh', what })
  const first = await ask(`Deploy web ${stamp()}`)
  const card = page.locator(`[data-testid="approval-card"][data-approval-id="${first.approval.id}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await shot(page, info, 'approval-before')
  await card.getByTestId('approval-close').click()
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
  await shot(page, info, 'approval-after')

  // Not answered: the request still waits, and the notification center lists it.
  const status = async (id: string) => ((await (await request.get(`/api/v1/approvals/${id}`)).json()) as { approval: { status: string } }).approval.status
  expect(await status(first.approval.id)).toBe('pending')
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel.getByTestId('approval-summary')).toContainText(/1 approval waiting/)
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  // Still waiting a moment later: the × never denied it behind the scenes.
  await page.waitForTimeout(1_000)
  expect(await status(first.approval.id)).toBe('pending')

  // A request that comes later brings the corner back, the closed one counted with it.
  const second = await ask(`Drop staging table ${stamp()}`)
  await expect(page.getByTestId('approval-card')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('approval-card').getByTestId('approval-count')).toHaveText(/^2 waiting/)
  await shot(page, info, 'approval-new-request')
  expect(await status(second.approval.id)).toBe('pending')
})

// ── 3. A session's error banner ──

const SESSION_ID = 'pw-vscode-session'
const SESSION_TASK = 'pw-task-vscode'

/** The fixture session reads as in error with `words()` (as session-error-banner-layout.spec.ts makes it). */
async function sessionInError(page: Page, words: () => string): Promise<void> {
  await page.route(/\/api\/sessions\/pw-vscode-session(\?|$)/, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { session?: Record<string, unknown> }
    await route.fulfill({ json: { ...body, session: { ...(body.session ?? {}), process_status: 'error', errorMessage: words() } } })
  })
  await page.route(/\/api\/sessions\/status\?/, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { statuses?: Record<string, Record<string, unknown>> }
    const statuses = { ...(body.statuses ?? {}) }
    const existing = statuses[SESSION_ID]
    if (existing) {
      statuses[SESSION_ID] = {
        ...existing, process_status: 'error', errorMessage: words(),
        statusRevision: Number(existing.statusRevision ?? 0) + 1000, statusUpdatedAt: new Date().toISOString(),
      }
    }
    await route.fulfill({ json: { ...body, statuses } })
  })
}

async function openFixtureSession(page: Page) {
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)
  if (await panel.isVisible()) return panel
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${SESSION_TASK}"]`)
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()
  await expect(panel).toBeVisible()
  return panel
}

test('a session error banner: its × hides it, still hidden after a reload, shown again for new words', async ({ page }, info) => {
  let words = 'The model call failed: overloaded, try again later'
  await isolateUiPrefs(page)
  await sessionInError(page, () => words)
  await loadHome(page)
  let panel = await openFixtureSession(page)
  const banner = () => panel.locator('.session-error-banner').filter({ has: page.getByTestId('session-error-close') })
  await expect(banner()).toBeVisible({ timeout: 15_000 })
  await expect(banner()).toContainText('overloaded')
  await shot(page, info, 'session-error-before')
  await banner().getByTestId('session-error-close').click()
  await expect(banner()).toHaveCount(0)
  await shot(page, info, 'session-error-after')

  // The same error after a reload: still closed.
  await page.reload()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 60_000 })
  panel = await openFixtureSession(page)
  await expect(panel.locator('.session-history, .session-chat-bar').first()).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(1_500)
  await expect(banner()).toHaveCount(0)

  // New words: the banner shows again.
  words = 'The session ended: the remote process exited with code 137'
  await page.reload()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 60_000 })
  panel = await openFixtureSession(page)
  await expect(banner()).toBeVisible({ timeout: 15_000 })
  await shot(page, info, 'session-error-new-words')
})

// ── 4. The Action needed strip above a session chat ──

test('the strip above a chat: its × folds it to one line, Show brings it back, the ask stays open', async ({ page, request }, info) => {
  const ask = `Ship the release now or hold it for review ${stamp()}?`
  const { taskId, sid } = await askingTask(request, ask, { session: true })
  await isolateUiPrefs(page)
  await pinPageFlags(page, ['action_needed_everywhere'])
  await seedColumns(page, [sid])
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const strip = panel.getByTestId('session-action-needed')
  const card = strip.locator('[data-testid="action-item"][data-kind="ask"]')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await shot(page, info, 'action-strip-before')
  await strip.getByTestId('action-strip-hide').click()
  const show = panel.getByTestId('action-strip-show')
  await expect(show).toBeVisible()
  await expect(panel.getByTestId('action-strip-line-title')).toHaveText(ask)
  await expect(strip).toHaveCount(0)
  await shot(page, info, 'action-strip-after')
  // Folding answered nothing.
  expect(await askOf(request, taskId)).toBe(ask)

  await show.click()
  await expect(card).toBeVisible()
  await expect(show).toHaveCount(0)
  await shot(page, info, 'action-strip-shown')
  expect(await askOf(request, taskId)).toBe(ask)
})

// ── 5. A task row's Action needed card ──

test('a task row\'s Action needed card: its × folds it to a line, Show restores it', async ({ page, request }, info) => {
  const ask = `Pick the bucket policy for the logs ${stamp()}?`
  const { taskId } = await askingTask(request, ask, { session: false })
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await loadHome(page)
  await setStatusSectionOpen(page, 'needs', true)
  const row = await showSectionCard(page, 'needs', taskId)
  const block = asksOf(row).getByTestId('action-needed')
  const item = block.locator('[data-testid="action-item"][data-kind="ask"]')
  await expect(item).toBeVisible({ timeout: 30_000 })
  await item.scrollIntoViewIfNeeded()
  await shot(page, info, 'action-item-before')
  await block.getByTestId('action-item-close').click()
  const line = block.getByTestId('action-fold-line')
  await expect(line).toBeVisible()
  await expect(line.getByTestId('action-fold-title')).toHaveText(ask)
  await expect(item).toHaveCount(0)
  await shot(page, info, 'action-item-after')
  expect(await askOf(request, taskId)).toBe(ask)

  await line.getByTestId('action-fold-show').click()
  await expect(item).toBeVisible()
  await expect(line).toHaveCount(0)
  await shot(page, info, 'action-item-shown')
})

// ── 6. A Settings notice ──

test('a Settings notice: its × hides it', async ({ page }, info) => {
  await isolateUiPrefs(page)
  // The Tags pane (under Tasks) says so when it cannot read the tags.
  await page.route('**/api/tasks/meta/tags', (route) => route.fulfill({ status: 500, json: { error: 'tags store is offline' } }))
  await loadHome(page)
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page).toHaveURL(/\/settings/)
  await page.getByTestId('settings-nav-tasks').click()
  const notice = page.locator('#tags .settings-notice-error')
  await expect(notice).toBeVisible({ timeout: 20_000 })
  await notice.scrollIntoViewIfNeeded()
  await shot(page, info, 'settings-notice-before')
  await notice.locator('.settings-notice-close').click()
  await expect(page.locator('#tags .settings-notice')).toHaveCount(0)
  await shot(page, info, 'settings-notice-after')
})

// ── 7. The "Not connected" line ──

test('the not-connected line: its × hides it for this outage, the next outage shows it again', async ({ page }, info) => {
  // The socket refused on demand, as phone-resync.spec.ts does it.
  let refused = false
  const sockets: WebSocketRoute[] = []
  await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
    if (refused) { void route.close({ code: 1011, reason: 'refused by test' }); return }
    sockets.push(route)
    const server = route.connectToServer()
    route.onMessage((m) => server.send(m))
    server.onMessage((m) => route.send(m))
  })
  const refuse = () => { refused = true; for (const s of sockets.splice(0)) void s.close({ code: 1011, reason: 'refused by test' }) }
  await isolateUiPrefs(page)
  await loadHome(page)

  const line = page.getByTestId('connection-line')
  refuse()
  await expect(line).toBeVisible({ timeout: 30_000 })
  await shot(page, info, 'connection-line-before')
  await page.getByTestId('connection-line-close').click()
  await expect(line).toHaveCount(0)
  await shot(page, info, 'connection-line-after')
  // The same outage: it stays closed.
  await page.waitForTimeout(6_000)
  await expect(line).toHaveCount(0)

  // The server answers again (the close is forgotten), then the next outage shows the line.
  refused = false
  await expect.poll(() => sockets.length, { timeout: 60_000, message: 'the page reconnects on its own' }).toBeGreaterThan(0)
  await page.waitForTimeout(1_000)
  refuse()
  await expect(line).toBeVisible({ timeout: 30_000 })
  await shot(page, info, 'connection-line-next-outage')
})
