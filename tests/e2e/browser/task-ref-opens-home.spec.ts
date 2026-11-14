/**
 * A click on a task reference, wherever it is drawn, goes to Home with that task's session open,
 * and nothing else: no second details popup, no side panel, no Org node (2026-11-13, the user:
 * "why I clcik the taskroute to it jump this task detail I want it direct to go task ... We want
 * to clcik go to taht sesison in home that is it"; and "in this task detail I clcik the session,
 * the panle shoujdl be gone and jump to that task directly").
 *
 * Every task-ref click goes through one action, `openTaskOnHome` (web/src/utils/open-session.ts);
 * tests/web/task-ref-click-guard.test.ts fails on a click handler that goes around it. This spec
 * clicks the real references a person clicks: in a task's details (the "Answered for you" chip,
 * its session row, its parent row), in an Org thread, in the Brief and in a notice.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { loadHome } from './draft-helpers'
import { endRunningTurn, interruptTurn, startRunningTurn } from './status-section-helpers'
import { openAllTurnFolds, revealCard } from './turn-fold-helpers'

test.setTimeout(240_000)
test.describe.configure({ mode: 'default' })

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const made: string[] = []
const sessions: string[] = []

test.afterEach(async ({ request }) => {
  for (const sid of sessions.splice(0)) await endRunningTurn(request, sid)
  for (const id of made.splice(0).reverse()) await request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
})

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await res.text()
  expect(res.ok, `${method} ${p}: ${res.status} ${text}`).toBe(true)
  return (text ? JSON.parse(text) : {}) as T
}

async function newTask(title: string, project: string, patch: Record<string, unknown> = {}): Promise<string> {
  const id = (await api<{ task: { id: string } }>('POST', '/api/tasks', { title, source: 'local', project })).task.id
  made.push(id)
  if (Object.keys(patch).length) await api('PATCH', `/api/v1/tasks/${id}`, patch)
  return id
}

/** A task with a session of its own, its turn over. */
async function withSession(request: APIRequestContext, taskId: string): Promise<string> {
  const sid = await startRunningTurn(request, taskId, 2_000)
  sessions.push(sid)
  await interruptTurn(request, sid)
  return sid
}

const detail = (page: Page) => page.locator('.task-detail-modal')
const column = (page: Page, sid: string) => page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)

/** The task's details popup, opened as a person opens it: its row's menu, Details. */
async function openDetails(page: Page, taskId: string, title: string): Promise<void> {
  await page.locator('.todo-search-input').click()
  await page.keyboard.type(title, { delay: 10 })
  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu').getByRole('button', { name: 'Details', exact: true }).click()
  await expect(detail(page)).toBeVisible({ timeout: 20_000 })
  await expect(detail(page).locator('.todo-detail-title')).toContainText(title)
  await page.locator('.todo-search-input').fill('')
}

/** Home, the session's column open, no details popup over it. */
async function expectOnHome(page: Page, sid: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname).toBe('/')
  await expect(column(page, sid)).toBeVisible({ timeout: 20_000 })
  await expect(detail(page)).toHaveCount(0)
  await expect(page.locator('.task-detail-modal-overlay')).toHaveCount(0)
}

test('a task\'s details: its answered-for chip, its session row and its parent each close the popup and open that session on Home', async ({ page, request }) => {
  const stamp = Date.now()
  const project = `RefHome${stamp}`
  const lead = await newTask(`Ref lead ${stamp}`, project)
  const asker = await newTask(`Ref asker ${stamp}`, project, { parent_task_id: lead })
  const target = await newTask(`Ref target ${stamp}`, project)
  const leadSid = await withSession(request, lead)
  const askerSid = await withSession(request, asker)
  const targetSid = await withSession(request, target)
  await api('PUT', `/api/v1/tasks/${asker}/report`, { state: 'needs', ask: 'Did you sign in to the portal recently?' })
  await expect.poll(async () => (await api<{ task?: { user_status?: { state?: string } } }>('GET', `/api/tasks/${asker}`)).task?.user_status?.state, { timeout: 30_000 }).toBe('needs')
  // The lead answers for the user and names the other task by id: the chip in the answer.
  const sent = await fetch(`${API}/api/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': leadSid },
    body: JSON.stringify({ to: asker, title: 'Answered', text: `Those were our own sign-ins: the profile task (${target}) signed in.`, answers_ask: true, expect_reply: false }),
  })
  expect(sent.status, await sent.clone().text()).toBe(202)
  await expect.poll(async () => (await api<{ task?: { user_status?: { answeredFor?: unknown } } }>('GET', `/api/tasks/${asker}`)).task?.user_status?.answeredFor, { timeout: 30_000 }).toBeTruthy()

  await isolateUiPrefs(page)
  await loadHome(page)

  // 1. The chip in "Answered for you".
  await openDetails(page, asker, `Ref asker ${stamp}`)
  const chip = detail(page).getByTestId('task-detail-answered-for').locator(`a.task-link[data-task-id="${target}"]`)
  await expect(chip).toBeVisible({ timeout: 20_000 })
  await chip.click()
  await expectOnHome(page, targetSid)

  // 1b. The same chip, its words redrawn between the press and the release (a label or a message
  // landing): the browser sends the click to their common parent, and it used to open nothing.
  await openDetails(page, asker, `Ref asker ${stamp}`)
  await expect(chip).toBeVisible({ timeout: 20_000 })
  await chip.evaluate((a) => {
    const words = a.parentElement!
    a.addEventListener('pointerdown', () => { words.innerHTML = words.innerHTML }, { once: true })
  })
  await chip.click()
  await expectOnHome(page, targetSid)

  // 2. The SESSION row.
  await openDetails(page, asker, `Ref asker ${stamp}`)
  await detail(page).locator('.todo-detail-session-item').first().click()
  await expectOnHome(page, askerSid)

  // 3. The PARENT row.
  await openDetails(page, asker, `Ref asker ${stamp}`)
  await detail(page).locator('.tdp-task-row').filter({ hasText: `Ref lead ${stamp}` }).click()
  await expectOnHome(page, leadSid)
})

async function openOrgNode(page: Page, project: string): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  const key = `project:${project.trim().toLowerCase()}`
  await page.locator(`[data-testid="org-channel"][data-key="${key}"]`).click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', key)
}

test('the Org page: a chip in a thread\'s reply, a thread\'s task row and a chip in the Brief each open that session on Home', async ({ page, request }) => {
  const stamp = Date.now()
  const project = `RefOrg${stamp}`
  const target = await newTask(`Org target ${stamp}`, project)
  const other = await newTask(`Org other ${stamp}`, project)
  const lead = (await api<{ task: { id: string } }>('POST', '/api/v1/org/contact', { to: project })).task.id
  made.push(lead)
  const leadSid = await withSession(request, lead)
  const targetSid = await withSession(request, target)
  const otherSid = await withSession(request, other)
  const { thread } = await api<{ thread: { id: string } }>('POST', `/api/v1/tasks/${lead}/threads`, { text: `Where is the export work ${stamp}` })
  await api('PATCH', `/api/v1/tasks/${lead}/threads/${thread.id}`, { state: 'working', reply: `Handed to <task-ref id="${target}" label="Org target"/>.`, add_tasks: [other] }, { 'x-walnut-caller-sid': leadSid })
  await api('PUT', `/api/v1/tasks/${lead}/brief`, { content: `- <task-ref id="${target}" label="Org target"/>: the export is half done.` })

  await isolateUiPrefs(page)
  await page.addInitScript(() => { localStorage.setItem('open-walnut-view:org.threads.showInProgress', 'true') })
  await loadHome(page)

  // 1. A chip in the lead's reply on the thread's card.
  await openOrgNode(page, project)
  const card = page.locator(`[data-testid="org-thread"][data-thread-id="${thread.id}"]`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByTestId('org-thread-reply').locator(`a.task-link[data-task-id="${target}"]`).click()
  await expectOnHome(page, targetSid)

  // 2. The thread's task row.
  await openOrgNode(page, project)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.locator(`[data-task-id="${other}"]`).first().click()
  await expectOnHome(page, otherSid)

  // 3. A chip in the Brief.
  await openOrgNode(page, project)
  await page.getByTestId('org-detail').getByTestId('org-top-brief').click()
  const brief = page.getByTestId('org-brief-body')
  await expect(brief).toContainText('the export is half done', { timeout: 30_000 })
  await brief.locator(`a.task-link[data-task-id="${target}"]`).click()
  await expectOnHome(page, targetSid)
})

test('a session\'s notice: its sender chip opens that task\'s session on Home, the column clicked from stays', async ({ page }) => {
  // The fixture's transcript (test-server.ts `pw-provenance-session`): its user turns are Walnut's own
  // notices, built by the production builders; the mock CLI never writes an inbound notice itself.
  const SESSION = 'pw-provenance-session'
  const PEER_TASK_SESSION = 'pw-mode-test-session'
  await isolateUiPrefs(page)
  await loadHome(page)
  const row = page.locator('.todo-panel-item[data-task-id="pw-task-provenance"]')
  await expect(async () => {
    await page.locator('.todo-search-input').fill('pw-task-provenance')
    await expect(row).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await row.locator('.todo-item-title').click()
  const panel = column(page, SESSION)
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.provenance-card').first()).toBeVisible({ timeout: 20_000 })
  await openAllTurnFolds(panel)
  const notice = panel.locator('.provenance-card[data-envelope-kind="peer-note"]').first()
  const fold = notice.locator('.op-card-main').first()
  // The timeline follows its bottom: a real wheel brings the card up (revealCard).
  await revealCard(page, panel, fold)
  if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click()
  const chip = notice.locator('a.provenance-chip-task[data-task-id="pw-task-001"]')
  await revealCard(page, panel, chip)
  await chip.click()
  await expectOnHome(page, PEER_TASK_SESSION)
  await expect(column(page, SESSION)).toBeVisible()
})
