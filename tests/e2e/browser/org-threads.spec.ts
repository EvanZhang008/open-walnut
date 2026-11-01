/**
 * Threads beside Task and Brief on an Org node (web/src/components/org/OrgThreads.tsx): the user's
 * own requests to a lead, one thread per subject (2026-11-01, the user: "every user request becomes
 * a thread ... I can acknowledge, or do follow up actions"; "if my multiple ask is about the same
 * thread, add it below that thread").
 *
 * The lead's writes go through the route its thread_update op calls, as its session would
 * (x-walnut-caller-sid). Scenario matrix:
 *  1. a request the user types to the lead (the composer under the Team view) shows as a new thread
 *     at once; the lead titles it, sets it working with a reply and a task: the card shows each, the
 *     task's live status dot; a second ask about the same subject is merged by the lead and the card
 *     says 2 messages, its messages in order; Split out undoes a wrong merge;
 *  2. Follow up sends a message filed under that thread (stored as a follow-up), the card counts it;
 *     Acknowledge moves it to Closed (who and when stored), Reopen brings it back; a reload opens on
 *     Task and the same threads come back;
 *  3. a long Unicode request reads in full when opened; an Acknowledge the server refuses puts the
 *     card back and says it did not save.
 * The fixture is shared, so this file makes its own project and removes what it made.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const LED = `Threads led ${STAMP}`
const made: string[] = []
const ids = { lead: '', leadSid: '', work: '', other: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

interface Thread { id: string; title: string; state: string; messages: Array<{ id: string; text: string; via: string }>; closed?: { how: string; by: string } }

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function threads(request: APIRequestContext): Promise<Thread[]> {
  const res = await request.get(`/api/v1/tasks/${ids.lead}/threads`)
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { threads: Thread[] }).threads
}

/** The lead's session keeping a thread current (its thread_update op calls this route). */
async function leadUpdates(request: APIRequestContext, id: string, data: unknown): Promise<void> {
  const res = await request.patch(`/api/v1/tasks/${ids.lead}/threads/${id}`, { data, headers: { 'x-walnut-caller-sid': ids.leadSid } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function createTask(request: APIRequestContext, title: string, project: string): Promise<string> {
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project, source: 'local' })
  made.push(task.id)
  return task.id
}

async function removeTask(request: APIRequestContext, id: string): Promise<void> {
  const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
  if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
  for (let i = 0; i < 10; i++) {
    const res = await request.delete(`/api/tasks/${id}`)
    if (res.ok() || res.status() === 404) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function openThreads(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(LED)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(LED))
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'task')
  await detail.getByTestId('org-top-threads').click()
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
}

/** The user types a request to the lead: the composer under the Team view (a real send). */
async function sendToLead(page: Page, text: string): Promise<void> {
  const detail = page.getByTestId('org-detail')
  await detail.getByTestId('org-tab-team').click()
  const composer = detail.getByTestId('org-composer').locator('textarea')
  await composer.fill(text)
  await composer.press('Enter')
  // A send moves the node to its chat; the rail (and its Threads view) stays beside it.
  await expect(detail.getByTestId('org-tab-chat')).toHaveAttribute('aria-selected', 'true')
}

const card = (page: Page, id: string) => page.locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/org-threads-${name}-${test.info().project.name}.png` })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const cwd = `${fixtureRoot}/projects/walnut`
  ids.work = await createTask(request, `Build Threads ${STAMP}`, LED)
  ids.other = await createTask(request, `Other ${STAMP}`, LED)
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: LED })
  ids.lead = contact.task.id
  made.push(ids.lead)
  await post(request, '/api/sessions/quick-start', { cwd, message: 'snapshot-clean-turn:Started.', taskId: ids.lead })
  await expect.poll(async () => (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? '', { timeout: 90_000 }).not.toBe('')
  ids.leadSid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task.session_id
})

test.afterAll(async ({ request }) => {
  for (const id of made) await removeTask(request, id)
})

test('a request becomes a thread the lead keeps; asks about one subject are one thread, and a wrong merge splits out', async ({ page, request }) => {
  await openThreads(page)
  const detail = page.getByTestId('org-detail')
  const before = (await threads(request)).length
  const first = `The Org page is a mess: add a Threads view ${STAMP}`
  await sendToLead(page, first)
  await expect.poll(async () => (await threads(request)).length, { timeout: 30_000 }).toBe(before + 1)
  const t1 = (await threads(request)).find((t) => t.messages[0].text === first)!
  // Shown at once, in Walnut's words until the lead titles it.
  await expect(card(page, t1.id)).toHaveAttribute('data-state', 'new')
  await expect(card(page, t1.id).getByTestId('org-thread-title')).toHaveText(first)

  await leadUpdates(request, t1.id, { title: `Org: Threads view ${STAMP}`, ask: 'One thread per request, with Acknowledge', state: 'working', reply: 'Handed to **Build Threads**', add_tasks: [ids.work] })
  const c1 = card(page, t1.id)
  await expect(c1.getByTestId('org-thread-title')).toHaveText(`Org: Threads view ${STAMP}`)
  await expect(c1).toHaveAttribute('data-state', 'working')
  await expect(c1.getByTestId('org-thread-state')).toHaveText('Working')
  await expect(c1.getByTestId('org-thread-ask')).toHaveText('One thread per request, with Acknowledge')
  await expect(c1.getByTestId('org-thread-reply').locator('strong')).toHaveText('Build Threads')
  await expect(c1.locator(`[data-testid="org-thread-task"][data-task-id="${ids.work}"]`)).toContainText(`Build Threads ${STAMP}`)
  await expect(c1.locator(`[data-testid="org-thread-task"][data-task-id="${ids.work}"] i`)).toHaveCount(1)

  // A second ask about the same thing: its own card first, then the lead puts it under the first.
  const second = `and group my asks about one subject ${STAMP}`
  await sendToLead(page, second)
  await expect.poll(async () => (await threads(request)).length, { timeout: 30_000 }).toBe(before + 2)
  const t2 = (await threads(request)).find((t) => t.messages[0].text === second)!
  await expect(card(page, t2.id)).toBeVisible()
  await leadUpdates(request, t2.id, { merge_into: t1.id })
  await expect(card(page, t2.id)).toHaveCount(0)
  await expect(c1.getByTestId('org-thread-count')).toHaveText(/^2 messages/)
  await c1.getByTestId('org-thread-head').click()
  await expect(c1.getByTestId('org-thread-message')).toHaveCount(2)
  await expect(c1.getByTestId('org-thread-message').nth(0)).toContainText(first)
  await expect(c1.getByTestId('org-thread-message').nth(1)).toContainText(second)
  await shot(page, 'merged')

  // The user splits it out again: its own thread, the first keeps one message.
  await c1.getByTestId('org-thread-message').nth(1).getByTestId('org-thread-split').click()
  await expect.poll(async () => (await threads(request)).length, { timeout: 15_000 }).toBe(before + 2)
  await expect(c1.getByTestId('org-thread-message')).toHaveCount(1)
  const split = (await threads(request)).find((t) => t.messages[0].text === second)!
  await expect(card(page, split.id).getByTestId('org-thread-title')).toHaveText(second)
  // The lead merges it back (same subject after all).
  await leadUpdates(request, split.id, { merge_into: t1.id })
  await expect(card(page, split.id)).toHaveCount(0)
  await expect(c1.getByTestId('org-thread-message')).toHaveCount(2)
})

test('Follow up files under the thread; Acknowledge closes it, Reopen brings it back; a reload keeps them', async ({ page, request }) => {
  await openThreads(page)
  const t1 = (await threads(request)).find((t) => t.title === `Org: Threads view ${STAMP}`)!
  const c1 = card(page, t1.id)
  await expect(c1).toBeVisible()
  await c1.getByTestId('org-thread-follow-open').click()
  const follow = `also show pictures in the thread ${STAMP}`
  await c1.getByTestId('org-thread-follow-input').fill(follow)
  await shot(page, 'follow-up')
  await c1.getByTestId('org-thread-follow-send').click()
  await expect(c1.getByTestId('org-thread-follow')).toHaveCount(0)
  await expect(c1.getByTestId('org-thread-count')).toHaveText(/^3 messages/, { timeout: 30_000 })
  const stored = (await threads(request)).find((t) => t.id === t1.id)!
  expect(stored.messages.map((m) => m.via)).toEqual(['chat', 'chat', 'follow-up'])
  expect(stored.messages[2].text).toBe(follow)
  // It reached the lead's chat too.
  await expect(page.getByTestId('org-detail').locator('[data-testid="org-chat"]').getByText(follow).first()).toBeVisible({ timeout: 60_000 })

  await c1.getByTestId('org-thread-ack').click()
  await expect(c1).toHaveCount(0)
  await expect.poll(async () => (await threads(request)).find((t) => t.id === t1.id)?.closed?.by, { timeout: 15_000 }).toBe('human')
  await page.getByTestId('org-threads-closed').click()
  await expect(c1.getByTestId('org-thread-closed')).toHaveText(/^Acknowledged /)
  await shot(page, 'closed')
  await c1.getByTestId('org-thread-reopen').click()
  await expect(c1).toHaveCount(0)
  await page.getByTestId('org-threads-open').click()
  await expect(c1).toBeVisible()
  await expect.poll(async () => (await threads(request)).find((t) => t.id === t1.id)?.closed, { timeout: 15_000 }).toBeUndefined()

  // A reload opens the node on Task; Threads shows the same threads.
  await page.reload()
  const detail = page.getByTestId('org-detail')
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'task', { timeout: 30_000 })
  await detail.getByTestId('org-top-threads').click()
  await expect(card(page, t1.id).getByTestId('org-thread-count')).toHaveText(/^3 messages/)
})

test('a long Unicode request reads in full; an Acknowledge the server refuses puts the card back', async ({ page, request }) => {
  const long = [`微信的 org 非常乱 ${STAMP}`, ...Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: ${'detail '.repeat(30)}`)].join('\n\n')
  const { thread } = await post<{ thread: Thread }>(request, `/api/v1/tasks/${ids.lead}/threads`, { text: long })
  await openThreads(page)
  const c = card(page, thread.id)
  await expect(c.getByTestId('org-thread-title')).toHaveText(`微信的 org 非常乱 ${STAMP}`)
  await c.getByTestId('org-thread-head').click()
  await expect(c.getByTestId('org-thread-message')).toContainText('Paragraph 12:')
  // No horizontal overflow from the long words.
  const overflow = await page.getByTestId('org-threads').evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  await shot(page, 'long')

  await page.route(`**/api/v1/tasks/${ids.lead}/threads/${thread.id}`, (route) => (
    route.request().method() === 'PATCH' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal","message":"disk full"}' }) : route.continue()
  ))
  await c.getByTestId('org-thread-ack').click()
  await expect(page.getByTestId('org-threads-error')).toContainText('did not save')
  await expect(c).toBeVisible()
  expect((await threads(request)).find((t) => t.id === thread.id)?.closed).toBeUndefined()
  await page.unroute(`**/api/v1/tasks/${ids.lead}/threads/${thread.id}`)
  // And the next try works.
  await c.getByTestId('org-thread-ack').click()
  await expect(c).toHaveCount(0)
  // The card leaves at once; the write lands a moment later.
  await expect.poll(async () => (await threads(request)).find((t) => t.id === thread.id)?.closed?.how, { timeout: 15_000 }).toBe('acked')
  await expect(page.getByTestId('org-threads-error')).toHaveCount(0)
})
