/**
 * A thread goes with its work, as the user sees it on the Org page (src/core/org/thread-follow.ts,
 * web/src/components/org/OrgThreads.tsx; 2026-11-08, the user, after his thread stayed on the VP that
 * had passed the work on: "should go to walnut vp").
 *
 *  1. his request on one VP's Threads, answered and handed to a task; the task moves to another VP's
 *     project: the thread leaves the first VP's open list for its closed list, reading "Moved to <the
 *     other VP>", and shows on the other VP's Threads with his words, the answer, the summary and
 *     "Moved here from <the first VP>";
 *  2. there he follows it up from the card: the message lands under that thread on that VP.
 * The fixture is shared, so this file makes its own projects and removes what it made.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const FROM = `Moved from ${STAMP}`
const TO = `Moved to ${STAMP}`
const made: string[] = []
const ids = { fromLead: '', toLead: '', work: '', thread: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ video: 'on', viewport: { width: 1280, height: 800 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
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

async function openNode(page: Page, project: string): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(project)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(project))
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
}

const card = (page: Page, id: string) => page.locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/org-thread-moved-${name}-${test.info().project.name}.png` })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Research the bot ${STAMP}`, project: FROM, source: 'local' })
  ids.work = task.id
  made.push(task.id)
  // A project with two or more teams gets a lead (org_contact): two tasks in each.
  for (const [title, project] of [[`Side work ${STAMP}`, FROM], [`Other work ${STAMP}`, TO], [`More work ${STAMP}`, TO]]) {
    const other = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project, source: 'local' })
    made.push(other.task.id)
  }
  ids.fromLead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: FROM })).task.id
  ids.toLead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: TO })).task.id
  made.push(ids.fromLead, ids.toLead)
  // The VP he follows the thread up with has a session (the Follow up is a message into its chat).
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  await post(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: ids.toLead })
  await expect.poll(async () => (await (await request.get(`/api/tasks/${ids.toLead}`)).json()).task?.session_id ?? '', { timeout: 90_000 }).not.toBe('')
  // His request on the first VP's Threads, handed to the research task and answered there.
  const filed = await post<{ thread: { id: string; messages: Array<{ id: string }> } }>(request, `/api/v1/tasks/${ids.fromLead}/threads`, { text: `What can our org learn from this open-source bot? ${STAMP}` })
  ids.thread = filed.thread.id
  const res = await request.patch(`/api/v1/tasks/${ids.fromLead}/threads/${ids.thread}`, { data: { title: `Bot lessons ${STAMP}`, reply: 'A research task is on it; the report comes here.', state: 'answered', tasks: [ids.work] } })
  expect(res.ok(), await res.text()).toBe(true)
})

test.afterAll(async ({ request }) => {
  for (const id of made) await removeTask(request, id)
})

test('moving the task moves his thread to the other VP, and he follows it up there', async ({ page, request }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await openNode(page, FROM)
  await expect(card(page, ids.thread).getByTestId('org-thread-title')).toHaveText(`Bot lessons ${STAMP}`)
  await shot(page, '1-before')

  // The user moves the task under the other VP's project (the board's own write).
  const moved = await request.patch(`/api/tasks/${ids.work}`, { data: { project: TO } })
  expect(moved.ok(), await moved.text()).toBe(true)

  // It leaves this VP's open list by itself, into the closed ones, saying where it went.
  await expect(card(page, ids.thread)).toHaveCount(0, { timeout: 30_000 })
  await page.getByTestId('org-threads-closed').click()
  const left = card(page, ids.thread)
  await expect(left.getByTestId('org-thread-closed')).toHaveText(/^Moved to /)
  await expect(left.getByTestId('org-thread-state')).toHaveText('Moved')
  await expect(left.getByTestId('org-thread-moved-to')).toContainText('Research the bot')
  await shot(page, '2-left')

  // On the other VP: the same thread, whole, saying where it came from.
  await openNode(page, TO)
  const there = card(page, ids.thread)
  await expect(there.getByTestId('org-thread-title')).toHaveText(`Bot lessons ${STAMP}`)
  await expect(there.getByTestId('org-thread-moved-from')).toContainText('Moved here from')
  await expect(there.getByTestId('org-thread-reply')).toContainText('A research task is on it')
  await there.getByTestId('org-thread-history').click()
  await expect(there.getByTestId('org-thread-message').first()).toContainText(`What can our org learn from this open-source bot? ${STAMP}`)
  await shot(page, '3-arrived')

  // He follows it up from the card: filed under this thread, on this VP.
  await there.getByTestId('org-thread-follow-open').click()
  const follow = `any results yet? ${STAMP}`
  await there.getByTestId('org-thread-follow-input').fill(follow)
  await there.getByTestId('org-thread-follow-send').click()
  await expect.poll(async () => {
    const r = await request.get(`/api/v1/tasks/${ids.toLead}/threads/${ids.thread}`)
    return ((await r.json()) as { thread?: { messages: Array<{ text: string }> } }).thread?.messages.map((m) => m.text).at(-1)
  }, { timeout: 30_000 }).toBe(follow)
  await shot(page, '4-followed-up')
  const video = page.video()
  await page.close()
  if (video) fs.copyFileSync(await video.path(), `${SHOTS}/org-thread-moved-${test.info().project.name}.webm`)
})
