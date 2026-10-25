/**
 * The Org page as a user meets it (web/src/pages/OrgPage.tsx): the sidebar's Org opens a page
 * of Main and the project leads, like a chat app's channels.
 *   - Main is pinned; a project whose work waits on the user's answer comes first, red, with
 *     the question as its line and a count
 *   - a lead opens on its Board (when it keeps one), its Team by state, and its own chat; the
 *     composer under the Board sends to the lead and the chat shows the answer
 *   - Answer on a waiting question opens that task's session on home
 *   - search, a pick that survives a reload, live state, the keyboard, and the old org chart
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
  await expect(detail.getByTestId('org-alerts')).toContainText(`Asks you: Alpha ask ${STAMP}`)
  // It keeps a Board, so it opens there: the lead's own Board, its page one click away.
  await expect(detail.getByTestId('org-tab-board')).toHaveAttribute('aria-selected', 'true')
  await detail.getByTestId('board-view-custom').click()
  await expect(detail.frameLocator('iframe').first().getByText(BOARD_TEXT)).toBeVisible({ timeout: 30_000 })

  await detail.getByTestId('org-tab-team').click()
  await expect(detail.locator('[data-testid="org-team-col"][data-column="alert"]')).toContainText(`Alpha ask ${STAMP}`)
  await expect(detail.getByTestId('org-team')).toContainText(`Alpha build ${STAMP}`)

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

test('Answer on a waiting question opens that task\'s session on home', async ({ page }) => {
  await openOrg(page)
  await row(page, ALPHA).click()
  const alert = page.locator(`[data-testid="org-alert"][data-task-id="${ids.ask}"]`)
  await expect(alert).toHaveAttribute('data-kind', 'question')
  await alert.getByRole('button', { name: 'Answer' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.askSid}"]`)).toBeVisible({ timeout: 30_000 })
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
  const below = await page.getByTestId('org-channel').first().getAttribute('data-key')
  await page.getByTestId('org-channel-main').press('ArrowDown')
  await expect(page.locator(`[data-testid="org-channel"][data-key="${below}"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-testid="org-channel"]:focus')).toHaveAttribute('aria-selected', 'true')

  // The old org chart is one click away, and its Chat on a lead selects that lead here.
  await page.getByTestId('org-open-chart').click()
  const column = page.locator(`[data-testid="org-column"][data-project="${ALPHA}"]`)
  await column.scrollIntoViewIfNeeded()
  await column.getByTestId('org-project-chat').click()
  await expect(page.getByTestId('org-chart')).toHaveCount(0)
  await expect(row(page, ALPHA)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${ALPHA} lead`)
})
