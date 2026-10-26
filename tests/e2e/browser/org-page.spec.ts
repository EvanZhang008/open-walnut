/**
 * The Org page as a user meets it (web/src/pages/OrgPage.tsx): the sidebar's Org opens a page
 * of Main and the project leads, like a chat app's channels.
 *   - Main is pinned; a project whose work waits on the user's answer comes first, red, with
 *     the question as its line and a count
 *   - a lead opens on its own chat (the first tab), then its Team by the user's status (Needs you /
 *     Working / Waiting, each task with its status line) and its Board; the
 *     composer under the Board sends to the lead and the chat shows the answer
 *   - Answer on a waiting question opens that task's session beside the page
 *   - search, a pick that survives a reload, live state, the keyboard, and the org chart
 *   - the rows hold still while the pointer is over the list, and re-sort once it leaves
 *   - another page and back (or a reload of /org) shows the same place: the pick, its tab, the
 *     task beside it, the list's scroll
 * The fixture is shared, so this file makes its own projects and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
// Both browser projects load this file at about the same moment: the pid keeps them apart.
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const ALPHA = `Org page alpha ${STAMP}`
const BETA = `Org page beta ${STAMP}`
const BOARD_TEXT = `Alpha board ${STAMP}`
const made: string[] = []
const ids = { lead: '', leadSid: '', ask: '', askSid: '', build: '', beta: '' }
let cwd = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`
const row = (page: Page, project: string) => page.locator(`[data-testid="org-channel"][data-key="${rowKey(project)}"]`)

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function createTask(request: APIRequestContext, title: string, project: string): Promise<string> {
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project, source: 'local' })
  made.push(task.id)
  return task.id
}

async function startSession(request: APIRequestContext, taskId: string, message: string, mode?: string): Promise<string> {
  const { sessionId } = await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd, message, taskId, ...(mode ? { mode } : {}) })
  return sessionId
}

async function removeTask(request: APIRequestContext, id: string): Promise<void> {
  const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
  if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
  for (let i = 0; i < 10; i++) {
    const res = await request.delete(`/api/tasks/${id}`)
    if (res.ok() || res.status() === 404) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function openOrg(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page).toHaveURL(/\/org(\?|$)/)
  await expect(page.getByTestId('org-page')).toBeVisible()
}

test.beforeAll(async ({ request }) => {
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  cwd = `${fixtureRoot}/projects/walnut`
  ids.ask = await createTask(request, `Alpha ask ${STAMP}`, ALPHA)
  ids.build = await createTask(request, `Alpha build ${STAMP}`, ALPHA)
  ids.beta = await createTask(request, `Beta solo ${STAMP}`, BETA)
  // Two teams: Main talks to a lead, made on first contact.
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: ALPHA })
  ids.lead = contact.task.id
  made.push(ids.lead)
  ids.leadSid = await startSession(request, ids.lead, `Alpha lead ready ${STAMP}`)
  ids.askSid = await startSession(request, ids.ask, 'status-permission-test:AskUserQuestion', 'default')
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${ids.askSid}`)).json()).session?.pendingPermission?.toolName ?? ''),
    { timeout: 90_000 }).toBe('AskUserQuestion')
  const board = await request.put(`/api/v1/tasks/${ids.lead}/board`, { data: { html: `<h1>Alpha</h1><p>${BOARD_TEXT}</p>` } })
  expect(board.ok(), await board.text()).toBe(true)
})

test.afterAll(async ({ request }) => {
  for (const id of made) await removeTask(request, id)
})

test('the sidebar opens Main and the leads; a lead waiting on the user comes first', async ({ page }) => {
  await openOrg(page)
  await expect(page.getByTestId('org-channel-main')).toBeVisible()
  const alpha = row(page, ALPHA)
  await expect(alpha).toHaveAttribute('data-state', 'alert', { timeout: 30_000 })
  await expect(alpha.getByTestId('org-channel-badge')).toHaveText('1')
  await expect(alpha.getByTestId('org-channel-latest')).toHaveText(`Asks you: Alpha ask ${STAMP}`)
  // Needs you sorts above quiet work.
  const keys = await page.getByTestId('org-channel').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
  expect(keys.indexOf(rowKey(ALPHA))).toBeLessThan(keys.indexOf(rowKey(BETA)))

  await alpha.click()
  await expect(alpha).toHaveAttribute('aria-selected', 'true')
  const detail = page.getByTestId('org-detail')
  await expect(detail.getByTestId('org-detail-title')).toHaveText(`${ALPHA} lead`)
  await expect(detail.getByTestId('org-detail-counts')).toContainText('2 open')
  // The one user status's words (src/core/user-status.ts), as on the Board: the question needs
  // the user, the task not started waits.
  await expect(detail.getByTestId('org-detail-counts')).toContainText('1 needs you')
  await expect(detail.getByTestId('org-detail-counts')).toContainText('1 waiting')
  await expect(detail.getByTestId('org-alerts')).toContainText(`Asks you: Alpha ask ${STAMP}`)
  // A node opens on its chat, first of the tabs; its Board is one click away.
  await expect(detail.getByTestId('org-tab-chat')).toHaveAttribute('aria-selected', 'true')
  // The Board tab joins once the lead's board is known.
  await expect.poll(() => detail.getByRole('tab').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))), { timeout: 30_000 })
    .toEqual(['org-tab-chat', 'org-tab-team', 'org-tab-board'])
  await detail.getByTestId('org-tab-board').click()
  await detail.getByTestId('board-view-custom').click()
  await expect(detail.frameLocator('iframe').first().getByText(BOARD_TEXT)).toBeVisible({ timeout: 30_000 })

  await detail.getByTestId('org-tab-team').click()
  await expect(detail.locator('[data-testid="org-team-col"][data-column="needs"]')).toContainText(`Alpha ask ${STAMP}`)
  const waiting = detail.locator('[data-testid="org-team-col"][data-column="waiting"]')
  await expect(waiting.locator('.org-team-head')).toContainText('Waiting')
  await expect(waiting.locator('[data-testid="org-team-item"]', { hasText: `Alpha build ${STAMP}` }).getByTestId('org-team-note'))
    .toHaveText('Not started yet', { timeout: 30_000 })

  // Main's own page lists the leads by state.
  await page.getByTestId('org-channel-main').click()
  await expect(detail.getByTestId('org-detail-title')).toHaveText('Main')
  await detail.getByTestId('org-tab-team').click()
  await detail.locator(`[data-testid="org-team-item"]`, { hasText: ALPHA }).click()
  await expect(alpha).toHaveAttribute('aria-selected', 'true')
})

test('a lead\'s chat is in the page, and the composer under its Board sends to it', async ({ page }) => {
  await openOrg(page)
  await row(page, ALPHA).click()
  const detail = page.getByTestId('org-detail')
  await detail.getByTestId('org-tab-chat').click()
  const chat = detail.locator(`[data-testid="org-chat"] .session-panel[data-session-id="${ids.leadSid}"]`)
  await expect(chat).toBeVisible()
  await expect(chat.getByText(`I processed your message: Alpha lead ready ${STAMP}`).first()).toBeVisible({ timeout: 60_000 })

  await detail.getByTestId('org-tab-board').click()
  const composer = detail.getByTestId('org-composer').locator('textarea')
  await composer.fill(`status please ${STAMP}`)
  await composer.press('Enter')
  await expect(detail.getByTestId('org-tab-chat')).toHaveAttribute('aria-selected', 'true')
  await expect(chat.getByText(`I processed your message: status please ${STAMP}`).first()).toBeVisible({ timeout: 60_000 })
  await expect(page).toHaveURL(/tab=chat/)
})

test('Answer on a waiting question opens that task\'s session beside the page', async ({ page }) => {
  await openOrg(page)
  await row(page, ALPHA).click()
  const alert = page.locator(`[data-testid="org-alert"][data-task-id="${ids.ask}"]`)
  await expect(alert).toHaveAttribute('data-kind', 'question')
  await alert.getByRole('button', { name: 'Answer' }).click()
  // The user stays on the Org page (org-side-panel.spec.ts covers the panel itself).
  await expect(page).toHaveURL(/\/org\?/)
  await expect(page.getByTestId('org-side')).toHaveAttribute('data-session-id', ids.askSid, { timeout: 30_000 })
})

test('search, a pick that survives a reload, live state, the keyboard, and the org chart', async ({ page, request }) => {
  await openOrg(page)
  const search = page.getByTestId('org-search')
  await search.fill(`zz-none-${STAMP}`)
  await expect(page.getByTestId('org-no-match')).toBeVisible()
  await expect(page.getByTestId('org-channel-main')).toBeVisible()
  await search.fill(STAMP)
  await expect(page.getByTestId('org-channel')).toHaveCount(2)
  await search.fill('')

  // One task and no lead: Main talks to the task itself.
  const beta = row(page, BETA)
  await beta.click()
  await expect(page.getByTestId('org-detail-title')).toHaveText(`Beta solo ${STAMP}`)
  await expect(page).toHaveURL(new RegExp(`node=${encodeURIComponent(rowKey(BETA)).replace(/%20/g, '(%20|\\+)')}`))
  await page.reload()
  await expect(row(page, BETA)).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
  await expect(page.getByTestId('org-detail-title')).toHaveText(`Beta solo ${STAMP}`)

  // Live: work that starts moving recolors the row without a reload.
  await expect(row(page, BETA)).toHaveAttribute('data-state', 'quiet')
  const patched = await request.patch(`/api/tasks/${ids.beta}`, { data: { phase: 'IN_PROGRESS' } })
  expect(patched.ok(), await patched.text()).toBe(true)
  await expect(row(page, BETA)).toHaveAttribute('data-state', 'working', { timeout: 30_000 })
  await expect(row(page, BETA).getByTestId('org-channel-latest')).toHaveText(`Working on: Beta solo ${STAMP}`)

  // Up and Down move the pick. The list re-sorts live (the other browser project shares the
  // fixture), so the row under Main is read before the key, and the focused row must be the pick.
  await page.getByTestId('org-channel-main').click()
  // Main opens on its chat, whose session statuses arrive after the click and may re-sort the
  // rows: read the row under Main once the order has held for a second.
  let below: string | null = null
  await expect.poll(async () => {
    const now = await page.getByTestId('org-channel').first().getAttribute('data-key')
    const steady = now === below
    below = now
    return steady
  }, { timeout: 30_000, intervals: [1_000] }).toBe(true)
  await page.getByTestId('org-channel-main').press('ArrowDown')
  await expect(page.locator(`[data-testid="org-channel"][data-key="${below}"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-testid="org-channel"]:focus')).toHaveAttribute('aria-selected', 'true')

  // The org chart is one click away, and a VP card selects its project here.
  await page.getByTestId('org-open-chart').click()
  const card = page.locator(`[data-testid="org-chart-vp"][data-project="${ALPHA}"]`)
  await card.scrollIntoViewIfNeeded()
  await card.locator('.oc-card-btn').click()
  await expect(page.getByTestId('org-chart')).toHaveCount(0)
  await expect(row(page, ALPHA)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${ALPHA} lead`)
})

test('the rows hold still under the pointer, and take their new order once it leaves', async ({ page, request }) => {
  // Two quiet projects: inside one state the newest work sorts first, so touching the lower
  // one's task would move it up while the user aims at a row.
  const one = `Org page gamma ${STAMP}`
  const two = `Org page delta ${STAMP}`
  const oneId = await createTask(request, `Gamma solo ${STAMP}`, one)
  const twoId = await createTask(request, `Delta solo ${STAMP}`, two)
  await openOrg(page)
  await expect(row(page, one)).toBeVisible({ timeout: 30_000 })
  await expect(row(page, two)).toBeVisible()
  const order = () => page.getByTestId('org-channel').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
  const keys = await order()
  const [upper, lower, lowerId] = keys.indexOf(rowKey(one)) < keys.indexOf(rowKey(two)) ? [one, two, twoId] : [two, one, oneId]

  await row(page, upper).hover()
  const touched = await request.patch(`/api/tasks/${lowerId}`, { data: { title: `Touched ${STAMP}` } })
  expect(touched.ok(), await touched.text()).toBe(true)
  // The page has the change (the row's line names the new title) and still keeps its order.
  await expect(row(page, lower).getByTestId('org-channel-latest')).toContainText(`Touched ${STAMP}`, { timeout: 30_000 })
  const during = await order()
  expect(during.indexOf(rowKey(lower))).toBeGreaterThan(during.indexOf(rowKey(upper)))

  // Off the list, the new order shows.
  const view = page.viewportSize()!
  await page.mouse.move(view.width - 40, view.height / 2)
  await expect.poll(async () => {
    const now = await order()
    return now.indexOf(rowKey(lower)) < now.indexOf(rowKey(upper))
  }, { timeout: 15_000 }).toBe(true)
})

test('a task whose Board asks the user to choose needs them: its row, its line, the ask, and Answer opens the Board', async ({ page, request }) => {
  // No prompt in any session: only the task's status says it needs the user (src/core/user-status.ts).
  const project = `Org page choice ${STAMP}`
  const id = await createTask(request, `Renewal ${STAMP}`, project)
  const put = await request.put(`/api/v1/tasks/${id}/board`, {
    data: { html: `<h1>Renewal</h1><walnut-choice id="renew" title="Pick the renewal date ${STAMP}" options="may:In May,june:In June"></walnut-choice>` },
  })
  expect(put.ok(), await put.text()).toBe(true)
  await expect.poll(async () => ((await (await request.get(`/api/tasks/${id}`)).json()).task?.user_status?.state ?? ''), { timeout: 30_000 })
    .toBe('needs')

  await openOrg(page)
  await page.getByTestId('org-search').fill(project)
  const r = row(page, project)
  await expect(r).toHaveAttribute('data-state', 'alert', { timeout: 30_000 })
  await expect(r.getByTestId('org-channel-badge')).toHaveText('1')
  // The line says what the user is asked; the task it is about is beside it.
  await expect(r.getByTestId('org-channel-latest')).toHaveText(/^Needs you: \S/)
  await expect(r.getByTestId('org-channel-latest')).toHaveAttribute('title', new RegExp(`^Renewal ${STAMP}: Needs you: `))
  await r.click()
  await expect(page.getByTestId('org-detail-counts')).toContainText('1 needs you')
  // Listed on its own chat too: the chat does not show a Board's choice.
  await expect(page.getByTestId('org-tab-chat')).toHaveAttribute('aria-selected', 'true')
  const alert = page.getByTestId('org-alert').filter({ hasText: `Renewal ${STAMP}` })
  await expect(alert).toHaveAttribute('data-kind', 'needs')
  await expect(alert.locator('.org-alert-main')).toHaveText(`Renewal ${STAMP}`)
  await expect(alert.locator('.org-alert-ask')).toHaveText(`Pick the renewal date ${STAMP}`)
  await alert.getByRole('button', { name: 'Answer' }).click()
  await expect(page.getByTestId('org-tab-board')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('board-status-answer')).toBeVisible({ timeout: 30_000 })
})

async function letterFrom(request: APIRequestContext, taskId: string, subject: string): Promise<void> {
  const sid = await startSession(request, taskId, `${subject} ready`)
  const sent = await request.post('/api/v1/human-inbox', {
    headers: { 'x-walnut-caller-sid': sid },
    data: { subject, type: 'action_required', markdown: 'Pick one.', actions: [{ id: 'yes', label: 'Yes' }] },
  })
  expect(sent.status(), await sent.text()).toBe(201)
  await expect.poll(async () => ((await (await request.get(`/api/tasks/${taskId}`)).json()).task?.user_status?.source ?? ''), { timeout: 60_000 })
    .toBe('letter')
}

test('a task waiting on a decision letter needs the user: Answer opens the letter, in its chat or beside the page', async ({ page, request }) => {
  // The row's own task: its chat. A task under a row with no lead: beside the page.
  const project = `Org page letter ${STAMP}`
  const id = await createTask(request, `Lease ${STAMP}`, project)
  await letterFrom(request, id, `Sign the lease ${STAMP}`)
  const other = `Org page letters ${STAMP}`
  const deposit = await createTask(request, `Deposit ${STAMP}`, other)
  await createTask(request, `Movers ${STAMP}`, other)
  await letterFrom(request, deposit, `Send the deposit ${STAMP}`)

  await openOrg(page)
  await page.getByTestId('org-search').fill(project)
  const r = row(page, project)
  await expect(r).toHaveAttribute('data-state', 'alert', { timeout: 30_000 })
  await expect(r.getByTestId('org-channel-latest')).toHaveText(/^Needs you: \S/)
  await expect(r.getByTestId('org-channel-latest')).toHaveAttribute('title', new RegExp(`^Lease ${STAMP}: Needs you: `))
  await r.click()
  await expect(page.getByTestId('org-tab-chat')).toHaveAttribute('aria-selected', 'true')
  const alert = page.getByTestId('org-alert').filter({ hasText: `Lease ${STAMP}` })
  await expect(alert.locator('.org-alert-ask')).toHaveText(`Sign the lease ${STAMP}`)
  await alert.getByRole('button', { name: 'Answer' }).click()
  const chat = page.getByTestId('org-chat')
  await expect(chat.locator('.session-inbox-pane')).toBeVisible({ timeout: 30_000 })
  await expect(chat.locator('.session-inbox-pane')).toContainText(`Sign the lease ${STAMP}`)
  await page.keyboard.press('Escape')
  await expect(chat.locator('.session-inbox-pane')).toHaveCount(0)

  await page.getByTestId('org-search').fill(other)
  await row(page, other).click()
  const beside = page.getByTestId('org-alert').filter({ hasText: `Deposit ${STAMP}` })
  await expect(beside.locator('.org-alert-ask')).toHaveText(`Send the deposit ${STAMP}`)
  await beside.getByRole('button', { name: 'Answer' }).click()
  const side = page.getByTestId('org-side')
  await expect(side.locator('.session-inbox-pane')).toBeVisible({ timeout: 30_000 })
  await expect(side.locator('.session-inbox-pane')).toContainText(`Send the deposit ${STAMP}`)
})

test('back on the Org page, it is where it was: the pick, its tab, the task beside it, the list scroll; a reload too', async ({ page }) => {
  await openOrg(page)
  await row(page, ALPHA).click()
  await expect(row(page, ALPHA)).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('org-tab-team').click()
  await expect(page.getByTestId('org-tab-team')).toHaveAttribute('aria-selected', 'true')
  // One of this team's own tasks, by id: the columns re-sort as the shared fixture's work moves.
  const taskId = ids.build
  const item = page.locator(`[data-testid="org-team-item"][data-task-id="${taskId}"]`)
  await item.click()
  await expect(page.getByTestId('org-side')).toBeVisible()
  const list = page.locator('.org-list-scroll')
  const top = await list.evaluate((el) => { el.scrollTop = Math.min(80, el.scrollHeight - el.clientHeight); return el.scrollTop })
  // The scroll is saved a moment after it stops.
  await page.waitForTimeout(500)

  const expectSamePlace = async () => {
    await expect(row(page, ALPHA)).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
    await expect(page.getByTestId('org-tab-team')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('org-side')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`open=[^&]*${taskId}`))
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(top)
  }
  // Another page, then the sidebar's Org: the same place, not the first lead.
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByTestId('org-page')).toHaveCount(0)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await expectSamePlace()
  // Across a reload too (the Mac app reopened): reload elsewhere, then the sidebar's Org.
  await page.getByTestId('sidebar-core-app-settings').click()
  await page.reload()
  await page.getByTestId('sidebar-org').click()
  await expectSamePlace()

  // Main picked: Main comes back.
  await page.getByTestId('org-channel-main').click()
  await expect(page.getByTestId('org-channel-main')).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('sidebar-core-app-settings').click()
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-channel-main')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('org-side')).toHaveCount(0)
})
