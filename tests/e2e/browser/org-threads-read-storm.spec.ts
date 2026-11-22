/**
 * A busy team does not flood the page with reads of its lead's Threads (2026-11-21, live: one Mac
 * app window on /org read a VP's Threads 2 to 4 at a time about every 1.5 s, 1604 reads in an hour,
 * because each task:updated of a task a thread lists started one read per surface of the node. The
 * page's connection pool filled up and every other request waited 20 to 60 s and was rejected,
 * which the real-use alarm reported as "GET unknown request rejected in the page").
 *
 *  1. The lead's Threads open on /org; a task its thread lists is changed every 150 ms for 20 s.
 *  2. The page reads the lead's Threads at most once at a time, and about once per 5 s gap.
 *  3. No request of the page is rejected in its connection queue, and the card still follows the
 *     task (its new title shows) once the stream stops.
 * The fixture is shared: this file makes its own project and tasks and removes them.
 */
import { expect, test, type APIRequestContext } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Busy team ${STAMP}`
const made: string[] = []
const ids = { lead: '', leadSid: '', worker: '' }
const STORM_MS = 20_000

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function send<T>(request: APIRequestContext, method: 'post' | 'patch', url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request[method](url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
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

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  // A project with two or more teams gets a lead (org_contact).
  for (const title of [`Paint the fence ${STAMP}`, `Fix the gate ${STAMP}`]) {
    made.push((await send<{ task: { id: string } }>(request, 'post', '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  ids.worker = made[0]
  ids.lead = (await send<{ task: { id: string } }>(request, 'post', '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  await send(request, 'post', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: ids.lead })
  await expect.poll(async () => (ids.leadSid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  const opened = await send<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.lead}/threads/open`, { title: `The fence ${STAMP}`, text: 'The fence needs a second coat.', from: 'node', state: 'answered' }, ids.leadSid)
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${opened.thread.id}`, { state: 'working', add_tasks: [ids.worker] }, ids.leadSid)
})

test.afterAll(async ({ request }) => {
  for (const id of made) await removeTask(request, id)
})

test('a task the lead\'s thread lists changing every 150 ms reads the Threads once at a time, about every 5 s', async ({ page, request }) => {
  const rejected: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' && /rejected after \d+ms in the connection queue/.test(m.text())) rejected.push(m.text()) })
  const listPath = `/api/v1/tasks/${ids.lead}/threads`
  const isList = (url: string) => new URL(url).pathname === listPath
  let inFlight = 0
  let maxInFlight = 0
  let reads = 0
  page.on('request', (r) => { if (r.method() === 'GET' && isList(r.url())) { reads++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight) } })
  const done = (r: { method(): string; url(): string }) => { if (r.method() === 'GET' && isList(r.url())) inFlight-- }
  page.on('requestfinished', done)
  page.on('requestfailed', done)

  await isolateUiPrefs(page)
  // The thread is in progress: its line starts open, so its task chip shows.
  await page.addInitScript(() => { localStorage.setItem('open-walnut-view:org.threads.showInProgress', 'true') })
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(PROJECT))
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
  const chip = detail.locator(`[data-testid="org-thread-task"][data-task-id="${ids.worker}"]`).first()
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_000)

  reads = 0
  maxInFlight = inFlight
  const end = Date.now() + STORM_MS
  for (let i = 0; Date.now() < end; i++) {
    await send(request, 'patch', `/api/tasks/${ids.worker}`, { priority: i % 2 ? 'important' : 'backlog' })
    await page.waitForTimeout(150)
  }
  const stormReads = reads
  // The stream stops with a new title: the card follows it.
  await send(request, 'patch', `/api/tasks/${ids.worker}`, { title: `Paint the fence twice ${STAMP}` })
  await expect(chip).toContainText(`Paint the fence twice ${STAMP}`, { timeout: 15_000 })

  test.info().annotations.push({ type: 'reads', description: `${stormReads} reads in ${STORM_MS} ms, at most ${maxInFlight} at once` })
  expect(maxInFlight).toBeLessThanOrEqual(1)
  expect(stormReads).toBeLessThanOrEqual(STORM_MS / 5_000 + 2)
  expect(rejected).toEqual([])
})
