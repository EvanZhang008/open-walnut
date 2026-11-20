/**
 * His Acknowledge means he knows (experiment ack_means_known, src/core/org/thread-ack.ts,
 * web/src/components/org/useOrgThreads.ts; 2026-11-20, the user: "I acknowledge it, but that does
 * not mean the thread is gone ... the thread is truly closed only when the problem is really solved").
 *
 *  1. A lead's answered thread whose task still runs: Acknowledge takes the card out of his list,
 *     and it shows under the folded "in progress, nothing for you" line, pending, not closed.
 *  2. A lead's answered thread whose only task is done: Acknowledge closes it, under "closed this week".
 * The fixture is shared: this file makes its own project and tasks, and puts the flag back.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Bakery ${STAMP}`
const made: string[] = []
const ids = { lead: '', leadSid: '', running: '', done: '', open: '', finished: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ video: 'on', viewport: { width: 1280, height: 800 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

interface Thread { id: string; state: string; ackedAt?: string; closed?: { how: string; by: string } }

async function post<T>(request: APIRequestContext, url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request.post(url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function flag(request: APIRequestContext, on: boolean): Promise<void> {
  const res = await request.put('/api/config', { data: { experimental: { ack_means_known: on } } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function createTask(request: APIRequestContext, title: string): Promise<string> {
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })
  made.push(task.id)
  return task.id
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

/** The lead opens a thread it answered, handed to `task` (as its thread_create and thread_update do). */
async function leadThread(request: APIRequestContext, title: string, task: string): Promise<string> {
  const opened = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.lead}/threads/open`, {
    title, text: `${title}: handed to the team, I will tell you how it went.`, state: 'answered', from: 'node', tasks: [task],
  }, ids.leadSid)
  const res = await request.patch(`/api/v1/tasks/${ids.lead}/threads/${opened.thread.id}`, {
    data: { reply: `${title}: the team is on it.`, state: 'answered', add_tasks: [task] }, headers: { 'x-walnut-caller-sid': ids.leadSid },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return opened.thread.id
}

async function threadOf(request: APIRequestContext, id: string): Promise<Thread | undefined> {
  const res = await request.get(`/api/v1/tasks/${ids.lead}/threads`)
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { threads: Thread[] }).threads.find((t) => t.id === id)
}

async function openLead(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(PROJECT))
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
}

const inList = (page: Page, show: 'open' | 'hidden' | 'closed', id: string) =>
  page.locator(`[data-testid="org-threads"] ul[data-show="${show}"] [data-testid="org-thread"][data-thread-id="${id}"]`)

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/thread-ack-means-known-${name}-${test.info().project.name}.png` })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  ids.running = await createTask(request, `Fix the oven timer ${STAMP}`)
  ids.done = await createTask(request, `Order the rye flour ${STAMP}`)
  // A project with two or more open teams gets a lead (org_contact); the flour task is done after.
  ids.lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  expect((await request.patch(`/api/tasks/${ids.done}`, { data: { phase: 'COMPLETE' } })).ok()).toBe(true)
  await post(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: ids.lead })
  await expect.poll(async () => (ids.leadSid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  await flag(request, true)
  ids.open = await leadThread(request, `Oven timer ${STAMP}`, ids.running)
  ids.finished = await leadThread(request, `Rye flour ${STAMP}`, ids.done)
})

test.afterAll(async ({ request }) => {
  await flag(request, false)
  for (const id of made) await removeTask(request, id)
})

test('Acknowledge on a thread whose task still runs keeps it, out of sight; one with nothing open closes', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await openLead(page)
  await expect(inList(page, 'open', ids.open)).toBeVisible({ timeout: 20_000 })
  await expect(inList(page, 'open', ids.finished)).toBeVisible()
  await shot(page, '1-both-open')

  // 1. Its task still runs: the card leaves his list and waits under the folded line.
  await inList(page, 'open', ids.open).getByTestId('org-thread-ack').click()
  await expect(inList(page, 'open', ids.open)).toHaveCount(0)
  const hiddenToggle = page.getByTestId('org-threads-hidden')
  await expect(hiddenToggle).toContainText('in progress, nothing for you')
  await expect(hiddenToggle).toHaveAttribute('aria-expanded', 'false')
  await hiddenToggle.click()
  await expect(inList(page, 'hidden', ids.open)).toBeVisible()
  await expect(inList(page, 'closed', ids.open)).toHaveCount(0)
  await expect.poll(async () => (await threadOf(request, ids.open))?.state).toBe('pending')
  const kept = await threadOf(request, ids.open)
  expect(kept?.closed).toBeUndefined()
  expect(kept?.ackedAt).toBeTruthy()
  await shot(page, '2-kept-in-progress')

  // 2. Its only task is done: Acknowledge closes it.
  await inList(page, 'open', ids.finished).getByTestId('org-thread-ack').click()
  await expect(inList(page, 'open', ids.finished)).toHaveCount(0)
  await page.getByTestId('org-threads-closed').click()
  await expect(inList(page, 'closed', ids.finished)).toBeVisible()
  await expect(inList(page, 'hidden', ids.finished)).toHaveCount(0)
  expect((await threadOf(request, ids.finished))?.closed).toMatchObject({ how: 'acked', by: 'human' })
  // The one kept open is still under the folded line, not closed.
  await expect(inList(page, 'hidden', ids.open)).toBeVisible()
  await expect(inList(page, 'closed', ids.open)).toHaveCount(0)
  await shot(page, '3-closed')
  expect(pageErrors).toEqual([])
})
