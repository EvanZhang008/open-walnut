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
 *   - Main's quick actions (web/src/components/org/main-quick-plus-rows.ts, main-quick-menus.tsx):
 *     no bar of their own; Tidy projects / Put tasks in place / Triage sit under "Quick actions"
 *     in the "+" of Main's own composer, where a click sends Main the action (the draft in the
 *     box stays) and Main answers; a project's ⋮ on the Tasks page asks about that project, and a
 *     failed send says so; a Main waiting on the user's answer is not sent to
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

/** Main's composer "+" in its chat on the Org page, open. */
async function openMainPlus(page: Page): Promise<Locator> {
  const chat = mainChat(page)
  await expect(chat).toBeVisible({ timeout: 60_000 })
  await chat.locator('.session-panel-input .chat-plus-btn').click()
  const menu = chat.locator('.chat-plus-menu')
  await expect(menu).toBeVisible()
  return menu
}
const quickRows = (menu: Locator) => menu.locator('[data-action-id^="main-qa-"]')

/** A project's ⋮ menu in the Tasks page rail, open. */
async function openRailProjectMenu(page: Page, project: string): Promise<Locator> {
  // Right-click opens the same menu as the hover ⋮ (rowSelector), and does not hang on a hover.
  await page.locator(`[data-rail-project="${project}"]`).click({ button: 'right' })
  const menu = page.locator('.task-kebab-menu')
  await expect(menu).toBeVisible()
  return menu
}

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

test('Main\'s quick actions sit in its composer\'s "+", not in a bar of their own', async ({ page }) => {
  await openOrgMain(page)
  await expect(page.getByTestId('main-quick-actions')).toHaveCount(0)
  await expect(page.getByTestId('org-detail').getByText('Ask Main to')).toHaveCount(0)
  await page.getByTestId('org-tab-chat').click()
  const menu = await openMainPlus(page)
  await expect(menu.locator('.chat-plus-menu-label').filter({ hasText: 'Quick actions' })).toBeVisible()
  await expect(quickRows(menu)).toHaveText(['Tidy projects', 'Put tasks in place', 'Triage'])
  await expect(quickRows(menu).first()).toHaveAttribute('title', /Nothing changes until you pick what to apply\./)
  await expect(quickRows(menu).first()).not.toHaveAttribute('aria-disabled', 'true')
  await mainChat(page).locator('.session-panel-input .chat-plus-btn').click()
  await expect(menu).toHaveCount(0)
})

test('a quick action from Main\'s "+" sends it, keeps the draft, and Main answers; a second one reaches it again', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', SENDS)
  await openOrgMain(page)
  await page.getByTestId('org-tab-chat').click()
  const box = mainChat(page).locator('.session-panel-input .chat-input-textarea')
  const draft = `half typed ${STAMP}`
  await box.fill(draft)
  const pick = (id: string) => async () => {
    const menu = await openMainPlus(page)
    await menu.locator(`[data-action-id="main-qa-${id}"]`).click()
    await expect(menu).toHaveCount(0)
  }
  const first = await clickForReply(page, pick('projects'), 'Quick action: tidy my projects.')
  await expect(first).toContainText('I processed your message: Quick action: tidy my projects.')
  await expect(first).toContainText('read calls only')
  // The action went as its own message: what the user was typing is still in the box.
  await expect(box).toHaveValue(draft)
  const second = await clickForReply(page, pick('triage'), 'Quick action: triage my open tasks.')
  await expect(second).toContainText('I processed your message: Quick action: triage my open tasks.')
  await expect(box).toHaveValue(draft)
  await box.fill('')
})

test('the Tasks page asks Main about one project from that project\'s ⋮, and a failed send says so', async ({ page, browserName }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByRole('link', { name: 'Tasks', exact: true }).click()
  await expect(page).toHaveURL(/\/tasks/)
  // Nothing of its own in the Projects heading.
  await expect(page.getByTestId('main-qa-trigger')).toHaveCount(0)
  await expect(page.locator('.tp-rail-title')).toHaveText('Projects')

  // One project: no merge.
  let menu = await openRailProjectMenu(page, QA_PROJECT)
  await expect(menu.locator('[data-menu-item="main-qa-projects"]')).toHaveCount(0)
  await expect(menu.locator('[data-menu-item^="main-qa-"]')).toHaveText(['Ask Main: Put tasks in place', 'Ask Main: Triage'])
  await expect(menu.locator('[data-menu-item="main-qa-place"]')).toHaveAttribute('title', /Nothing changes until you pick what to apply\./)

  await page.route('**/api/v1/org/main', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Main is down for a test' }) }))
  await menu.locator('[data-menu-item="main-qa-place"]').click()
  await expect(menu).toHaveCount(0)
  const error = page.locator('.tp-rail-title').getByTestId('main-qa-error')
  await expect(error).toHaveText('Not sent. Try again.')
  await expect(error).toHaveAttribute('title', /.+/)
  // Nothing went, so the page stays where it was.
  await expect(page).toHaveURL(/\/tasks/)
  await page.unroute('**/api/v1/org/main')
  if (browserName !== 'webkit') return // SENDS

  menu = await openRailProjectMenu(page, QA_PROJECT)
  await menu.locator('[data-menu-item="main-qa-place"]').click()
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
    // In Main's chat the question is in view, and the "+" rows are off until it is answered.
    await openOrgMain(page)
    await page.getByTestId('org-tab-chat').click()
    await expect(mainChat(page).getByText('Which validation target?').first()).toBeVisible({ timeout: 30_000 })
    const menu = await openMainPlus(page)
    const triage = menu.locator('[data-action-id="main-qa-triage"]')
    await expect(triage).toHaveAttribute('aria-disabled', 'true', { timeout: 30_000 })
    await expect(triage).toHaveAttribute('title', /Main is waiting on your answer/)
    // An off row takes no click (Playwright waits on aria-disabled, so force it).
    await triage.click({ force: true })
    await expect(menu).toBeVisible()
    await mainChat(page).locator('.session-panel-input .chat-plus-btn').click()

    // From the Tasks page: nothing goes, and Main's chat opens on the question.
    await page.getByRole('link', { name: 'Tasks', exact: true }).click()
    await expect(page).toHaveURL(/\/tasks/)
    const rail = await openRailProjectMenu(page, QA_PROJECT)
    await rail.locator('[data-menu-item="main-qa-triage"]').click()
    await expect(page).toHaveURL(/\/org\?node=main&tab=chat/)
    await expect(mainChat(page).getByText('Which validation target?').first()).toBeVisible({ timeout: 30_000 })
    // The question still waits: neither click answered or refused it.
    expect(((await (await request.get(`/api/sessions/${sid}`)).json()).session?.pendingPermission?.toolName ?? '')).toBe('AskUserQuestion')
  } finally {
    // Leave Main free for the rest of the fixture: a person's message refuses the question.
    await request.post(`/api/v1/sessions/${sid}/messages`, { data: { text: `never mind ${STAMP}` } })
    await expect.poll(async () => ((await (await request.get(`/api/sessions/${sid}`)).json()).session?.pendingPermission?.toolName ?? ''),
      { timeout: 60_000 }).toBe('')
  }
})
