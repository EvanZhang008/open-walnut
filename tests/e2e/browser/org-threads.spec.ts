/**
 * Threads beside Task and Brief on an Org node (web/src/components/org/OrgThreads.tsx): the user's
 * own requests to a lead, one thread per subject (2026-11-01, the user: "every user request becomes
 * a thread ... I can acknowledge, or do follow up actions"; "if my multiple ask is about the same
 * thread, add it below that thread").
 *
 * The lead's writes go through the route its thread_update op calls, as its session would
 * (x-walnut-caller-sid). A thread reads as its conversation (2026-11-01, the user: "do it like
 * slack thread"); the answers Walnut reads from the node's chat are proven against a real
 * transcript in tests/e2e/org-threads.test.ts and tests/core/org/thread-answers.test.ts, so case 5
 * seeds a node's threads file with answers in the shape of the user's own thread. Scenario matrix:
 *  1. a request the user types to the lead (the composer under the Team view) shows as a new thread
 *     at once, waiting for its answer; the lead titles it, sets it working with a reply and a task:
 *     the card shows each, the task's live status dot; a second ask about the same subject is
 *     merged by the lead and the card says 2 messages, its messages in order; Split out undoes a
 *     wrong merge;
 *  2. Follow up sends a message filed under that thread (stored as a follow-up), the card counts it;
 *     Acknowledge takes it out of the open list into "N closed this week" (who and when stored),
 *     Reopen brings it back; another page and back, and a reload, open on Threads again;
 *  3. a long Unicode request reads in full when opened; an Acknowledge the server refuses puts the
 *     card back and says it did not save;
 *  4. a thread the lead opens itself (thread_create, from mail) shows its post as the lead's, with
 *     where it came from; his Follow up lands under it;
 *  5. five asks with three answers (two pairs answered at once), the last answer long, Markdown,
 *     with its tasks line: the card holds the summary and only the last answer (what it answers
 *     in one line, not yet known, folded with Expand on it, no raw markup, its task as a live
 *     pill), nothing of the two exchanges he wrote after; the Conversation toggle in the body
 *     shows all five with every answer; a real CJK title keeps one line per word.
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

interface Thread { id: string; title: string; state: string; messages: Array<{ id: string; text: string; via: string; answer?: { text: string } }>; closed?: { how: string; by: string } }

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
  const t1 = (await threads(request)).find((t) => t.messages[0]?.text === first)!
  // Shown at once, in Walnut's words until the lead titles it.
  await expect(card(page, t1.id)).toHaveAttribute('data-state', 'new')
  await expect(card(page, t1.id).getByTestId('org-thread-title')).toHaveText(first)
  // Nothing answered yet: his own words are not echoed back on the card; the conversation has them.
  await expect(card(page, t1.id)).not.toContainText('Not answered yet')
  await expect(card(page, t1.id).getByTestId('org-thread-count')).toHaveText(/^1 message/)

  await leadUpdates(request, t1.id, { title: `Org: Threads view ${STAMP}`, ask: 'One thread per request, with Acknowledge', state: 'working', reply: 'Handed to **Build Threads**', add_tasks: [ids.work] })
  const c1 = card(page, t1.id)
  await expect(c1.getByTestId('org-thread-title')).toHaveText(`Org: Threads view ${STAMP}`)
  await expect(c1).toHaveAttribute('data-state', 'working')
  await expect(c1.getByTestId('org-thread-state')).toHaveText('Working')
  await expect(c1.getByTestId('org-thread-reply').locator('strong')).toHaveText('Build Threads')
  await expect(c1.locator(`[data-testid="org-thread-task"][data-task-id="${ids.work}"]`)).toContainText(`Build Threads ${STAMP}`)
  await expect(c1.locator(`[data-testid="org-thread-task"][data-task-id="${ids.work}"] i`)).toHaveCount(1)

  // A second ask about the same thing: its own card first, then the lead puts it under the first.
  const second = `and group my asks about one subject ${STAMP}`
  await sendToLead(page, second)
  await expect.poll(async () => (await threads(request)).length, { timeout: 30_000 }).toBe(before + 2)
  const t2 = (await threads(request)).find((t) => t.messages[0]?.text === second)!
  await expect(card(page, t2.id)).toBeVisible()
  await leadUpdates(request, t2.id, { merge_into: t1.id })
  await expect(card(page, t2.id)).toHaveCount(0)
  await expect(c1.getByTestId('org-thread-count')).toHaveText(/^2 messages/)
  // The whole conversation opens from the toggle in the card body.
  await c1.getByTestId('org-thread-history').click()
  await expect(c1.getByTestId('org-thread-history')).toHaveAttribute('aria-expanded', 'true')
  await expect(c1.getByTestId('org-thread-message')).toHaveCount(2)
  await expect(c1.getByTestId('org-thread-message').nth(0)).toContainText(first)
  await expect(c1.getByTestId('org-thread-message').nth(1)).toContainText(second)
  await shot(page, 'merged')

  // The user splits it out again: its own thread, the first keeps one message.
  await c1.getByTestId('org-thread-message').nth(1).getByTestId('org-thread-split').click()
  await expect.poll(async () => (await threads(request)).length, { timeout: 15_000 }).toBe(before + 2)
  await expect(c1.getByTestId('org-thread-message')).toHaveCount(1)
  const split = (await threads(request)).find((t) => t.messages[0]?.text === second)!
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
  // Out of the open list at once; the closed ones of the week wait behind one quiet line.
  await expect(c1).toHaveCount(0)
  await expect.poll(async () => (await threads(request)).find((t) => t.id === t1.id)?.closed?.by, { timeout: 15_000 }).toBe('human')
  await expect(page.getByTestId('org-threads-closed')).toHaveText(/^\d+ closed this week/)
  await page.getByTestId('org-threads-closed').click()
  await expect(c1.getByTestId('org-thread-closed')).toHaveText(/^Acknowledged /)
  await shot(page, 'closed')
  await c1.getByTestId('org-thread-reopen').click()
  await expect(c1).toBeVisible()
  await expect(c1).not.toHaveAttribute('data-state', 'closed')
  await expect(page.getByTestId('org-thread-list').locator(`[data-thread-id="${t1.id}"]`)).toBeVisible()
  await expect.poll(async () => (await threads(request)).find((t) => t.id === t1.id)?.closed, { timeout: 15_000 }).toBeUndefined()

  // Threads stays open: another page and back, then a reload (2026-11-01, the user: "If I was in
  // Threads it puts me back in Task").
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByTestId('org-page')).toHaveCount(0)
  await page.getByTestId('sidebar-org').click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(LED), { timeout: 30_000 })
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads', { timeout: 30_000 })
  await page.reload()
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads', { timeout: 30_000 })
  await expect(card(page, t1.id).getByTestId('org-thread-count')).toHaveText(/^3 messages/)
})

test('a long Unicode request reads in full; an Acknowledge the server refuses puts the card back', async ({ page, request }) => {
  const long = [`微信的 org 非常乱 ${STAMP}`, ...Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: ${'detail '.repeat(30)}`)].join('\n\n')
  const { thread } = await post<{ thread: Thread }>(request, `/api/v1/tasks/${ids.lead}/threads`, { text: long })
  await openThreads(page)
  const c = card(page, thread.id)
  await expect(c.getByTestId('org-thread-title')).toHaveText(`微信的 org 非常乱 ${STAMP}`)
  // Not answered yet: nothing of it on the card but its title; the conversation holds it, folded to a few lines.
  await expect(c).not.toContainText('Paragraph 1:')
  await c.getByTestId('org-thread-history').click()
  await c.getByTestId('org-thread-words-more').click()
  await expect(c.getByTestId('org-thread-words-more')).toContainText('Collapse')
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

test('a thread the lead opens itself shows its post as the lead\'s, and his Follow up lands under it', async ({ page, request }) => {
  const res = await request.post(`/api/v1/tasks/${ids.lead}/threads/open`, {
    data: { title: `Mail: the meetup asks about the talk ${STAMP}`, text: 'The organizer wrote: **confirm the slot by Friday?**', from: 'mail', ref: 'Talk slot' },
    headers: { 'x-walnut-caller-sid': ids.leadSid },
  })
  expect(res.status(), await res.text()).toBe(201)
  const opened = ((await res.json()) as { thread: Thread }).thread
  await openThreads(page)
  const c = card(page, opened.id)
  await expect(c.getByTestId('org-thread-from')).toContainText('Opened by')
  await expect(c.getByTestId('org-thread-opener')).toContainText('opened this · Mail: Talk slot')
  await expect(c.getByTestId('org-thread-opener').locator('strong')).toHaveText('confirm the slot by Friday?')
  await c.getByTestId('org-thread-follow-open').click()
  await c.getByTestId('org-thread-follow-input').fill(`yes, confirm it ${STAMP}`)
  await c.getByTestId('org-thread-follow-send').click()
  // He wrote after the post: it leaves the card, his message counts in the conversation and is
  // never echoed back as waiting (only quoted above the lead's answer, if the fixture's chat answers).
  await expect(c.getByTestId('org-thread-count')).toHaveText(/^2 messages/, { timeout: 30_000 })
  await expect(c).not.toContainText('Not answered yet')
  await expect(c.getByTestId('org-thread-opener')).toHaveCount(0)
  await shot(page, 'opened')
  expect((await threads(request)).find((t) => t.id === opened.id)?.messages.map((m) => m.via)).toEqual(['follow-up'])
})

test('a long thread\'s card is its summary and the answer he has not seen; the conversation opens from the card body', async ({ page, request }) => {
  // Its own per browser: two browser projects in one run share STAMP and would share the node.
  const project = `Threads talk ${STAMP} ${test.info().project.name}`
  const work = await createTask(request, `Small model task ${STAMP}`, project)
  // Two tasks: a project of one has no lead of its own yet.
  await createTask(request, `Second task ${STAMP}`, project)
  const node = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: project })).task.id
  made.push(node)
  const { walnutHome } = await discoverBrowserFixture(TEST_PORT)
  const t0 = Date.now() - 10 * 60_000
  const at = (s: number) => new Date(t0 + s * 1000).toISOString()
  const long = [
    'You are right, these are one subject and I split them wrongly. **Where the small model runs**:',
    ...Array.from({ length: 10 }, (_, i) => `- Background job ${i + 1}: titles, summaries and other small work`),
    '',
    `<walnut-about tasks="${work}"/>`,
  ].join('\n')
  const msg = (id: string, s: number, text: string, answer?: [number, string]) => ({ id, at: at(s), text, via: 'chat', ...(answer ? { answer: { at: at(answer[0]), text: answer[1] } } : {}) })
  const file = {
    version: 1, taskId: node, threads: [{
      id: 'th-0297973b5725', title: '\u672c\u5730\u6a21\u578b\uff1a\u5c0f\u6a21\u578b\u7528\u5728\u54ea\u3001\u8c01\u8981\u505a\u7684\u3001\u505c\u6389', titled: true, state: 'answered',
      reply: 'Explained, and every part of it stopped', createdAt: at(0), updatedAt: at(400),
      messages: [
        msg('tm-000000000001', 0, 'what is the small model?', [40, 'The fast model in the local config.']),
        msg('tm-000000000002', 60, 'who asked you to do this?', [180, 'Nobody did. I stopped all of it. <walnut-turn status="agent-ack"/>']),
        msg('tm-000000000003', 80, 'do not do this, why do this?', [180, 'Nobody did. I stopped all of it. <walnut-turn status="agent-ack"/>']),
        msg('tm-000000000004', 220, 'which part of Walnut, the titles?', [300, long]),
        msg('tm-000000000005', 245, 'this is the same thread, why split it?', [300, long]),
      ],
    }],
  }
  const dir = `${walnutHome}/org/threads`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(`${dir}/${node}.json`, JSON.stringify(file))

  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(project)}"]`).click()
  const detail = page.getByTestId('org-detail')
  // The node just picked, not the one shown before it (a click there would land on the old node).
  await expect(detail).toHaveAttribute('data-key', rowKey(project))
  await detail.getByTestId('org-top-threads').click()
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
  const c = card(page, 'th-0297973b5725')
  await expect(c).toBeVisible()
  // The card: the title, the lead's summary and only the answer he has not seen (2026-11-01, the
  // user: "I replied from the first to the ninth, so why still show the first to the eighth?").
  await expect(c.getByTestId('org-thread-reply')).toHaveText('Explained, and every part of it stopped')
  await expect(c.getByTestId('org-thread-earlier')).toHaveCount(0)
  await expect(c.getByTestId('org-thread-message')).toHaveCount(0)
  await expect(c).not.toContainText('what is the small model?')
  await expect(c).not.toContainText('Nobody did.')
  const answer = c.getByTestId('org-thread-answer')
  await expect(answer).toHaveCount(1)
  await expect(answer).toHaveAttribute('data-known', 'false')
  await expect(answer).toHaveClass(/is-news/)
  await expect(answer.getByTestId('org-thread-re')).toContainText('which part of Walnut, the titles? / this is the same thread')
  await expect(answer.locator('strong')).toHaveText('Where the small model runs')
  await expect(answer.getByTestId('msg-about').locator(`a[data-task-id="${work}"]`)).toContainText(`Small model task ${STAMP}`)
  await expect(c).not.toContainText('<walnut-')
  // Its detail folded to a few lines; Expand sits on the answer itself, and a click on the text opens it too.
  const body = answer.getByTestId('org-thread-answer-body')
  const folded = await body.evaluate((el) => el.clientHeight)
  expect(folded).toBeLessThanOrEqual(96)
  await shot(page, 'conversation')
  const toggle = answer.getByTestId('org-thread-answer-body-more')
  await expect(toggle).toContainText('Expand')
  const near = await toggle.evaluate((el) => el.getBoundingClientRect().left - (el.closest('.org-thread-answer')!.getBoundingClientRect().left))
  expect(near).toBeLessThanOrEqual(24)
  await body.click()
  await expect(toggle).toContainText('Collapse')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(await body.evaluate((el) => el.clientHeight)).toBeGreaterThan(folded)
  await expect(body).toContainText('Background job 10')
  await toggle.click()
  await expect(toggle).toContainText('Expand')
  // The whole conversation, from the toggle in the card body: five messages, three answers, the first two known.
  await expect(c.getByTestId('org-thread-count')).toHaveText('5 messages')
  await c.getByTestId('org-thread-history').click()
  await expect(c.getByTestId('org-thread-message')).toHaveCount(5)
  await expect(c.locator('.org-thread-n')).toHaveText(['1', '2', '3', '4', '5'])
  await expect(c.getByTestId('org-thread-answer')).toHaveCount(3)
  await expect(c.getByTestId('org-thread-answer').nth(1)).toContainText('Nobody did.')
  await expect(c.getByTestId('org-thread-answer').nth(1)).toHaveAttribute('data-known', 'true')
  await shot(page, 'conversation-open')
  await c.getByTestId('org-thread-history').click()
  await expect(c.getByTestId('org-thread-message')).toHaveCount(0)
  // The CJK title keeps whole lines, and nothing runs past the card.
  const title = await c.getByTestId('org-thread-title').evaluate((el) => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) }))
  expect(title.h).toBeLessThanOrEqual(title.lh * 1.5)
  expect(await page.getByTestId('org-threads').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
})

test('a thread with nothing new for him is out of sight until there is news; one reply to two threads stays off both cards', async ({ page, request }) => {
  // 2026-11-01, the user: "if it is just assigned no need to tell me, or doing, unless there are
  // some update ... there can be thread pending, which is auto hide like closed".
  const project = `Threads quiet ${STAMP} ${test.info().project.name}`
  const build = await createTask(request, `Build the view ${STAMP}`, project)
  const review = await createTask(request, `Review the view ${STAMP}`, project)
  const node = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: project })).task.id
  made.push(node)
  const { walnutHome } = await discoverBrowserFixture(TEST_PORT)
  const t0 = Date.now() - 30 * 60_000
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString()
  const one = { at: at(12), text: 'Found who pushed it: **the tracker sync**. The source button is in progress too.' }
  const thread = (id: string, title: string, state: string, more: Record<string, unknown>, messages: unknown[]) => ({
    id, title, titled: true, state, createdAt: at(0), updatedAt: at(14), messages, ...more,
  })
  const file = {
    version: 1, taskId: node, threads: [
      thread('th-0000000000a1', 'Handed off only', 'pending', { reply: 'Handed to the build task', tasks: [build] },
        [{ id: 'tm-0000000000a1', at: at(1), text: 'build the Threads view', via: 'chat', answer: { at: at(2), text: 'Handed it to the build task.' } }]),
      thread('th-0000000000a2', 'Summary names its task', 'working', { reply: `${build} is building it; review comes after.`, tasks: [build, review] },
        [{ id: 'tm-0000000000a2', at: at(3), text: 'and who reviews it?', via: 'chat' }]),
      thread('th-0000000000a3', 'Who pushed it to the tracker', 'answered', { reply: 'The tracker sync pushed it' },
        [{ id: 'tm-0000000000a3', at: at(10), text: 'who pushed this to the tracker?', via: 'chat', answer: one }]),
      thread('th-0000000000a4', 'A source button in the new task form', 'working', { reply: 'In progress' },
        [{ id: 'tm-0000000000a4', at: at(11), text: 'also in the new task form, a button to pick the source', via: 'chat', answer: one }]),
    ],
  }
  const dir = `${walnutHome}/org/threads`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(`${dir}/${node}.json`, JSON.stringify(file))

  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(project)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(project))
  await detail.getByTestId('org-top-threads').click()
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
  const open = page.getByTestId('org-thread-list')

  // Pending: not in the list; one quiet line says it is there.
  await expect(open.getByTestId('org-thread')).toHaveCount(3)
  await expect(card(page, 'th-0000000000a1')).toHaveCount(0)
  await expect(page.getByTestId('org-threads-pending')).toHaveText(/^1 pending, nothing new/)
  await expect(page.getByTestId('org-threads-pending')).toHaveAttribute('aria-expanded', 'false')

  // A summary that already shows its task as a pill keeps no second chip for it.
  const named = card(page, 'th-0000000000a2')
  await expect(named.getByTestId('org-thread-reply').locator(`a[data-task-id="${build}"]`)).toHaveCount(1)
  await expect(named.getByTestId('org-thread-task')).toHaveCount(1)
  await expect(named.locator(`[data-testid="org-thread-task"][data-task-id="${review}"]`)).toHaveCount(1)

  // One reply covered both of his messages in two threads: on neither card, and neither waits.
  for (const id of ['th-0000000000a3', 'th-0000000000a4']) {
    await expect(card(page, id).getByTestId('org-thread-unread')).toHaveCount(0)
    await expect(card(page, id).getByTestId('org-thread-unanswered')).toHaveCount(0)
    await expect(card(page, id).getByTestId('org-thread-reply')).toBeVisible()
  }
  // The whole conversation still has it, saying what it is.
  const both = card(page, 'th-0000000000a4')
  await both.getByTestId('org-thread-history').click()
  await expect(both.getByTestId('org-thread-answer')).toContainText('Found who pushed it')
  await expect(both.getByTestId('org-thread-answer')).toContainText('one reply to this and another thread')
  await both.getByTestId('org-thread-history').click()
  await shot(page, 'quiet')

  // The line opens the pending ones, as the closed ones open.
  await page.getByTestId('org-threads-pending').click()
  const quiet = page.getByTestId('org-thread-list-pending')
  await expect(quiet.getByTestId('org-thread')).toHaveCount(1)
  await expect(card(page, 'th-0000000000a1').getByTestId('org-thread-state')).toHaveText('Pending')
  await page.getByTestId('org-threads-pending').click()
  await expect(quiet).toHaveCount(0)

  // The node writes a new summary: news, so it is back in the list at once.
  const patch = async (id: string, data: unknown) => {
    const res = await request.patch(`/api/v1/tasks/${node}/threads/${id}`, { data })
    expect(res.ok(), await res.text()).toBe(true)
  }
  await patch('th-0000000000a1', { reply: 'Built; it needs your call on the default view' })
  await expect(open.locator('[data-thread-id="th-0000000000a1"]')).toBeVisible()
  await expect(card(page, 'th-0000000000a1').getByTestId('org-thread-state')).toHaveText('Working')
  await expect(page.getByTestId('org-threads-pending')).toHaveCount(0)
  // Pending again; then he writes in it: back again, the node's turn.
  await patch('th-0000000000a1', { state: 'pending' })
  await expect(card(page, 'th-0000000000a1')).toHaveCount(0)
  await post(request, `/api/v1/tasks/${node}/threads`, { text: `pick the open view ${STAMP}`, thread: 'th-0000000000a1' })
  await expect(open.locator('[data-thread-id="th-0000000000a1"]')).toBeVisible()
  await expect(card(page, 'th-0000000000a1').getByTestId('org-thread-count')).toHaveText(/^2 messages/)
  await expect(card(page, 'th-0000000000a1')).not.toContainText('Not answered yet')
  // A reload reads the same: the state is the file's.
  await page.reload()
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
  await expect(page.getByTestId('org-thread-list').getByTestId('org-thread')).toHaveCount(4)
  await expect(page.getByTestId('org-threads-pending')).toHaveCount(0)
})
