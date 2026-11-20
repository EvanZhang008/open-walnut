/**
 * The thread line under each chat message (experiment reply_thread_line;
 * web/src/components/sessions/reply-thread-line.tsx, src/core/org/reply-thread.ts; 2026-11-20, the
 * user, translated: "every time I reply I can't tell which one I replied to ... click it and jump to
 * that thread").
 *
 *  1. On a lead's chat he types a request, then answers a thread the lead opened from that card's
 *     Follow up box: each bubble shows "↳ <its own thread>", no "Delivered" under either; the lead
 *     retitles the first thread and its line reads the new title; the answer under his request
 *     carries the same line on the left.
 *  2. With the side bar on Tasks, a click on the first line brings Threads back with that thread's
 *     card in view and marked.
 *  3. A task of the lead's with Threads on: his message in its own chat names its thread, and
 *     the line opens the task's Threads view beside its chat, on that card.
 *  4. With top_thread on, the thread on show above the chat is the top's: a line about another of
 *     its threads steps the top to that one and marks it, the side bar left as it was; with the top
 *     hidden, the line opens the side bar's Threads.
 *  5. Off (the flag's default): the same chat shows no line at all (today's look).
 * The fixture is shared: this file makes its own project and tasks, and puts the flag back.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { showTasks } from './org-view-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Reply lines ${STAMP}`
const made: string[] = []
const ids = { lead: '', leadSid: '', opened: '', work: '', workSid: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`
const FOLDERS = `What should the two folders in Notes be called? ${STAMP}`
const SHORTCUT = `Yes, Cmd+K is fine for the quick menu ${STAMP}`
const OPENED = `Quick menu shortcut ${STAMP}`
const WORK = `Parser cleanup ${STAMP}`
const ASK_WORK = `Please keep the old parser behind a switch ${STAMP}`

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ video: 'on', viewport: { width: 1280, height: 800 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

interface Thread { id: string; title: string; messages: Array<{ text: string }> }

async function post<T>(request: APIRequestContext, url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request.post(url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

let topBefore: boolean | null = null

async function flag(request: APIRequestContext, on: boolean, name = 'reply_thread_line'): Promise<void> {
  if (name === 'top_thread' && topBefore === null) {
    const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
    topBefore = !!cfg.config?.experimental?.top_thread
  }
  const res = await request.put('/api/config', { data: { experimental: { [name]: on } } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function threads(request: APIRequestContext): Promise<Thread[]> {
  return ((await (await request.get(`/api/v1/tasks/${ids.lead}/threads`)).json()) as { threads: Thread[] }).threads
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

const chat = (page: Page) => page.locator(`[data-testid="org-chat"] .session-panel[data-session-id="${ids.leadSid}"]`)
const card = (page: Page, id: string) => page.locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)
/** His bubble with these words, and the thread line right under it. */
const bubble = (page: Page, text: string) => chat(page).locator('.session-msg-user').filter({ hasText: text }).last()
const lineUnder = (page: Page, text: string) => bubble(page, text).locator('xpath=following-sibling::*[1][@data-testid="msg-reply-thread"]')

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('org-detail').screenshot({ path: `${SHOTS}/reply-thread-line-${name}-${test.info().project.name}.png` })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  // The chat as it is without the top thread (the shared fixture may have it on); put back after.
  await flag(request, false, 'top_thread')
  // A project with two or more teams gets a lead (org_contact).
  for (const title of [`Notes folders ${STAMP}`, `Quick menu ${STAMP}`]) {
    made.push((await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  ids.lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  // A task under the lead that keeps Threads (its menu's switch).
  ids.work = (await post<{ task: { id: string } }>(request, '/api/tasks', { title: WORK, project: PROJECT, source: 'local', parent_task_id: ids.lead })).task.id
  made.push(ids.work)
  const on = await request.patch(`/api/tasks/${ids.work}`, { data: { threads_on: true } })
  expect(on.ok(), await on.text()).toBe(true)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  await post(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started. MOCK_PERSIST_TURNS', taskId: ids.work })
  await expect.poll(async () => (ids.workSid = (await (await request.get(`/api/tasks/${ids.work}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  // MOCK_PERSIST_TURNS: the mock CLI files each later turn as its transcript, so his lines come back as history rows.
  await post(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started. MOCK_PERSIST_TURNS', taskId: ids.lead })
  await expect.poll(async () => (ids.leadSid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  // The lead opens a thread of its own that he answers from its card, as its session does with thread_create.
  ids.opened = (await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.lead}/threads/open`, {
    title: OPENED, text: 'Should the quick menu get a global shortcut? I would use Cmd+K.', from: 'node',
    user_kind: 'user_own', user_kind_why: 'He asked to pick the quick menu shortcut himself.',
  }, ids.leadSid)).thread.id
})

test.afterAll(async ({ request }) => {
  await flag(request, false)
  if (topBefore !== null) await flag(request, topBefore, 'top_thread')
  for (const id of made) await removeTask(request, id)
})

test('on: each message shows the thread it went to, and a click opens that thread', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await flag(request, true)
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  const composer = chat(page).locator('.chat-input-textarea[data-draft-key^="draft:session:"]')
  await expect(composer).toBeVisible({ timeout: 30_000 })

  // 1. A request typed into the chat: its own new thread, named under the bubble.
  await composer.click()
  await page.keyboard.type(FOLDERS, { delay: 15 })
  await composer.press('Enter')
  await expect.poll(async () => (await threads(request)).find((t) => t.messages.some((m) => m.text === FOLDERS))?.id ?? '', { timeout: 30_000 }).not.toBe('')
  const folders = (await threads(request)).find((t) => t.messages.some((m) => m.text === FOLDERS))!.id
  const first = lineUnder(page, FOLDERS)
  await expect(first).toHaveAttribute('data-thread-id', folders, { timeout: 30_000 })
  await expect(first).toHaveText(`↳${FOLDERS}`)

  // The lead gives it a short title: the line reads it.
  const titled = await request.patch(`/api/v1/tasks/${ids.lead}/threads/${folders}`, { data: { title: `Notes folder names ${STAMP}` }, headers: { 'x-walnut-caller-sid': ids.leadSid } })
  expect(titled.ok(), await titled.text()).toBe(true)
  await expect(first).toHaveText(`↳Notes folder names ${STAMP}`, { timeout: 15_000 })

  // 2. His answer to the lead's own thread, from that card's Follow up box: the line names that thread.
  const opened = card(page, ids.opened)
  // The card's Follow up box is open on it (OrgThreads ThreadFollowUp).
  await opened.getByTestId('org-thread-follow-input').click()
  await page.keyboard.type(SHORTCUT, { delay: 15 })
  await opened.getByTestId('org-thread-follow-send').click()
  const second = lineUnder(page, SHORTCUT)
  await expect(second).toHaveAttribute('data-thread-id', ids.opened, { timeout: 30_000 })
  await expect(second).toHaveText(`↳${OPENED}`)

  // Delivered says nothing more: no "Delivered" under either bubble once it arrived.
  await expect(chat(page).locator('.session-msg-delivered-badge')).toHaveCount(0, { timeout: 15_000 })
  await expect(chat(page).getByText('Delivered', { exact: false })).toHaveCount(0)
  await shot(page, '1-lines')

  // The lead's answer to his request carries the same line, on the left.
  const answer = chat(page).locator(`[data-testid="msg-reply-thread"][data-side="answer"][data-thread-id="${folders}"]`)
  await expect(answer.first()).toBeVisible({ timeout: 60_000 })

  // 3. The side bar on Tasks; one click on the first line brings Threads back, on that card.
  await showTasks(page.getByTestId('org-detail'))
  await page.waitForTimeout(600)
  await first.getByTestId('msg-reply-thread-open').click()
  await expect(page.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
  await expect(card(page, folders)).toHaveAttribute('data-focused', 'true')
  await expect(card(page, folders)).toBeInViewport()
  await shot(page, '2-opened')
  await page.waitForTimeout(1_500)
  expect(pageErrors).toEqual([])
})

test('a task with Threads on: its chat names the thread, and the line opens its Threads view', async ({ page, request }) => {
  await flag(request, true)
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  // He opens the task from the lead's Tasks.
  await showTasks(page.getByTestId('org-detail'))
  const row = page.getByRole('button', { name: new RegExp(`^${WORK}`) }).first()
  if (!(await row.isVisible())) await page.getByRole('button', { name: /Waiting \/ snoozed/ }).last().click()
  await row.click()
  const panel = page.locator(`.session-panel[data-session-id="${ids.workSid}"]`).last()
  const composer = panel.locator('.chat-input-textarea[data-draft-key^="draft:session:"]')
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await composer.click()
  await page.keyboard.type(ASK_WORK, { delay: 15 })
  await composer.press('Enter')
  let thread = ''
  await expect.poll(async () => {
    const list = ((await (await request.get(`/api/v1/tasks/${ids.work}/threads`)).json()) as { threads: Thread[] }).threads
    return (thread = list.find((t) => t.messages.some((m) => m.text === ASK_WORK))?.id ?? '')
  }, { timeout: 30_000 }).not.toBe('')
  const line = panel.locator('.session-msg-user').filter({ hasText: ASK_WORK }).last().locator('xpath=following-sibling::*[1][@data-testid="msg-reply-thread"]')
  await expect(line).toHaveAttribute('data-thread-id', thread, { timeout: 30_000 })
  await line.getByTestId('msg-reply-thread-open').click()
  const pane = panel.getByTestId('session-threads-pane')
  await expect(pane).toBeVisible({ timeout: 15_000 })
  await expect(pane.locator(`[data-testid="org-thread"][data-thread-id="${thread}"]`)).toHaveAttribute('data-focused', 'true')
  await page.screenshot({ path: `${SHOTS}/reply-thread-line-4-task-${test.info().project.name}.png` })
})

test('top_thread on: a line about a thread the top lists steps the top to it', async ({ page, request }) => {
  await flag(request, true)
  await flag(request, true, 'top_thread')
  const folders = (await threads(request)).find((t) => t.messages.some((m) => m.text === FOLDERS))!.id
  // Both of his threads answered: both are his to read, so the top lists both ("1 / 2").
  for (const id of [folders, ids.opened]) {
    const res = await request.patch(`/api/v1/tasks/${ids.lead}/threads/${id}`, { data: { reply: `Done, see the notes ${STAMP}.`, state: 'answered' } })
    expect(res.ok(), await res.text()).toBe(true)
  }
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  const top = chat(page).getByTestId('top-thread')
  await expect(top).toHaveAttribute('data-count', '2', { timeout: 30_000 })
  await showTasks(page.getByTestId('org-detail'))
  await expect(page.getByTestId('org-top')).toHaveAttribute('data-view', 'task')
  const shown = await top.getAttribute('data-thread-id')
  const other = shown === folders ? ids.opened : folders
  const words = other === folders ? FOLDERS : SHORTCUT
  await lineUnder(page, words).getByTestId('msg-reply-thread-open').click()
  await expect(top).toHaveAttribute('data-thread-id', other)
  await expect(top.locator(`[data-testid="org-thread"][data-thread-id="${other}"]`)).toHaveAttribute('data-focused', 'true')
  await expect(top).toBeInViewport()
  // The side bar stays where he left it: the top showed the thread.
  await expect(page.getByTestId('org-top')).toHaveAttribute('data-view', 'task')
  await shot(page, '5-top')
  // Hidden, the top shows no thread: the line opens the side bar's Threads, on that card.
  await top.getByTestId('top-thread-hide').click()
  await expect(top).toHaveAttribute('data-hidden', 'true')
  await lineUnder(page, words).getByTestId('msg-reply-thread-open').click()
  await expect(page.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
  await expect(page.locator(`[data-testid="org-threads"] [data-testid="org-thread"][data-thread-id="${other}"]`)).toHaveAttribute('data-focused', 'true')
  // The top's Hide is kept for every chat: put it back.
  await top.getByTestId('top-thread-show').click()
  await expect(top).not.toHaveAttribute('data-hidden', 'true')
  await flag(request, false, 'top_thread')
})

test('off: the same chat shows no thread line', async ({ page, request }) => {
  await flag(request, false)
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  await expect(bubble(page, FOLDERS)).toBeVisible({ timeout: 30_000 })
  await expect(bubble(page, SHORTCUT)).toBeVisible()
  await page.waitForTimeout(1_000)
  await expect(chat(page).getByTestId('msg-reply-thread')).toHaveCount(0)
  await shot(page, '3-off')
})
