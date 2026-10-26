/**
 * Main and the org, as a user meets them (web/src/components/chat/AskWalnutSlot.tsx,
 * web/src/pages/OrgPage.tsx, src/web/routes/org-v1.ts; the chart itself: org-chart-vp.spec.ts):
 *   - a new install opens the chat on Main's composer; the sidebar has the Ask Walnut
 *     toggle and the Org page
 *   - the drawer pins Main above the other chats and links the Org page
 *   - on the Org page, chatting with a project with two tasks makes its hidden lead and opens a
 *     plain chat with it (no Start Task / Ask Walnut fork, a folder ready); the Tasks page hides
 *     the leads too
 *   - a send from Main's composer makes Main, shows its session, and keeps it off the board
 *     and off the Tasks page
 *   - Main's quick actions (web/src/components/org/MainQuickActions.tsx): Tidy projects / Put
 *     tasks in place / Triage under its Latest line; a failed send says so; a click sends Main
 *     the action and shows its chat, where Main answers; a Main waiting on the user's answer is
 *     not sent to; the Tasks page's Tidy up menu asks about the project it shows
 * The fixture is shared, so this file makes its own projects and removes what it made, Main
 * included. Main is one per install, so every test that needs it lives here, in order (a
 * second file would run beside this one's removal of Main). The mock CLI answers each message
 * with "I processed your message: <text>"; one Main serves both browser projects, so only
 * WebKit (the Mac app's engine) sends quick actions to it.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { loadHome, openAskWalnutDrawer } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { openSessionFromPlus, pinToTier } from './draft-surface-helpers'

// Both browser projects load this file in their own worker at about the same moment: the pid
// keeps their projects apart (a shared one let one worker's lead answer the other's chat).
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Org spec ${STAMP}`
const MAIN_PROMPT = `org spec hello ${STAMP}`
const QA_PROJECT = `Tidy scope ${STAMP}`
const SENDS = 'one Main serves both browser projects: only WebKit sends to it'
const made: string[] = []
/** Tasks a test made only to draw a board header; removed with the rest. */
const anchors: string[] = []

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

const sidebarOrg = (page: Page) => page.getByTestId('sidebar-org')
/** On the Org page: the project's Chat tab and its start button (no session yet). */
async function startProjectChat(page: Page): Promise<void> {
  await sidebarOrg(page).click()
  // Search first: other work in the shared fixture keeps re-sorting the rows.
  await page.getByTestId('org-search').fill(PROJECT)
  const channel = page.locator(`[data-testid="org-channel"][data-key="project:${PROJECT.toLowerCase()}"]`)
  await channel.click()
  await expect(channel).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('org-tab-chat').click()
  await page.getByTestId('org-start-chat').click()
}

test.beforeAll(async ({ request }) => {
  await removeMain(request)
  for (const title of ['Org spec ticket A', 'Org spec ticket B']) {
    const res = await request.post('/api/tasks', { data: { title, project: PROJECT } })
    expect(res.ok(), await res.text()).toBe(true)
    made.push(((await res.json()) as { task: { id: string } }).task.id)
  }
  const target = await request.post('/api/tasks', { data: { title: `Tidy target ${STAMP}`, project: QA_PROJECT, source: 'local' } })
  expect(target.ok(), await target.text()).toBe(true)
  made.push(((await target.json()) as { task: { id: string } }).task.id)
})

test.afterAll(async ({ request }) => {
  const lead = (await orgTree(request)).projects.find((p) => p.project === PROJECT)?.lead
  for (const id of [...made, ...anchors, ...(lead ? [lead.id] : [])]) await removeTask(request, id)
  await removeMain(request)
})

async function openOrgMain(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await page.getByTestId('org-channel-main').click()
  await expect(page.getByTestId('org-detail-title')).toHaveText('Main')
}

/** Main's chat on the Org page, and the mock CLI's answers in it. */
const mainChat = (page: Page) => page.locator('[data-testid="org-chat"] .session-panel')
const replies = (chat: Locator) => chat.locator('.session-msg-assistant')

/** Click, then wait until Main's newest answer is a new one that says `expected`, and return
 *  it. Main's chat folds an earlier turn into "An update", so the number of answers on screen
 *  does not grow; the newest answer's text is read once the history has loaded instead, so an
 *  older answer never passes. */
async function clickForReply(page: Page, click: () => Promise<void>, expected: string): Promise<Locator> {
  const chat = mainChat(page)
  await page.getByTestId('org-tab-chat').click()
  await chat.or(page.getByTestId('org-chat-start')).first().waitFor({ timeout: 30_000 })
  const newest = async () => ((await replies(chat).count()) ? (await replies(chat).last().textContent()) ?? '' : '')
  let before = ''
  if (await chat.count()) {
    let last: string | null = null
    await expect.poll(async () => {
      const now = await newest()
      const steady = now === last
      last = now
      return steady
    }, { timeout: 30_000, intervals: [1_000] }).toBe(true)
    before = last ?? ''
  }
  await click()
  await expect(page.getByTestId('org-tab-chat')).toHaveAttribute('aria-selected', 'true')
  await expect(chat).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => {
    const now = await newest()
    return now !== before && now.includes(expected)
  }, { timeout: 90_000 }).toBe(true)
  return replies(chat).last()
}

test('a new install opens the chat on Main, and the drawer pins Main and links the org chart', async ({ page }) => {
  await isolateUiPrefs(page, { newInstall: true })
  await loadHome(page)
  const mainDraft = page.getByTestId('ask-walnut-main-draft')
  await expect(mainDraft).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('ask-walnut-main-intro')).toContainText('Main sees all your work')
  await expect(mainDraft.locator('.chat-input-textarea')).toHaveAttribute('placeholder', /Ask Main anything/)
  await expect(page.locator('.sidebar-panel-toggle', { hasText: 'Ask Walnut' })).toBeVisible()
  await expect(sidebarOrg(page)).toBeVisible()

  const drawer = await openAskWalnutDrawer(page)
  const mainRow = drawer.getByTestId('ask-walnut-drawer-main')
  await expect(mainRow).toHaveAttribute('aria-current', 'true')
  await expect(drawer.locator('[data-testid="ask-walnut-drawer-item"][aria-current="true"]')).toHaveCount(0)
  await expect(drawer.getByTestId('ask-walnut-org')).toBeVisible()
  // Search narrows Main away like any other row.
  await drawer.getByTestId('ask-walnut-search').fill(`zz-no-such-${STAMP}`)
  await expect(mainRow).toHaveCount(0)
})

test('Chat with a project with two tasks makes its hidden lead and opens a plain chat with it', async ({ page, request }) => {
  // A Parked tier header (and its "+") draws only while the tier holds a task: an Inbox
  // anchor sits there, so the "+" below has a header to live on.
  const anchor = await request.post('/api/tasks', { data: { title: `Org spec tier anchor ${STAMP}`, source: 'local', project: '' } })
  expect(anchor.ok(), await anchor.text()).toBe(true)
  const anchorId = ((await anchor.json()) as { task: { id: string } }).task.id
  anchors.push(anchorId)
  await pinToTier(page, anchorId, 'wait')
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await loadHome(page)
  await startProjectChat(page)
  await expect(page).toHaveURL(/\/$/)

  await expect.poll(async () => (await orgTree(request)).projects.find((p) => p.project === PROJECT)?.lead?.title, { timeout: 15_000 })
    .toBe(`${PROJECT} lead`)
  const lead = (await orgTree(request)).projects.find((p) => p.project === PROJECT)!.lead!
  const draft = page.locator('.main-page-session-column .draft-session-panel').filter({ hasText: `${PROJECT} lead` })
  await expect(draft).toBeVisible({ timeout: 15_000 })
  // A chat with the lead: no Start Task / Ask Walnut fork, a line on who it is, and its name in the composer.
  await expect(draft.locator('.draft-intent-cards')).toHaveCount(0)
  await expect(draft.getByTestId('draft-org-lead-hint')).toContainText(`leads ${PROJECT}`)
  const composer = draft.locator('.chat-input-textarea')
  await expect(composer).toHaveAttribute('placeholder', `Message ${PROJECT} lead…`)
  await expect(page.locator(`.todo-panel [data-task-id="${lead.id}"]`)).toHaveCount(0)
  // The project's own tasks stay on the board.
  await expect(page.locator(`.todo-panel [data-task-id="${made[0]}"]`).first()).toBeVisible({ timeout: 15_000 })

  // The chat opens where the project's tasks start (its memory folder here), so it never asks
  // for one, and nothing is written to the lead.
  const leadFolder = async () => (await draft.locator('.draft-folder-pill').getAttribute('aria-label')) ?? ''
  await expect.poll(leadFolder).toContain(`/${PROJECT.toLowerCase()} on `)
  expect((await (await request.get(`/api/tasks/${lead.id}`)).json()).task.cwd).toBeFalsy()

  // A tier "+" while this chat is untouched reuses the column for a plain draft: the
  // lead's binding, line and folder do not ride along.
  const header = page.locator('.todo-pinned-sublabel[data-navigation-id="wait"]').first()
  await expect(header).toBeVisible({ timeout: 25_000 })
  await openSessionFromPlus(page, header)
  const drafts = page.locator('.main-page-session-column .draft-session-panel')
  await expect(drafts).toHaveCount(1)
  await expect(draft).toHaveCount(0)
  await expect(drafts.getByTestId('draft-org-lead-hint')).toHaveCount(0)
  await expect(drafts.locator('.draft-folder-pill')).toHaveAttribute('aria-label', 'Choose folder and host')
  // Chat on the lead again: the same untouched column becomes the lead chat once more.
  await startProjectChat(page)
  await expect(draft).toBeVisible({ timeout: 15_000 })
  await expect(drafts).toHaveCount(1)
  await expect.poll(leadFolder).toContain(`/${PROJECT.toLowerCase()} on `)

  // An empty send says nothing (it would hand the lead its own title as a request).
  let launches = 0
  const countLaunch = (r: { method(): string; url(): string }) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start') launches++
  }
  page.on('request', countLaunch)
  await composer.press('Enter')
  await page.waitForTimeout(1500)
  expect(launches).toBe(0)
  await expect(draft).toBeVisible()
  await expect(draft.getByTestId('draft-needs-folder')).toHaveCount(0)
  page.off('request', countLaunch)

  const started = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await composer.fill(`status please ${STAMP}`)
  await composer.press('Enter')
  const res = await started
  expect(res.status(), await res.text()).toBe(200)
  const body = (await res.json()) as { taskId: string; sessionId: string; walnutAgent?: boolean }
  expect(body.taskId).toBe(lead.id)
  await expect(page.locator(`.main-page-session-column [data-session-id="${body.sessionId}"]`).getByText(`I processed your message: status please ${STAMP}`).first())
    .toBeVisible({ timeout: 60_000 })
  // Still the lead: the launch did not turn it into an Ask Walnut chat.
  const after = (await (await request.get(`/api/tasks/${lead.id}`)).json()).task as { org_role?: string; walnut_agent?: boolean }
  expect(after.org_role).toBe('lead')
  expect(after.walnut_agent).toBeFalsy()
})

test('the Tasks page hides the leads, like the board', async ({ page, request }) => {
  // Main is a singleton both browser projects share, so it is checked where the next test
  // makes it; this one only needs the lead the previous test made.
  await isolateUiPrefs(page)
  await loadHome(page)
  const lead = (await orgTree(request)).projects.find((p) => p.project === PROJECT)?.lead
  expect(lead, 'the lead the previous test made').toBeTruthy()
  await page.locator('.sidebar a[href="/tasks"]').first().click()
  await expect(page.locator(`.tp-row[data-task-id="${made[0]}"]`).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(`.tp-row[data-task-id="${lead!.id}"]`)).toHaveCount(0)
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

  // The Tasks page leaves Main out too.
  await page.locator('.sidebar a[href="/tasks"]').first().click()
  await expect(page.locator(`.tp-row[data-task-id="${made[0]}"]`).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(`.tp-row[data-task-id="${taskId}"]`)).toHaveCount(0)
})

test('Main\'s quick actions sit under its Latest line, and a failed send says so', async ({ page }) => {
  await openOrgMain(page)
  const row = page.getByTestId('main-quick-actions')
  await expect(row).toContainText('Ask Main to')
  await expect(row.getByRole('button')).toHaveText(['Tidy projects', 'Put tasks in place', 'Triage'])
  await expect(row).toContainText('Nothing changes until you pick what to apply.')

  await page.route('**/api/v1/org/main', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Main is down for a test' }) }))
  await page.getByTestId('main-qa-projects').click()
  await expect(page.getByTestId('main-qa-error')).toHaveText('Not sent. Try again.')
  await expect(page.getByTestId('main-qa-error')).toHaveAttribute('title', /.+/)
  await expect(page.getByTestId('main-qa-projects')).toBeEnabled()
  // Nothing went, so the page stays where it was.
  await expect(page).not.toHaveURL(/tab=chat/)
})

test('a click sends Main the action, shows its chat, and Main answers; a second click reaches it again', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', SENDS)
  await openOrgMain(page)
  const first = await clickForReply(page, () => page.getByTestId('main-qa-projects').click(), 'Quick action: tidy my projects.')
  await expect(first).toContainText('I processed your message: Quick action: tidy my projects.')
  await expect(first).toContainText('read calls only')
  await expect(page).toHaveURL(/tab=chat/)
  // The row stays above the chat, so the next action is one click away.
  await expect(page.getByTestId('main-quick-actions')).toBeVisible()
  const second = await clickForReply(page, () => page.getByTestId('main-qa-triage').click(), 'Quick action: triage my open tasks.')
  await expect(second).toContainText('I processed your message: Quick action: triage my open tasks.')
})

test('the Tasks page asks Main about the project it shows', async ({ page, browserName }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByRole('link', { name: 'Tasks', exact: true }).click()
  await expect(page).toHaveURL(/\/tasks/)
  const trigger = page.getByTestId('main-qa-trigger')
  await expect(trigger).toHaveText('Tidy up')
  // In the Projects heading, so the toolbar's title keeps its room.
  await expect(page.locator('.tp-rail-title').getByTestId('main-qa-trigger')).toBeVisible()

  // All tasks: all three actions.
  await trigger.click()
  const menu = page.getByTestId('main-qa-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('main-qa-projects')).toBeVisible()
  await expect(menu).toContainText('Nothing changes until you pick what to apply.')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()

  // One project: no merge.
  await page.locator(`[data-rail-project="${QA_PROJECT}"]`).click()
  await expect(page.locator('.tp-title')).toHaveText(QA_PROJECT)
  await trigger.click()
  await expect(menu.getByTestId('main-qa-projects')).toHaveCount(0)
  await expect(menu.getByTestId('main-qa-place')).toBeVisible()
  if (browserName !== 'webkit') return // SENDS

  await menu.getByTestId('main-qa-place').click()
  await expect(page).toHaveURL(/\/org\?node=main&tab=chat/)
  await expect(page.getByTestId('org-detail-title')).toHaveText('Main')
  const chat = mainChat(page)
  await expect(chat).toBeVisible({ timeout: 60_000 })
  await expect(replies(chat).filter({ hasText: `Only look at the project "${QA_PROJECT}".` })).toHaveCount(1, { timeout: 90_000 })
})

test('a Main waiting on the user\'s answer is not sent to: its chat opens on the question', async ({ page, request, browserName }) => {
  test.skip(browserName !== 'webkit', SENDS)
  const main = ((await (await request.post('/api/v1/org/main')).json()) as { task: { id: string; session_id?: string } }).task
  const sid = main.session_id
  expect(sid, 'an earlier test started Main').toBeTruthy()
  const ask = await request.post(`/api/v1/sessions/${sid}/messages`, { data: { text: 'status-permission-test:AskUserQuestion' } })
  expect(ask.ok(), await ask.text()).toBe(true)
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${sid}`)).json()).session?.pendingPermission?.toolName ?? ''),
    { timeout: 90_000 }).toBe('AskUserQuestion')

  try {
    await openOrgMain(page)
    await page.getByTestId('main-qa-triage').click()
    await expect(page.getByTestId('main-qa-held')).toContainText('Main is waiting on your answer')
    await expect(page.getByTestId('org-tab-chat')).toHaveAttribute('aria-selected', 'true')
    await expect(mainChat(page).getByText('Which validation target?').first()).toBeVisible({ timeout: 30_000 })
    // The question still waits: the click did not answer or refuse it.
    expect(((await (await request.get(`/api/sessions/${sid}`)).json()).session?.pendingPermission?.toolName ?? '')).toBe('AskUserQuestion')
  } finally {
    // Leave Main free for the rest of the fixture: a person's message refuses the question.
    await request.post(`/api/v1/sessions/${sid}/messages`, { data: { text: `never mind ${STAMP}` } })
    await expect.poll(async () => ((await (await request.get(`/api/sessions/${sid}`)).json()).session?.pendingPermission?.toolName ?? ''),
      { timeout: 60_000 }).toBe('')
  }
})
