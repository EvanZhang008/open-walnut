/**
 * The Brief off: a lead's Org page shows its Threads grouped by state where the Brief was, and a
 * choice its Board asks waits there as a thread with the choice's buttons (experiment brief_off,
 * src/core/org/brief-off.ts, src/core/boards/choice-threads.ts, web/src/components/org/
 * OrgThreadsByState.tsx, ThreadChoiceAnswer.tsx).
 *
 *  1. The lead's side bar has Threads and Tasks, no Brief tab.
 *  2. Threads read grouped by state: Needs you (open) holds the Board choice's card with its two
 *     options, the recommended one marked; To read (open) holds the lead's answered thread; Working
 *     (folded) holds the one it took on and opens on a click.
 *  3. He clicks an option: the card leaves Needs you, the Board reads the choice answered, and
 *     the thread is under Done.
 * The fixture is shared: this file makes its own project and tasks, and puts the flag back.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Briefless ${STAMP}`
const CHOICE_TITLE = `Plant the beds this week or next? ${STAMP}`
const WORKING_TITLE = `Order the mulch ${STAMP}`
const READ_TITLE = `The hose is fixed ${STAMP}`
const made: string[] = []
const ids = { lead: '', leadSid: '', worker: '', choiceThread: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ video: 'on', viewport: { width: 1280, height: 800 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function send<T>(request: APIRequestContext, method: 'post' | 'put' | 'patch', url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request[method](url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function flag(request: APIRequestContext, on: boolean): Promise<void> {
  const res = await request.put('/api/config', { data: { experimental: { brief_off: on } } })
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

const group = (page: Page, g: string) => page.locator(`[data-testid="org-thread-group"][data-group="${g}"]`)

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/brief-off-${name}-${test.info().project.name}.png` })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  // A project with two or more teams gets a lead (org_contact).
  for (const title of [`Dig the beds ${STAMP}`, `Fix the hose ${STAMP}`]) {
    made.push((await send<{ task: { id: string } }>(request, 'post', '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  ids.worker = made[0]
  ids.lead = (await send<{ task: { id: string } }>(request, 'post', '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  await send(request, 'post', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: ids.lead })
  await expect.poll(async () => (ids.leadSid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  await flag(request, true)
  // The lead keeps a thread of its own in progress, and its Board asks him a choice about a worker.
  // A node opens a thread only as something for him; it then takes the work on (working). Another stays to read.
  const opened = await send<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.lead}/threads/open`, { title: WORKING_TITLE, text: 'Two bags of bark mulch for the new beds.', from: 'node', state: 'answered' }, ids.leadSid)
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${opened.thread.id}`, { state: 'working' }, ids.leadSid)
  await send(request, 'post', `/api/v1/tasks/${ids.lead}/threads/open`, { title: READ_TITLE, text: 'The hose is fixed; the leak was at the tap.', from: 'node', state: 'answered' }, ids.leadSid)
  await send(request, 'put', `/api/v1/tasks/${ids.lead}/board`, {
    html: `<html><body><h1>Garden</h1><walnut-choice id="plant-when" title="${CHOICE_TITLE}" options="now:This week,later:Next week" recommended="later" task="${ids.worker}"></walnut-choice></body></html>`,
  })
  await expect.poll(async () => {
    const file = await (await request.get(`/api/v1/tasks/${ids.lead}/threads`)).json() as { threads: Array<{ id: string; choice?: { id: string } }> }
    return (ids.choiceThread = file.threads.find((t) => t.choice?.id === 'plant-when')?.id ?? '')
  }, { timeout: 30_000 }).not.toBe('')
})

test.afterAll(async ({ request }) => {
  await flag(request, false)
  for (const id of made) await removeTask(request, id)
})

test('a lead\'s Org page: no Brief tab, its Threads by state, and the Board\'s choice answered on its thread', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)

  // 1. Threads and Tasks, no Brief.
  await expect(page.getByTestId('org-top-threads')).toBeVisible()
  await expect(page.getByTestId('org-top-task')).toBeVisible()
  await expect(page.getByTestId('org-top-brief')).toHaveCount(0)

  // 2. Grouped by state: Needs you open with the choice's card, Working folded.
  await expect(page.getByTestId('org-thread-groups')).toBeVisible({ timeout: 20_000 })
  const needs = group(page, 'needs')
  await expect(needs).toHaveAttribute('data-open', 'true')
  await expect(needs.getByTestId('org-thread-group-head')).toContainText('Needs you')
  const card = needs.locator(`[data-testid="org-thread"][data-thread-id="${ids.choiceThread}"]`)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card.getByTestId('org-thread-title')).toHaveText(CHOICE_TITLE)
  const answer = card.getByTestId('org-thread-choice')
  await expect(answer).toHaveAttribute('data-choice-id', 'plant-when')
  // The choice's own two options, the recommended one marked.
  await expect(answer.getByTestId('org-answer-option')).toHaveCount(2, { timeout: 15_000 })
  await expect(answer.locator('[data-testid="org-answer-option"][data-value="later"]')).toHaveText('Next week')
  await expect(answer.locator('[data-testid="org-answer-option"][data-value="later"]')).toHaveClass(/btn-primary/)
  await expect(answer.locator('[data-testid="org-answer-option"][data-value="now"]')).toHaveText('This week')
  await expect(card.getByTestId('org-thread-ack')).toHaveCount(0)
  // To read, open: the lead's answered thread.
  const read = group(page, 'read')
  await expect(read).toHaveAttribute('data-open', 'true')
  await expect(read.getByTestId('org-thread-title')).toHaveText(READ_TITLE)
  const working = group(page, 'working')
  await expect(working).toHaveAttribute('data-open', 'false')
  await expect(working.getByTestId('org-thread-group-count')).toHaveText('1')
  await working.getByTestId('org-thread-group-head').click()
  await expect(working.getByTestId('org-thread-title')).toHaveText(WORKING_TITLE)
  await shot(page, '1-groups')

  // 3. He picks one: the Board's choice is answered and the thread is Done.
  await answer.locator('[data-testid="org-answer-option"][data-value="later"]').click()
  await expect(needs.locator(`[data-thread-id="${ids.choiceThread}"]`)).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(async () => ((await (await request.get(`/api/v1/tasks/${ids.lead}/board`)).json()) as { choices?: Record<string, { option: string }> }).choices?.['plant-when']?.option ?? '', { timeout: 15_000 }).toBe('later')
  const done = group(page, 'done')
  await expect(done.getByTestId('org-thread-group-count')).toHaveText('1', { timeout: 15_000 })
  await done.getByTestId('org-thread-group-head').click()
  await expect(done.locator(`[data-thread-id="${ids.choiceThread}"]`)).toBeVisible()
  await shot(page, '2-answered')
  expect(pageErrors).toEqual([])
})
