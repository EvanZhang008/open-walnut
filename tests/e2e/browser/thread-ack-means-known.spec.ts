/**
 * His Acknowledge sends a card to Acknowledged while the AI decides where it goes (experiment
 * ack_means_known, src/core/org/thread-known.ts, src/core/org/thread-ack.ts,
 * web/src/components/org/OrgThreads.tsx; 2026-11-20, the user: "if I ack and ai should determine if
 * it should go to closed or wait or wip", "keep Acknowledged, simpler").
 *
 * With the Brief off (his Threads in their groups, experiment brief_off):
 *  1. The chips are All and the seven groups, each counted; a click on Working shows only Working.
 *  2. Acknowledge on a lead's thread whose task still works: the card goes to Acknowledged at once,
 *     reading Acknowledged and "AI is deciding where this goes."; no Acknowledge on it any more.
 *  3. The lead's AI places it (thread_update place, place_why): the card moves to Waiting / Snoozed,
 *     saying "Moved to Waiting: <why>" over what it waits on (the task chip, what it is to finish).
 *  4. Acknowledge on a result card: Acknowledged too; the AI closes it, and the Closed card says why.
 *  (Walnut placing it itself after 10 minutes runs on a fake clock: tests/e2e/thread-ack-means-known.test.ts.)
 * With the Brief on (the list as before): the placed thread is in the quiet "in progress" list.
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

interface Thread { id: string; state: string; ackedAt?: string; ackPlaced?: { to: string; by: string; why?: string }; closed?: { how: string; by: string } }

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
  // Another subject (no stamp in its title, so it shares no word with the result's card).
  ids.other = await createTask(request, 'Paint the shop sign')
  // A project with two or more open teams gets a lead (org_contact).
  ids.lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  await post(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: ids.lead })
  await expect.poll(async () => (ids.leadSid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  await flags(request, { ack_means_known: true, brief_off: true })
  ids.work = await leadThread(request, `Oven timer ${STAMP}`, ids.running, 'working')
  ids.result = await leadThread(request, `Oven test results ${STAMP}`, ids.other, 'answered')
})

test.afterAll(async ({ request }) => {
  await flags(request, { ack_means_known: false, brief_off: false })
  for (const id of made) await removeTask(request, id)
})

/** The lead's own thread_update on `id`: what its AI decides. */
async function leadPlaces(request: APIRequestContext, id: string, place: 'closed' | 'waiting' | 'working', why: string): Promise<void> {
  const res = await request.patch(`/api/v1/tasks/${ids.lead}/threads/${id}`, { data: { place, place_why: why }, headers: { 'x-walnut-caller-sid': ids.leadSid } })
  expect(res.ok(), await res.text()).toBe(true)
}

test('Acknowledge: the card waits in Acknowledged while the AI decides, then shows where it went and why', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await openLead(page)
  await expect(page.getByTestId('org-thread-groups')).toBeVisible({ timeout: 20_000 })
  await expect(card(page, 'read', ids.result)).toBeVisible({ timeout: 20_000 })

  // 1. All and the seven groups; a click on Working shows only Working.
  await expect(page.getByTestId('org-threads-chip')).toHaveText([/^All \d+$/, /^Needs you \d+$/, /^Done \d+$/, /^Working \d+$/, /^Waiting \/ Snoozed \d+$/, /^Acknowledged \d+$/, /^Closed \d+$/, /^Archived \d+$/])
  await expect(chip(page, 'read')).toContainText('Done 1')
  await expect(chip(page, 'known')).toContainText('Acknowledged 0')
  await chip(page, 'working').click()
  await expect(chip(page, 'working')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('section[data-testid="org-thread-group"]')).toHaveCount(1)
  await expect(card(page, 'working', ids.work)).toBeVisible()
  await expect(page.locator(`[data-testid="org-thread"][data-thread-id="${ids.result}"]`)).toHaveCount(0)
  await shot(page, '1-working')

  // 2. Acknowledge: at once in Acknowledged, the AI deciding.
  await card(page, 'working', ids.work).getByTestId('org-thread-ack').click()
  await chip(page, 'all').click()
  const deciding = card(page, 'known', ids.work)
  await expect(deciding).toBeVisible({ timeout: 15_000 })
  await expect(chip(page, 'known')).toContainText('Acknowledged 1')
  await expect(deciding.getByTestId('org-thread-state')).toHaveText('Acknowledged')
  await expect(deciding.getByTestId('org-thread-ack-line')).toHaveText('AI is deciding where this goes.')
  await expect(deciding.getByTestId('org-thread-time')).toContainText('You acknowledged')
  await expect(deciding.getByTestId('org-thread-known')).toHaveCount(0)
  // Acknowledged already: no second button.
  await expect(deciding.getByTestId('org-thread-ack')).toHaveCount(0)
  const kept = await threadOf(request, ids.work)
  expect(kept?.state).toBe('pending')
  expect(kept?.closed).toBeUndefined()
  expect(kept?.ackedAt).toBeTruthy()
  expect(kept?.ackPlaced).toBeUndefined()
  await shot(page, '2-acknowledged')

  // 3. The lead's AI decides: Waiting, with what it waits on.
  await leadPlaces(request, ids.work, 'waiting', 'waits on the new timer board, due Friday')
  const placed = card(page, 'waiting', ids.work)
  await expect(placed).toBeVisible({ timeout: 15_000 })
  await expect(card(page, 'known', ids.work)).toHaveCount(0)
  await expect(placed.getByTestId('org-thread-state')).toHaveText('Waiting / Snoozed')
  await expect(placed.getByTestId('org-thread-ack-line')).toHaveText('Moved to Waiting: waits on the new timer board, due Friday')
  const wait = placed.getByTestId('org-thread-known-wait')
  await expect(wait).toHaveAttribute('data-task-id', ids.running)
  await expect(wait).toContainText(`Waiting on Fix the oven timer ${STAMP}`)
  await expect(placed.getByTestId('org-thread-known-what')).toHaveText('Swap the timer board and check it counts down to the second.')
  await expect(placed.getByTestId('org-thread-ack')).toHaveCount(0)
  await shot(page, '3-placed-waiting')

  // 4. The result card: Acknowledged too; the AI closes it, and the Closed card says why.
  await chip(page, 'read').click()
  await card(page, 'read', ids.result).getByTestId('org-thread-ack').click()
  await chip(page, 'known').click()
  await expect(card(page, 'known', ids.result).getByTestId('org-thread-ack-line')).toHaveText('AI is deciding where this goes.', { timeout: 15_000 })
  await leadPlaces(request, ids.result, 'closed', 'the test results are in and he read them')
  await expect.poll(async () => (await threadOf(request, ids.result))?.closed).toMatchObject({ how: 'acked', by: `task:${ids.lead}` })
  await chip(page, 'done').click()
  const shut = card(page, 'done', ids.result)
  await expect(shut.getByTestId('org-thread-state')).toHaveText('Closed', { timeout: 15_000 })
  await expect(shut.getByTestId('org-thread-ack-line')).toHaveText('Moved to Closed: the test results are in and he read them')
  await shot(page, '4-result-closed')
  await chip(page, 'all').click()
  expect(pageErrors).toEqual([])
})

test('with the Brief on, the placed thread is in the quiet in-progress list, saying what it waits on', async ({ page, request }) => {
  await flags(request, { brief_off: false })
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await openLead(page)
  const toggle = page.getByTestId('org-threads-hidden')
  await expect(toggle).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('org-threads-known')).toHaveCount(0)
  await toggle.click()
  const held = page.locator(`ul[data-show="hidden"] [data-testid="org-thread"][data-thread-id="${ids.work}"]`)
  await expect(held).toBeVisible()
  await expect(held.getByTestId('org-thread-known-wait')).toContainText(`Fix the oven timer ${STAMP}`)
  await shot(page, '4-brief-on-held')
  expect(pageErrors).toEqual([])
})
