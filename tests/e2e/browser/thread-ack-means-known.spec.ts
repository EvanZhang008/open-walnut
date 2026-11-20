/**
 * His Acknowledge means he knows (experiment ack_means_known, src/core/org/thread-ack.ts,
 * src/core/org/thread-known.ts, web/src/components/org/ThreadKnown.tsx, ThreadsFilterBar.tsx;
 * 2026-11-20, the user: "I ack, she sees it herself, nothing else, so it closes, right?").
 *
 * With the Brief off (his Threads by state, experiment brief_off):
 *  1. The chips over the groups count each group; a click on Working opens it.
 *  2. Acknowledge on a lead's thread still at work (its task runs): the card moves to the Known
 *     group, open, reading Known, saying what it waits on (the task chip, what it is to finish) and
 *     how it ends; a Known chip counts it; it has no Acknowledge any more.
 *  3. Acknowledge on an answered card (the result is in), its task still open: it closes (Done).
 * With the Brief on (the list as before): the Known thread is in its own "1 known" section, open,
 * and its Close ends it.
 * The fixture is shared: this file makes its own project and tasks, and puts the flags back.
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
const ids = { lead: '', leadSid: '', running: '', other: '', work: '', result: '' }
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

async function flags(request: APIRequestContext, on: { ack_means_known?: boolean; brief_off?: boolean }): Promise<void> {
  const res = await request.put('/api/config', { data: { experimental: on } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function createTask(request: APIRequestContext, title: string, description?: string): Promise<string> {
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local', ...(description ? { description } : {}) })
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

/** The lead opens a thread it answered, handed to `task` (as its thread_create and thread_update do), left in `state`. */
async function leadThread(request: APIRequestContext, title: string, task: string, state: 'answered' | 'working'): Promise<string> {
  const opened = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.lead}/threads/open`, {
    title, text: `${title}: handed to the team, I will tell you how it went.`, state: 'answered', from: 'node', tasks: [task],
  }, ids.leadSid)
  const res = await request.patch(`/api/v1/tasks/${ids.lead}/threads/${opened.thread.id}`, {
    data: { reply: `${title}: the team is on it.`, state, add_tasks: [task] }, headers: { 'x-walnut-caller-sid': ids.leadSid },
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

const group = (page: Page, g: string) => page.locator(`section[data-testid="org-thread-group"][data-group="${g}"]`)
const card = (page: Page, g: string, id: string) => group(page, g).locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)
const chip = (page: Page, g: string) => page.locator(`[data-testid="org-threads-chip"][data-group="${g}"]`)

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/thread-ack-means-known-${name}-${test.info().project.name}.png` })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  ids.running = await createTask(request, `Fix the oven timer ${STAMP}`, 'Swap the timer board and check it counts down to the second.')
  ids.other = await createTask(request, `Order the rye flour ${STAMP}`)
  // A project with two or more open teams gets a lead (org_contact).
  ids.lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  await post(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: ids.lead })
  await expect.poll(async () => (ids.leadSid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  await flags(request, { ack_means_known: true, brief_off: true })
  ids.work = await leadThread(request, `Oven timer ${STAMP}`, ids.running, 'working')
  ids.result = await leadThread(request, `Oven test results ${STAMP}`, ids.running, 'answered')
})

test.afterAll(async ({ request }) => {
  await flags(request, { ack_means_known: false, brief_off: false })
  for (const id of made) await removeTask(request, id)
})

test('Acknowledge: a thread still at work is Known and says what it waits on; a result closes', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await openLead(page)
  await expect(page.getByTestId('org-thread-groups')).toBeVisible({ timeout: 20_000 })
  await expect(card(page, 'read', ids.result)).toBeVisible({ timeout: 20_000 })

  // 1. The chips count the groups; Working is folded until its chip is clicked.
  await expect(chip(page, 'all')).toBeVisible()
  await expect(chip(page, 'read')).toContainText('To read')
  await expect(chip(page, 'known')).toHaveCount(0)
  await expect(group(page, 'working')).toHaveAttribute('data-open', 'false')
  await chip(page, 'working').click()
  await expect(group(page, 'working')).toHaveAttribute('data-open', 'true')
  await expect(chip(page, 'working')).toHaveAttribute('aria-pressed', 'true')
  await expect(card(page, 'working', ids.work)).toBeVisible()
  await shot(page, '1-working-open')

  // 2. Its task still runs: Acknowledge moves it to Known, open, saying what it waits on.
  await card(page, 'working', ids.work).getByTestId('org-thread-ack').click()
  const known = card(page, 'known', ids.work)
  await expect(known).toBeVisible({ timeout: 15_000 })
  await expect(group(page, 'known')).toHaveAttribute('data-open', 'true')
  await expect(group(page, 'known').getByTestId('org-thread-group-head')).toContainText('Known')
  await expect(chip(page, 'known')).toContainText('Known 1')
  await expect(known).toHaveAttribute('data-state', 'known')
  await expect(known.getByTestId('org-thread-state')).toHaveText('Known')
  await expect(known.getByTestId('org-thread-time')).toContainText('You acknowledged')
  const wait = known.getByTestId('org-thread-known-wait')
  await expect(wait).toHaveAttribute('data-task-id', ids.running)
  await expect(wait).toContainText(`Waiting on Fix the oven timer ${STAMP} to finish:`)
  await expect(known.getByTestId('org-thread-known-what')).toHaveText('Swap the timer board and check it counts down to the second.')
  await expect(known.getByTestId('org-thread-known-ends')).toHaveText('When it ends: it comes back to To read only if there is something new for you; otherwise it closes. Your phone does not buzz.')
  // Acknowledged already: Close in its place.
  await expect(known.getByTestId('org-thread-ack')).toHaveCount(0)
  await expect(known.getByTestId('org-thread-close-known')).toBeVisible()
  await expect(group(page, 'working').locator(`[data-thread-id="${ids.work}"]`)).toHaveCount(0)
  const kept = await threadOf(request, ids.work)
  expect(kept?.state).toBe('pending')
  expect(kept?.closed).toBeUndefined()
  expect(kept?.ackedAt).toBeTruthy()
  await chip(page, 'known').click()
  await expect(chip(page, 'known')).toHaveAttribute('aria-pressed', 'true')
  await shot(page, '2-known')

  // 3. The result is on the card, its task still open: Acknowledge closes it.
  await card(page, 'read', ids.result).getByTestId('org-thread-ack').click()
  await expect(page.locator(`[data-testid="org-thread"][data-thread-id="${ids.result}"]:not([data-state="closed"])`)).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(async () => (await threadOf(request, ids.result))?.closed).toMatchObject({ how: 'acked', by: 'human' })
  expect((await threadOf(request, ids.result))?.ackedAt).toBeUndefined()
  await expect(group(page, 'done').getByTestId('org-thread-group-count')).not.toHaveText('0')
  // The Known one is still there.
  await expect(card(page, 'known', ids.work)).toBeVisible()
  await shot(page, '3-result-closed')
  expect(pageErrors).toEqual([])
})

test('with the Brief on, the Known thread has its own section, open', async ({ page, request }) => {
  await flags(request, { brief_off: false })
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await openLead(page)
  const toggle = page.getByTestId('org-threads-known')
  await expect(toggle).toHaveText(/1 known/, { timeout: 20_000 })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const known = page.locator(`ul[data-show="known"] [data-testid="org-thread"][data-thread-id="${ids.work}"]`)
  await expect(known).toBeVisible()
  await expect(known.getByTestId('org-thread-known-wait')).toContainText(`Fix the oven timer ${STAMP}`)
  await expect(page.locator(`ul[data-show="hidden"] [data-thread-id="${ids.work}"]`)).toHaveCount(0)
  await shot(page, '4-brief-on-known')
  // Close: it ends now, closed by him.
  await known.getByTestId('org-thread-close-known').click()
  await expect(page.locator(`ul[data-show="known"] [data-thread-id="${ids.work}"]`)).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(async () => (await threadOf(request, ids.work))?.closed).toMatchObject({ how: 'acked', by: 'human' })
  expect(pageErrors).toEqual([])
})
