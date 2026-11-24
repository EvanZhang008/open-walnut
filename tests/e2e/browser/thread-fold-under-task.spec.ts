/**
 * One subject shows once on his lead's Threads (2026-11-24, the user, on his Walnut VP: "why the
 * fuck there are so many dupciated thread"; src/core/org/thread-task-ask.ts heldResults).
 *
 * His VP's card was his own request with the designs' result on it (Done), beside the card of the
 * task it was handed to, which asked him to pick: both were up on the VP's Threads; he answered on
 * the VP's and the task's kept waiting.
 *
 *  1. While the task asks him, the lead's Threads show the task's card alone for him (it names the
 *     task and carries the choices); the lead's result waits with the in-progress ones and says
 *     which task asks about it.
 *  2. He clicks a choice on the task's card: nothing is left for him, and the lead's result does
 *     not come back; its card says he answered that task on it.
 * The fixture is shared: this file makes its own project and tasks, and puts the flags back.
 * Chinese test data is written with \u escapes (his two titles).
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { restoreOneCard, setOneCard } from './one-card-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Fold ${STAMP}`
const made: string[] = []
let oneCardWas: boolean | null = null
const ids = { lead: '', leadSid: '', owner: '', ownerSid: '', his: '', ask: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`
const HIS_REQUEST = `\u65b0\u4efb\u52a1\u9762\u677f\u592a\u5c0f\uff0c\u8981 10 \u4e2a\u8bbe\u8ba1\u9009 ${STAMP}`
const TASK_ASKS = `\u65b0\u5efa\u4efb\u52a1\u9762\u677f\uff1a10 \u4e2a\u65b9\u6848\uff0c\u8bf7\u6311\u4e00\u4e2a ${STAMP}`
const KIND = { user_kind: 'user_own', user_kind_why: 'A look of his own screen that only he picks' }

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ video: 'on', viewport: { width: 1280, height: 800 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function send<T>(request: APIRequestContext, method: 'post' | 'patch', url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request[method](url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
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

async function startSession(request: APIRequestContext, taskId: string, fixtureRoot: string): Promise<string> {
  await send(request, 'post', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId })
  let sid = ''
  await expect.poll(async () => (sid = (await (await request.get(`/api/tasks/${taskId}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  return sid
}

async function openLead(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(PROJECT))
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
}

const card = (page: Page, id: string) => page.getByTestId('org-rail').locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/thread-fold-under-task-${name}-${test.info().project.name}.png` })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(170_000)
  oneCardWas = await setOneCard(request, true)
  await flag(request, true)
  // A project with two or more teams gets a lead (org_contact).
  for (const title of [`Side work ${STAMP}`, `More work ${STAMP}`]) {
    made.push((await send<{ task: { id: string } }>(request, 'post', '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  ids.lead = (await send<{ task: { id: string } }>(request, 'post', '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  ids.owner = (await send<{ task: { id: string } }>(request, 'post', '/api/tasks', { title: `Panel designs ${STAMP}`, project: PROJECT, source: 'local', parent_task_id: ids.lead })).task.id
  made.push(ids.owner)
  const on = await request.patch(`/api/tasks/${ids.owner}`, { data: { threads_on: true } })
  expect(on.ok(), await on.text()).toBe(true)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  ids.leadSid = await startSession(request, ids.lead, fixtureRoot)
  ids.ownerSid = await startSession(request, ids.owner, fixtureRoot)
  const PICKS = [{ id: 'a', label: 'Design 9 (recommended)', recommended: true }, { id: 'b', label: 'Design 3' }]
  // His own request to the lead, handed to the task.
  ids.his = (await send<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.lead}/threads/open`, {
    title: HIS_REQUEST, text: 'The designs are being made by the task.', state: 'answered', from: 'node', tasks: [ids.owner],
  }, ids.leadSid)).thread.id
  // The task's own card asks him to pick one of the designs.
  ids.ask = (await send<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.owner}/threads/open`, {
    title: TASK_ASKS, text: 'Ten designs, one page.', state: 'needs', from: 'node',
    reply: 'Pick one of the ten designs; I recommend 9, the widest at your window size.',
    options: PICKS, design_review: 'sol: function 8/10, experience 8/10, interface 8/10; nothing to change',
    separate_reason: 'The task asks its own pick of the designs it made', ...KIND,
  }, ids.ownerSid)).thread.id
  // The lead hears of the task's ask and writes the result on his request: a result, beside the task's ask.
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${ids.his}`, {
    reply: 'Ten designs are on one page, made at your window size: /tmp/panel/ten.html', state: 'answered',
  }, ids.leadSid)
})

test.afterAll(async ({ request }) => {
  await restoreOneCard(request, oneCardWas)
  await flag(request, false)
  for (const id of made) await removeTask(request, id)
})

test('one subject, one card: the task\'s ask holds the lead\'s result, and his answer there never brings it back', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  const rail = page.getByTestId('org-rail')
  const forHim = rail.locator('[data-testid="org-thread"][data-group="needs"], [data-testid="org-thread"][data-group="read"]')

  // 1. The task's card, naming the task and carrying the choices, is the one card for him.
  const ask = card(page, ids.ask)
  await expect(ask).toBeVisible({ timeout: 20_000 })
  await expect(ask).toHaveAttribute('data-owner', ids.owner)
  await expect(ask).toContainText('Design 9 (recommended)')
  await expect(forHim).toHaveCount(1)
  // The lead's result waits with the in-progress ones and says which task asks about it.
  await rail.getByTestId('org-threads-hidden').click()
  const own = card(page, ids.his)
  await expect(own).toBeVisible()
  await expect(own).toHaveAttribute('data-asked-in', ids.owner)
  await expect(own.getByTestId('org-thread-asked-in')).toContainText('asks you about this now: answer on its card')
  await page.waitForTimeout(1_500)
  await shot(page, '1-one-card')

  // 2. He clicks a choice on the task's card: nothing is left for him, and the result stays behind it.
  await ask.getByRole('button', { name: /Design 9 \(recommended\)/ }).click()
  await expect(forHim).toHaveCount(0, { timeout: 20_000 })
  await expect(own.getByTestId('org-thread-asked-in')).toHaveAttribute('data-answered', 'true', { timeout: 20_000 })
  await expect(own.getByTestId('org-thread-asked-in')).toContainText('You answered')
  // It holds: nothing has come back for him a few seconds later.
  await page.waitForTimeout(3_000)
  await expect(forHim).toHaveCount(0)
  await shot(page, '2-answered')
  await page.waitForTimeout(1_500)
  expect(pageErrors).toEqual([])
})
