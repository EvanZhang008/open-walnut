/**
 * Main and the org chart, as a user meets them (web/src/components/chat/AskWalnutSlot.tsx,
 * web/src/components/org/OrgChartSheet.tsx, src/web/routes/org-v1.ts):
 *   - a new install opens the chat on Main's composer; the sidebar has the Ask Walnut
 *     toggle and the Org chart
 *   - the drawer pins Main above the other chats and links the org chart
 *   - the org chart has one column per project; a drag makes a task another's worker,
 *     a drag onto the column makes it a top-level task again
 *   - Chat on a project with two tasks makes its hidden lead and opens a draft bound to it
 *   - a send from Main's composer makes Main, shows its session, and keeps it off the board
 * The fixture is shared, so this file makes its own project and removes what it made,
 * Main included.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome, openAskWalnutDrawer } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const STAMP = Date.now().toString(36)
const PROJECT = `Org spec ${STAMP}`
const MAIN_PROMPT = `org spec hello ${STAMP}`
const made: string[] = []

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

interface OrgTree { main?: { id: string }; projects: { project: string; lead?: { id: string; title: string } }[] }
const orgTree = async (request: APIRequestContext): Promise<OrgTree> =>
  (await (await request.get('/api/v1/org')).json()).tree as OrgTree
const taskOf = async (request: APIRequestContext, id: string): Promise<{ parent_task_id?: string; session_id?: string } | undefined> =>
  (await (await request.get(`/api/tasks/${id}`)).json()).task

async function removeTask(request: APIRequestContext, id: string): Promise<void> {
  const task = await taskOf(request, id)
  if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
  for (let i = 0; i < 10; i++) {
    const res = await request.delete(`/api/tasks/${id}`)
    if (res.ok() || res.status() === 404) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** Main left behind by an earlier run would answer instead of the composer under test. */
async function removeMain(request: APIRequestContext): Promise<void> {
  const main = (await orgTree(request)).main
  if (main) await removeTask(request, main.id)
}

const sidebarOrgChart = (page: Page) => page.getByTestId('sidebar-org-chart')
const column = (page: Page) => page.locator(`[data-testid="org-column"][data-project="${PROJECT}"]`)
const card = (page: Page, id: string) => column(page).locator(`[data-testid="org-card"][data-task-id="${id}"]`).first()

test.beforeAll(async ({ request }) => {
  await removeMain(request)
  for (const title of ['Org spec ticket A', 'Org spec ticket B']) {
    const res = await request.post('/api/tasks', { data: { title, project: PROJECT } })
    expect(res.ok(), await res.text()).toBe(true)
    made.push(((await res.json()) as { task: { id: string } }).task.id)
  }
})

test.afterAll(async ({ request }) => {
  const lead = (await orgTree(request)).projects.find((p) => p.project === PROJECT)?.lead
  for (const id of [...made, ...(lead ? [lead.id] : [])]) await removeTask(request, id)
  await removeMain(request)
})

test('a new install opens the chat on Main, and the drawer pins Main and links the org chart', async ({ page }) => {
  await isolateUiPrefs(page, { newInstall: true })
  await loadHome(page)
  const mainDraft = page.getByTestId('ask-walnut-main-draft')
  await expect(mainDraft).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('ask-walnut-main-intro')).toContainText('Main sees all your work')
  await expect(mainDraft.locator('.chat-input-textarea')).toHaveAttribute('placeholder', /Ask Main anything/)
  await expect(page.locator('.sidebar-panel-toggle', { hasText: 'Ask Walnut' })).toBeVisible()
  await expect(sidebarOrgChart(page)).toBeVisible()

  const drawer = await openAskWalnutDrawer(page)
  const mainRow = drawer.getByTestId('ask-walnut-drawer-main')
  await expect(mainRow).toHaveAttribute('aria-current', 'true')
  await expect(drawer.locator('[data-testid="ask-walnut-drawer-item"][aria-current="true"]')).toHaveCount(0)
  await expect(drawer.getByTestId('ask-walnut-org')).toBeVisible()
  // Search narrows Main away like any other row.
  await drawer.getByTestId('ask-walnut-search').fill(`zz-no-such-${STAMP}`)
  await expect(mainRow).toHaveCount(0)
})

test('the org chart: a drag makes a worker, a drag onto the column undoes it', async ({ page, request }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await sidebarOrgChart(page).click()
  const sheet = page.getByTestId('org-chart')
  await expect(sheet).toBeVisible()
  await expect(page.getByTestId('org-main')).toBeVisible()
  // The dialog takes the keyboard.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="org-chart"]'))).toBe(true)
  await column(page).scrollIntoViewIfNeeded()
  await expect(column(page).getByTestId('org-contact')).toContainText('No lead yet: Chat makes one')

  const [a, b] = made
  await card(page, b!).dragTo(card(page, a!))
  await expect.poll(async () => (await taskOf(request, b!))?.parent_task_id, { timeout: 15_000 }).toBe(a)
  await expect(card(page, a!).locator('..').getByTestId('org-workers').locator(`[data-task-id="${b}"]`)).toBeVisible()

  await card(page, b!).dragTo(column(page).locator('.org-column-head'))
  await expect.poll(async () => (await taskOf(request, b!))?.parent_task_id ?? null, { timeout: 15_000 }).toBeNull()

  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
})

test('Chat on a project with two tasks makes its hidden lead and opens a draft bound to it', async ({ page, request }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await sidebarOrgChart(page).click()
  await column(page).scrollIntoViewIfNeeded()
  await column(page).getByTestId('org-project-chat').click()
  await expect(page.getByTestId('org-chart')).toHaveCount(0)

  await expect.poll(async () => (await orgTree(request)).projects.find((p) => p.project === PROJECT)?.lead?.title, { timeout: 15_000 })
    .toBe(`${PROJECT} lead`)
  const lead = (await orgTree(request)).projects.find((p) => p.project === PROJECT)!.lead!
  await expect(page.locator('.main-page-session-column .draft-session-panel').filter({ hasText: `${PROJECT} lead` }))
    .toBeVisible({ timeout: 15_000 })
  await expect(page.locator(`.todo-panel [data-task-id="${lead.id}"]`)).toHaveCount(0)
  // The project's own tasks stay on the board.
  await expect(page.locator(`.todo-panel [data-task-id="${made[0]}"]`).first()).toBeVisible({ timeout: 15_000 })
})

test('a send from Main\'s composer makes Main, shows its session, and keeps Main off the board', async ({ page, request }) => {
  await isolateUiPrefs(page, { newInstall: true })
  await loadHome(page)
  const composer = page.getByTestId('ask-walnut-main-draft').locator('.chat-input-textarea')
  await expect(composer).toBeVisible({ timeout: 30_000 })
  const launched = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await composer.fill(MAIN_PROMPT)
  await composer.press('Enter')
  const res = await launched
  expect(res.status(), await res.text()).toBe(200)
  const { taskId, sessionId } = (await res.json()) as { taskId: string; sessionId: string }

  const session = page.getByTestId('ask-walnut-session')
  await expect(session).toHaveAttribute('data-session-id', sessionId, { timeout: 60_000 })
  await expect(session.getByText(`I processed your message: ${MAIN_PROMPT}`).first()).toBeVisible({ timeout: 60_000 })
  expect((await orgTree(request)).main?.id).toBe(taskId)
  await expect(page.locator(`.todo-panel [data-task-id="${taskId}"]`)).toHaveCount(0)

  // New chat composes an ordinary ask; the Main row brings Main back.
  let drawer = await openAskWalnutDrawer(page)
  await drawer.getByTestId('ask-walnut-new').click()
  await expect(page.getByTestId('ask-walnut-draft').locator('.chat-input-textarea')).toHaveAttribute('placeholder', /Ask Walnut anything/)
  drawer = await openAskWalnutDrawer(page)
  await drawer.getByTestId('ask-walnut-drawer-main').click()
  await expect(session).toHaveAttribute('data-session-id', sessionId, { timeout: 30_000 })
})
