/**
 * The Org page keeps the user on it (web/src/components/org/OrgSidePanel.tsx): a task clicked
 * on the page opens in a side panel, and the lead list and the detail stay where they are.
 *   - a Team row, a Board chip, and Answer on a waiting question open beside the page
 *   - a task with no session shows what it is and how to start one; × closes the panel
 *   - a reload keeps the opened task; Home opens it on home instead
 *   - a narrow window lays the panel over the detail; a phone shows it alone and Back returns
 * The fixture is shared, so this file makes its own project and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
// Both browser projects load this file at about the same moment: the pid keeps them apart.
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Org side ${STAMP}`
const made: string[] = []
const ids = { lead: '', alpha: '', alphaSid: '', beta: '', ask: '', askSid: '' }
let cwd = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const rowKey = `project:${PROJECT.toLowerCase()}`

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function createTask(request: APIRequestContext, title: string): Promise<string> {
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })
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

async function openLead(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey}"]`).click()
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${PROJECT} VP`)
}

const side = (page: Page) => page.getByTestId('org-side')
const teamItem = (page: Page, id: string) => page.locator(`[data-testid="org-team-item"][data-task-id="${id}"]`)

test.beforeAll(async ({ request }) => {
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  cwd = `${fixtureRoot}/projects/walnut`
  ids.alpha = await createTask(request, `Side alpha ${STAMP}`)
  ids.beta = await createTask(request, `Side beta ${STAMP}`)
  ids.ask = await createTask(request, `Side question ${STAMP}`)
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })
  ids.lead = contact.task.id
  made.push(ids.lead)
  ids.alphaSid = await startSession(request, ids.alpha, `Side alpha ready ${STAMP}`)
  ids.askSid = await startSession(request, ids.ask, 'status-permission-test:AskUserQuestion', 'default')
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${ids.askSid}`)).json()).session?.pendingPermission?.toolName ?? ''),
    { timeout: 90_000 }).toBe('AskUserQuestion')
  const board = await request.put(`/api/v1/tasks/${ids.lead}/board`, {
    data: { html: `<h1>Side</h1><p>Alpha: <walnut-task id="${ids.alpha}"></walnut-task></p><p>Beta: <walnut-task id="${ids.beta}"></walnut-task></p>` },
  })
  expect(board.ok(), await board.text()).toBe(true)
})

test.afterAll(async ({ request }) => {
  for (const id of made) await removeTask(request, id)
})

test('a Team task opens beside the page; the list and the detail stay; × closes it', async ({ page }) => {
  await openLead(page)
  await page.getByTestId('org-tab-team').click()
  const list = page.locator('.org-list')
  const detail = page.locator('.org-detail-pane')
  const listBox = (await list.boundingBox())!
  const detailX = (await detail.boundingBox())!.x

  await teamItem(page, ids.alpha).click()
  await expect(side(page)).toHaveAttribute('data-session-id', ids.alphaSid)
  await expect(side(page).getByText(`I processed your message: Side alpha ready ${STAMP}`).first()).toBeVisible({ timeout: 60_000 })
  await expect(page).toHaveURL(/\/org\?/)
  await expect(page).toHaveURL(new RegExp(`open=task(%3A|:)${ids.alpha}`))
  // The list and the detail's left edge stay put (a banner above may move y, never x).
  const listAfter = (await list.boundingBox())!
  expect(listAfter.x).toBeCloseTo(listBox.x, 0)
  expect(listAfter.width).toBeCloseTo(listBox.width, 0)
  expect((await detail.boundingBox())!.x).toBeCloseTo(detailX, 0)
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${PROJECT} VP`)

  // Another task replaces it; one with no session says so.
  await teamItem(page, ids.beta).click()
  await expect(side(page).getByTestId('org-side-title')).toHaveText(`Side beta ${STAMP}`)
  await expect(side(page)).toContainText('No session yet.')
  await expect(side(page).getByTestId('org-side-start')).toBeVisible()
  await side(page).getByTestId('org-side-close').click()
  await expect(side(page)).toHaveCount(0)
  await expect(page).not.toHaveURL(/open=/)
})

test('a Board chip opens its task beside the page', async ({ page }) => {
  await openLead(page)
  await page.getByTestId('org-tab-board').click()
  await page.getByTestId('board-view-custom').click()
  const chip = page.frameLocator('.task-board-frame').locator(`walnut-task[id="${ids.alpha}"] .wn-task`)
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await chip.click()
  await expect(side(page)).toHaveAttribute('data-session-id', ids.alphaSid)
  await expect(page).toHaveURL(/\/org\?/)
})

test('Answer on a waiting question opens it beside the page, question and all', async ({ page }) => {
  await openLead(page)
  const alert = page.locator(`[data-testid="org-alert"][data-task-id="${ids.ask}"]`)
  await expect(alert).toHaveAttribute('data-kind', 'question', { timeout: 30_000 })
  await alert.getByRole('button', { name: 'Answer' }).click()
  await expect(side(page)).toHaveAttribute('data-session-id', ids.askSid)
  await expect(side(page).getByText('Which validation target?').first()).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/org\?/)
})

test('a reload keeps the opened task; Home opens it on home', async ({ page }) => {
  await openLead(page)
  await page.getByTestId('org-tab-team').click()
  await teamItem(page, ids.alpha).click()
  await expect(side(page)).toHaveAttribute('data-session-id', ids.alphaSid)
  await page.reload()
  await expect(side(page)).toHaveAttribute('data-session-id', ids.alphaSid, { timeout: 30_000 })
  await side(page).getByTestId('org-side-home').click()
  await expect(page).toHaveURL(/\/(\?|$)/)
  await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.alphaSid}"]`)).toBeVisible({ timeout: 30_000 })
})

test('a narrow window lays the panel over the detail, which keeps its width', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 760 })
  await openLead(page)
  await page.getByTestId('org-tab-team').click()
  const detail = page.locator('.org-detail-pane')
  const before = await detail.boundingBox()
  await teamItem(page, ids.alpha).click()
  await expect(side(page)).toHaveAttribute('data-session-id', ids.alphaSid)
  const after = await detail.boundingBox()
  const panel = await side(page).boundingBox()
  expect(after!.width).toBeCloseTo(before!.width, 0)
  expect(panel!.x).toBeLessThan(after!.x + after!.width)
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(1000)
})

test('a phone shows the opened task alone, and Back returns to the lead', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await isolateUiPrefs(page)
  await loadHome(page)
  // The phone's sidebar is a drawer behind the top bar's Menu.
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByTestId('sidebar-org').click()
  await expect(page).toHaveURL(/\/org/)
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey}"]`).click()
  await page.getByTestId('org-tab-team').click()
  await teamItem(page, ids.alpha).click()
  await expect(side(page)).toHaveAttribute('data-session-id', ids.alphaSid)
  await expect(page.locator('.org-detail-pane')).toHaveCount(0)
  await expect(page.locator('.org-list')).toHaveCount(0)
  await page.goBack()
  await expect(side(page)).toHaveCount(0)
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${PROJECT} VP`)
})
