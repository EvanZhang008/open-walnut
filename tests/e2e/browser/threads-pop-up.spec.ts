/**
 * A task's thread pops up to its lead, and his reply there wakes the task (experiment
 * threads_pop_up, src/core/org/thread-popup.ts, thread-reply.ts, web/src/components/org/
 * PoppedThreadCard.tsx; 2026-11-20, the user: "if we reply I think it should go directly to that
 * thread, also send a buffer message to the main agent").
 *
 *  1. A subtask of a lead opens a thread that waits on him. On the lead's Threads (Org page) the
 *     same thread shows as the ask card, naming the subtask; the lead's own Threads hold no copy.
 *  2. He answers in the card's reply box: the card says the task has not read it yet, then the
 *     words reach the subtask's own chat (its session runs a turn on them), and the subtask's
 *     thread holds his message.
 *  3. Off (the flag's default), the lead lists only its own threads.
 *  4. A thread below asking him to pick carries its options: the card shows them as buttons (the
 *     recommended one first, marked), no Acknowledge; a click sends its label to the subtask's
 *     thread as his reply (2026-11-20, the user: "if you recommend this, why can I not just click it?").
 * The fixture is shared: this file makes its own project and tasks, and puts the flag back.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Popup ${STAMP}`
const made: string[] = []
const ids = { lead: '', owner: '', ownerSid: '', thread: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`
const ASK = `Turn the new thread store on in your own settings now, or wait a day? ${STAMP}`
const REPLY = `Turn it on now ${STAMP}`

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ video: 'on', viewport: { width: 1280, height: 800 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function post<T>(request: APIRequestContext, url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request.post(url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function flag(request: APIRequestContext, on: boolean): Promise<void> {
  const res = await request.put('/api/config', { data: { experimental: { threads_pop_up: on } } })
  expect(res.ok(), await res.text()).toBe(true)
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

async function openLead(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(PROJECT))
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
}

const card = (page: Page) => page.locator(`[data-testid="org-thread"][data-thread-id="${ids.thread}"]`)

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/threads-pop-up-${name}-${test.info().project.name}.png` })
}

async function startSession(request: APIRequestContext, taskId: string, fixtureRoot: string): Promise<string> {
  await post(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId })
  let sid = ''
  await expect.poll(async () => (sid = (await (await request.get(`/api/tasks/${taskId}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  return sid
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  // A project with two or more teams gets a lead (org_contact).
  for (const title of [`Side work ${STAMP}`, `More work ${STAMP}`]) {
    made.push((await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  ids.lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Task status foundation ${STAMP}`, project: PROJECT, source: 'local', parent_task_id: ids.lead })
  ids.owner = task.id
  made.push(task.id)
  // Threads on for this task alone: the fixture's task_threads switch stays as it is.
  const on = await request.patch(`/api/tasks/${ids.owner}`, { data: { threads_on: true } })
  expect(on.ok(), await on.text()).toBe(true)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  ids.ownerSid = await startSession(request, ids.owner, fixtureRoot)
  // The subtask opens a thread that waits on him, as its own session does with thread_create.
  const opened = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.owner}/threads/open`, {
    title: `Thread store switch ${STAMP}`, text: ASK, state: 'needs', from: 'node',
    user_kind: 'user_own', user_kind_why: 'It changes his own settings and data store.',
  }, ids.ownerSid)
  ids.thread = opened.thread.id
  const asked = await request.patch(`/api/v1/tasks/${ids.owner}/threads/${ids.thread}`, { data: { reply: ASK, state: 'needs', user_kind: 'user_own', user_kind_why: 'It changes his own settings and data store.' }, headers: { 'x-walnut-caller-sid': ids.ownerSid } })
  expect(asked.ok(), await asked.text()).toBe(true)
})

test.afterAll(async ({ request }) => {
  await flag(request, false)
  for (const id of made) await removeTask(request, id)
})

test('off: the lead lists only its own threads', async ({ page, request }) => {
  await flag(request, false)
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  await page.waitForTimeout(1_000)
  await expect(card(page)).toHaveCount(0)
})

test('on: the subtask\'s thread shows on its lead, and his reply there wakes the subtask', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await flag(request, true)
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)

  // 1. The one record, listed on the lead, naming its owner; the lead holds no copy of it.
  const popped = card(page)
  await expect(popped).toBeVisible({ timeout: 20_000 })
  await expect(popped).toHaveAttribute('data-owner', ids.owner)
  await expect(popped.getByTestId('org-thread-owner')).toHaveText(`Task status foundation ${STAMP}`)
  await expect(popped.getByTestId('org-thread-popped')).toContainText(ASK)
  const own = await (await request.get(`/api/v1/tasks/${ids.lead}/threads`)).json() as { threads: Array<{ id: string; owner?: { task_id: string } }> }
  expect(own.threads.filter((t) => t.id === ids.thread).map((t) => t.owner?.task_id)).toEqual([ids.owner])
  await shot(page, '1-popped')

  // 2. He answers in the card, typing as a person does.
  await popped.getByTestId('org-thread-popped-input').click()
  await page.keyboard.type(REPLY, { delay: 20 })
  await popped.getByTestId('org-thread-popped-send').click()
  await shot(page, '2-sent')

  // The words land in the subtask's own thread and reach its session, which reads them.
  await expect.poll(async () => {
    const file = await (await request.get(`/api/v1/tasks/${ids.owner}/threads`)).json() as { threads: Array<{ id: string; messages: Array<{ text: string; delivery?: { state: string } }> }> }
    return file.threads.find((t) => t.id === ids.thread)?.messages.find((m) => m.text === REPLY)?.delivery?.state ?? 'none'
  }, { timeout: 60_000 }).toBe('delivered')

  // Once the subtask has his words, the card leaves the lead's list: nothing waits on him there.
  await expect(card(page)).toHaveCount(0, { timeout: 20_000 })
  // He opens the subtask from the lead's Tasks: his words are in its chat.
  const side = page.getByRole('group', { name: 'Threads, Tasks or Brief' })
  await side.getByRole('button', { name: /^Tasks/ }).click()
  const row = page.getByRole('button', { name: new RegExp(`^Task status foundation ${STAMP}`) }).first()
  // Its turn on his words has ended, so it may sit in the folded Waiting / snoozed group.
  if (!(await row.isVisible())) await page.getByRole('button', { name: /Waiting \/ snoozed/ }).last().click()
  await row.click()
  const chat = page.locator('.main-page-session-column, .session-panel').filter({ hasText: REPLY }).first()
  await expect(chat).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_500)
  await page.screenshot({ path: `${SHOTS}/threads-pop-up-3-woken-${test.info().project.name}.png` })
  expect(pageErrors).toEqual([])
})

test('on: a choice on a thread below is clicked on the lead, and goes to the subtask as his reply', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const PICK = `Keep the old store ${STAMP}`
  const opened = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.owner}/threads/open`, {
    title: `Store migration ${STAMP}`, text: `Move the thread store this week or keep the old one? ${STAMP}`, state: 'needs', from: 'node',
    user_kind: 'user_own', user_kind_why: 'It changes his own data store.',
    options: [{ id: 'move', label: `Move it this week ${STAMP}` }, { id: 'keep', label: PICK, detail: 'Nothing to migrate now', recommended: true }],
  }, ids.ownerSid)
  const choice = opened.thread.id
  await flag(request, true)
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  const popped = page.locator(`[data-testid="org-thread"][data-thread-id="${choice}"]`)
  await expect(popped).toBeVisible({ timeout: 20_000 })
  const buttons = popped.getByTestId('org-thread-options').getByTestId('org-answer-option')
  await expect(buttons).toHaveText([PICK, `Move it this week ${STAMP}`])
  await expect(buttons.first()).toHaveAttribute('data-recommended', 'true')
  await expect(popped.getByTestId('org-thread-popped-input')).toBeVisible()
  await expect(popped.getByTestId('org-thread-ack')).toHaveCount(0)
  await shot(page, '4-options')
  await buttons.first().click()
  await expect.poll(async () => {
    const file = await (await request.get(`/api/v1/tasks/${ids.owner}/threads`)).json() as { threads: Array<{ id: string; messages: Array<{ text: string; delivery?: { state: string } }> }> }
    return file.threads.find((t) => t.id === choice)?.messages.find((m) => m.text === PICK)?.delivery?.state ?? 'none'
  }, { timeout: 60_000 }).toBe('delivered')
  await expect(popped).toHaveCount(0, { timeout: 20_000 })
  expect(pageErrors).toEqual([])
})
