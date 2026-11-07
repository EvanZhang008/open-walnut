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
import { openTasksBy, expectChatShown } from './org-view-helpers'

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
    const res = await request.delete(`/api/tasks/${id}?force=true`)
    if (res.ok() || res.status() === 404) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** Older steps read cards in every state: the line of the ones in progress starts open. */
async function showInProgress(page: Page): Promise<void> {
  await page.addInitScript(() => { localStorage.setItem('open-walnut-view:org.threads.showInProgress', 'true') })
}

async function openThreads(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await showInProgress(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(LED)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(LED))
  // A node never picked a view on opens on Threads (2026-11-04).
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
}

/** The user types a request to the lead: its chat's own composer, always beside the side bar (a real send). */
async function sendToLead(page: Page, text: string): Promise<void> {
  const detail = page.getByTestId('org-detail')
  const composer = detail.locator('[data-testid="org-chat"] .chat-input-textarea')
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await composer.fill(text)
  await composer.press('Enter')
  await expect(composer).toHaveValue('')
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
    data: { title: `Mail: the meetup asks about the talk ${STAMP}`, text: 'The organizer wrote: **confirm the slot by Friday?**', from: 'mail', ref: 'Talk slot', user_kind: 'user_own', user_kind_why: 'It is his mail and his calendar' },
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

test('a thread waiting on him leads the VP\'s row and header, and the header has no "open" pill', async ({ page, request }) => {
  // 2026-11-03, the user: "this here should show need action ... remove xx open not needed also show
  // thread and number"; "thread is better than need u ... thread should be the first one in the list".
  const title = `Pick a header design ${STAMP}`
  const res = await request.post(`/api/v1/tasks/${ids.lead}/threads/open`, {
    data: { title, text: 'Which of the three?', from: 'node', user_kind: 'user_own', user_kind_why: 'He asked to pick the design himself' },
    headers: { 'x-walnut-caller-sid': ids.leadSid },
  })
  expect(res.status(), await res.text()).toBe(201)
  await isolateUiPrefs(page)
  await showInProgress(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  const row = page.locator(`[data-testid="org-channel"][data-key="${rowKey(LED)}"]`)
  // The lead's own status names the thread (the server's status sync), and the row reads it first.
  await expect(row.getByTestId('org-channel-latest')).toHaveText(new RegExp(`^\\d+ threads?: ${title}$`), { timeout: 30_000 })
  await expect(row).toHaveAttribute('data-state', 'alert')
  await row.click()
  const counts = page.getByTestId('org-detail').getByTestId('org-detail-counts')
  await expect(counts.locator('> *').first()).toHaveAttribute('data-testid', 'org-pill-threads')
  await expect(counts).not.toContainText(' open')
  await shot(page, 'threads-first')
  await counts.getByTestId('org-pill-threads').click()
  await expect(page.getByTestId('org-detail').getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
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
  const body = answer.getByTestId('org-thread-answer-body')
  await expect(body).toHaveCSS('max-height', '240px')
  await expect(body).toHaveCSS('overflow-y', 'auto')
  await answer.getByTestId('org-thread-answer-body-more').click()
  await expect(body).toHaveCSS('max-height', 'none')
  await expect(body).toContainText('Background job 10')
  await shot(page, 'conversation')
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

test('his view shows only threads with something for him; his reply sends one out at once; one reply to two threads stays off both cards', async ({ page, request }) => {
  // 2026-11-01, the user: "if it is just assigned no need to tell me, or doing, unless there are
  // some update ... thread pending, which is auto hide like closed"; then "if i reply to a thread,
  // it shoud go out of the thread immediately instead of just show working".
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
      thread('th-0000000000a2', 'Summary names its task', 'needs', { reply: `${build} is built; pick who reviews it.`, tasks: [build, review] },
        [{ id: 'tm-0000000000a2', at: at(3), text: 'and who reviews it?', via: 'chat' }]),
      thread('th-0000000000a3', 'Who pushed it to the tracker', 'answered', { reply: 'The tracker sync pushed it' },
        [{ id: 'tm-0000000000a3', at: at(10), text: 'who pushed this to the tracker?', via: 'chat', answer: one }]),
      thread('th-0000000000a4', 'A source button in the new task form', 'answered', { reply: 'The button is in' },
        [{ id: 'tm-0000000000a4', at: at(11), text: 'also in the new task form, a button to pick the source', via: 'chat', answer: one }]),
      thread('th-0000000000a5', 'Answered, he has not read it', 'working', { reply: 'Looking at the phone next' },
        [{ id: 'tm-0000000000a5', at: at(13), text: 'does the phone get it too?', via: 'chat', answer: { at: at(14), text: 'Yes, the phone reads the same file.' } }]),
      thread('th-0000000000a6', 'Just asked', 'working', { reply: 'On it' },
        [{ id: 'tm-0000000000a6', at: at(15), text: 'and the mail page?', via: 'chat' }]),
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
  const shown = async () => open.getByTestId('org-thread').evaluateAll((els) => els.map((e) => e.getAttribute('data-thread-id')).sort())

  // Shown: needs, answered, and a working one with an answer he has not read. Out of sight: the
  // pending one and the working one he just wrote in; one quiet line says they are there.
  await expect.poll(shown).toEqual(['th-0000000000a2', 'th-0000000000a3', 'th-0000000000a4', 'th-0000000000a5'])
  await expect(page.getByTestId('org-threads-hidden')).toHaveText(/^2 in progress, nothing for you/)
  await expect(page.getByTestId('org-threads-hidden')).toHaveAttribute('aria-expanded', 'false')

  // A summary that already shows its task as a pill keeps no second chip for it.
  const named = card(page, 'th-0000000000a2')
  await expect(named.getByTestId('org-thread-reply').locator(`a[data-task-id="${build}"]`)).toHaveCount(1)
  await expect(named.getByTestId('org-thread-task')).toHaveCount(1)
  await expect(named.locator(`[data-testid="org-thread-task"][data-task-id="${review}"]`)).toHaveCount(1)

  // One reply covered both of his messages in two threads: on neither card.
  for (const id of ['th-0000000000a3', 'th-0000000000a4']) {
    await expect(card(page, id).getByTestId('org-thread-unread')).toHaveCount(0)
    await expect(card(page, id).getByTestId('org-thread-reply')).toBeVisible()
  }
  // The whole conversation still has it, saying what it is.
  const both = card(page, 'th-0000000000a4')
  await both.getByTestId('org-thread-history').click()
  await expect(both.getByTestId('org-thread-answer')).toContainText('Found who pushed it')
  await expect(both.getByTestId('org-thread-answer')).toContainText('one reply to this and another thread')
  await both.getByTestId('org-thread-history').click()
  await shot(page, 'quiet')

  // The line opens the ones in progress, as the closed ones open.
  await page.getByTestId('org-threads-hidden').click()
  const quiet = page.getByTestId('org-thread-list-hidden')
  await expect(quiet.getByTestId('org-thread')).toHaveCount(2)
  await expect(card(page, 'th-0000000000a1').getByTestId('org-thread-state')).toHaveText('Pending')
  await page.getByTestId('org-threads-hidden').click()
  await expect(quiet).toHaveCount(0)

  // He replies under the answer he had not read: the next move is the node's, so it leaves at once.
  await post(request, `/api/v1/tasks/${node}/threads`, { text: `and the tablet ${STAMP}`, thread: 'th-0000000000a5' })
  await expect(open.locator('[data-thread-id="th-0000000000a5"]')).toHaveCount(0)
  await expect(page.getByTestId('org-threads-hidden')).toHaveText(/^3 in progress/)
  // An answered one he writes in leaves too.
  await post(request, `/api/v1/tasks/${node}/threads`, { text: `thanks, one more ${STAMP}`, thread: 'th-0000000000a3' })
  await expect(open.locator('[data-thread-id="th-0000000000a3"]')).toHaveCount(0)

  // Something for him brings one back: a new summary without a state (news), or needs.
  const patch = async (id: string, data: unknown) => {
    const res = await request.patch(`/api/v1/tasks/${node}/threads/${id}`, { data })
    expect(res.ok(), await res.text()).toBe(true)
  }
  await patch('th-0000000000a1', { reply: 'Built; it is live' })
  await expect(open.locator('[data-thread-id="th-0000000000a1"]')).toBeVisible()
  await expect(card(page, 'th-0000000000a1').getByTestId('org-thread-state')).toHaveText('Answered')
  await patch('th-0000000000a6', { state: 'needs', reply: 'Mail page: keep the old list or the new one?' })
  await expect(open.locator('[data-thread-id="th-0000000000a6"]')).toBeVisible()
  // A quiet update (a state named) keeps one out of sight.
  await patch('th-0000000000a5', { state: 'working', reply: 'Tablet next' })
  await expect(open.locator('[data-thread-id="th-0000000000a5"]')).toHaveCount(0)
  // A reload reads the same: the state is the file's.
  await page.reload()
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
  await expect.poll(shown).toEqual(['th-0000000000a1', 'th-0000000000a2', 'th-0000000000a4', 'th-0000000000a6'])
  await expect(page.getByTestId('org-threads-hidden')).toHaveText(/^2 in progress/)
})

test('the panel closes and comes back, per node; the Threads tab shows a dot for news he has not looked at', async ({ page, request }) => {
  // 2026-11-02, the user: "it is a panel too, you can at least let me close it ... And if this
  // thread has something new, it should show."
  const project = `Threads panel ${STAMP} ${test.info().project.name}`
  await createTask(request, `Panel work ${STAMP}`, project)
  await createTask(request, `Panel review ${STAMP}`, project)
  const node = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: project })).task.id
  made.push(node)
  const { walnutHome } = await discoverBrowserFixture(TEST_PORT)
  const t0 = Date.now() - 20 * 60_000
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString()
  const file = { version: 1, taskId: node, threads: [
    { id: 'th-00000000b001', title: 'Phone view', titled: true, state: 'working', reply: 'Checking the phone', createdAt: at(0), updatedAt: at(2),
      messages: [{ id: 'tm-00000000b001', at: at(1), text: 'does the phone get it?', via: 'chat', answer: { at: at(3), text: 'Yes, the same file.' } }] },
  ] }
  fs.mkdirSync(`${walnutHome}/org/threads`, { recursive: true })
  fs.writeFileSync(`${walnutHome}/org/threads/${node}.json`, JSON.stringify(file))

  await isolateUiPrefs(page)
  const key = rowKey(project)
  // He left this node on Task (a node never picked opens on Threads, which marks its news seen).
  await page.addInitScript(([k, v]) => { try { localStorage.setItem(k, v) } catch { /* storage off */ } }, ['open-walnut-view:org.node.view', JSON.stringify([[key, 'task']])] as const)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await page.locator(`[data-testid="org-channel"][data-key="${key}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', key)
  const top = detail.getByTestId('org-top')
  await expect(top).toHaveAttribute('data-view', 'task')

  // News he has not looked at: a dot on Threads while he is on Task; it clears once he looks.
  await expect(detail.getByTestId('org-top-threads-new')).toBeVisible()
  await detail.getByTestId('org-top-threads').click()
  await expect(detail.getByTestId('org-top-threads-new')).toHaveCount(0)
  await detail.getByTestId('org-top-task').click()
  await expect(detail.getByTestId('org-top-threads-new')).toHaveCount(0)
  // The node writes something new for him: the dot is back.
  const res = await request.patch(`/api/v1/tasks/${node}/threads/th-00000000b001`, { data: { reply: 'Phone checked: same cards' } })
  expect(res.ok(), await res.text()).toBe(true)
  await expect(detail.getByTestId('org-top-threads-new')).toBeVisible()
  await shot(page, 'panel-dot')

  // Close: the panel is gone, the chat column takes the node's width, the header brings it back.
  const width = async (id: string) => (await detail.locator(id).boundingBox())?.width ?? 0
  const before = await width('.org-detail-col')
  await detail.getByTestId('org-rail-close').click()
  await expect(detail.getByTestId('org-rail')).toHaveCount(0)
  await expect(detail.getByTestId('org-rail-handle')).toHaveCount(0)
  expect(await width('.org-detail-col')).toBeGreaterThan(before + 200)
  expect(Math.abs(await width('.org-detail-col') - await width('.org-detail-split'))).toBeLessThanOrEqual(2)
  await expect(detail.getByTestId('org-rail-toggle')).toHaveAttribute('aria-pressed', 'false')
  // The way back says there is news.
  await expect(detail.getByTestId('org-rail-toggle-new')).toBeVisible()

  // Kept per node: a reload keeps it closed; another node keeps its own panel open.
  await page.reload()
  await expect(detail).toHaveAttribute('data-key', key)
  await expect(detail.getByTestId('org-rail-toggle')).toHaveAttribute('aria-pressed', 'false')
  await expect(detail.getByTestId('org-rail')).toHaveCount(0)
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(LED)}"]`).click()
  await expect(detail).toHaveAttribute('data-key', rowKey(LED))
  await expect(detail.getByTestId('org-rail')).toBeVisible()
  await expect(detail.getByTestId('org-rail-toggle')).toHaveAttribute('aria-pressed', 'true')
  await page.locator(`[data-testid="org-channel"][data-key="${key}"]`).click()
  await expect(detail).toHaveAttribute('data-key', key)
  await expect(detail.getByTestId('org-rail')).toHaveCount(0)

  // Back: the panel returns on the view it was left on; opening Threads clears both dots.
  await detail.getByTestId('org-rail-toggle').click()
  await expect(detail.getByTestId('org-rail')).toBeVisible()
  await expect(top).toHaveAttribute('data-view', 'task')
  await detail.getByTestId('org-top-threads').click()
  await expect(detail.getByTestId('org-top-threads-new')).toHaveCount(0)
  await detail.getByTestId('org-rail-close').click()
  await expect(detail.getByTestId('org-rail-toggle-new')).toHaveCount(0)
  await detail.getByTestId('org-rail-toggle').click()
  await expect(top).toHaveAttribute('data-view', 'threads')
})

test('Snooze puts a thread aside in its Snoozed section until its time; it comes back then, on Unsnooze, or on news', async ({ page, request }) => {
  // 2026-11-02, the user: "low priority, will follow up later, actually in thread has a snoozed
  // section, also a snoozed button".
  const project = `Threads snooze ${STAMP} ${test.info().project.name}`
  await createTask(request, `Snooze work ${STAMP}`, project)
  await createTask(request, `Snooze review ${STAMP}`, project)
  const node = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: project })).task.id
  made.push(node)
  const { walnutHome } = await discoverBrowserFixture(TEST_PORT)
  const t0 = Date.now() - 20 * 60_000
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString()
  const thread = (n: string, title: string) => ({
    id: `th-00000000c00${n}`, title, titled: true, state: 'answered', reply: `${title}: the answer`, createdAt: at(0), updatedAt: at(2),
    messages: [{ id: `tm-00000000c00${n}`, at: at(1), text: `${title}?`, via: 'chat', answer: { at: at(2), text: `${title}: the answer.` } }],
  })
  fs.mkdirSync(`${walnutHome}/org/threads`, { recursive: true })
  fs.writeFileSync(`${walnutHome}/org/threads/${node}.json`, JSON.stringify({ version: 1, taskId: node, threads: [thread('1', 'Routing design'), thread('2', 'Phone view')] }))
  const stored = async (id: string) => {
    const res = await request.get(`/api/v1/tasks/${node}/threads`)
    return ((await res.json()) as { threads: Array<{ id: string; snoozed?: { until: string; by: string } }> }).threads.find((t) => t.id === id)
  }

  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(project)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(project))
  await detail.getByTestId('org-top-threads').click()
  const open = page.getByTestId('org-thread-list')
  const c1 = open.locator('[data-thread-id="th-00000000c001"]')
  await expect(c1).toBeVisible()
  await expect(page.getByTestId('org-threads-snoozed')).toHaveCount(0)

  // Snooze, from the card: the task menu's picker; 2h puts it aside for two hours.
  await c1.getByTestId('org-thread-snooze').click()
  const menu = page.getByTestId('org-thread-snooze-menu')
  await expect(menu).toBeVisible()
  const picked = Date.now()
  await menu.getByRole('button', { name: '2h', exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(c1).toHaveCount(0)
  const toggle = page.getByTestId('org-threads-snoozed')
  await expect(toggle).toHaveText(/^1 snoozed/)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(async () => (await stored('th-00000000c001'))?.snoozed?.by, { timeout: 15_000 }).toBe('human')
  const until = Date.parse((await stored('th-00000000c001'))!.snoozed!.until)
  expect(until - picked).toBeGreaterThan(2 * 3_600_000 - 60_000)
  expect(until - picked).toBeLessThan(2 * 3_600_000 + 60_000)

  // The section opens, collapsed by default, and says when it comes back.
  await toggle.click()
  const section = page.getByTestId('org-thread-list-snoozed')
  const s1 = section.locator('[data-thread-id="th-00000000c001"]')
  await expect(s1.getByTestId('org-thread-snoozed-until')).toHaveText(/^Snoozed until (today|tomorrow), /)
  await shot(page, 'snoozed')
  // Unsnooze brings it back at once.
  await s1.getByTestId('org-thread-unsnooze').click()
  await expect(c1).toBeVisible()
  await expect(page.getByTestId('org-threads-snoozed')).toHaveCount(0)
  await expect.poll(async () => (await stored('th-00000000c001'))?.snoozed, { timeout: 15_000 }).toBeUndefined()

  // The node snoozes one too (an agent action) for a few seconds: it comes back on its time with no reload.
  const res = await request.patch(`/api/v1/tasks/${node}/threads/th-00000000c002`, { data: { snooze: new Date(Date.now() + 6_000).toISOString() } })
  expect(res.ok(), await res.text()).toBe(true)
  const c2 = open.locator('[data-thread-id="th-00000000c002"]')
  await expect(c2).toHaveCount(0)
  await expect(page.getByTestId('org-threads-snoozed')).toHaveText(/^1 snoozed/)
  await expect(c2).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('org-threads-snoozed')).toHaveCount(0)

  // News brings one back early: snoozed for a day, then it moves to needs.
  const day = await request.patch(`/api/v1/tasks/${node}/threads/th-00000000c002`, { data: { snooze: '1d' } })
  expect(day.ok(), await day.text()).toBe(true)
  await expect(c2).toHaveCount(0)
  const needs = await request.patch(`/api/v1/tasks/${node}/threads/th-00000000c002`, { data: { state: 'needs', reply: 'Pick: cards or a list?' } })
  expect(needs.ok(), await needs.text()).toBe(true)
  await expect(c2).toBeVisible()
  await expect(c2.getByTestId('org-thread-state')).toHaveText('Needs you')
  expect((await stored('th-00000000c002'))?.snoozed).toBeUndefined()
})

test('asks and structured bodies stay whole; plain long answers still expand without fading', async ({ page, request }) => {
  const project = `Threads readable ${STAMP} ${test.info().project.name}`
  await createTask(request, `Readable work ${STAMP}`, project)
  await createTask(request, `Readable review ${STAMP}`, project)
  const node = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: project })).task.id
  made.push(node)
  const { walnutHome } = await discoverBrowserFixture(TEST_PORT)
  const at = new Date(Date.now() - 60_000).toISOString()
  const long = Array.from({ length: 10 }, (_, i) => `Paragraph ${i + 1}: ${'readable detail '.repeat(12)}`).join('\n\n')
  const bodies = [
    ['plain', long],
    ['plain-code', `${long}\n\nUse \`config\` to pick the default.`],
    ['short', 'Pick A or B.'],
    ['path', `${long}\n\n\`/workspace/designs/choose-a-readable-design.html\``],
    ['link', `${long}\n\n/workspace/designs/choose-a-readable-design.html`],
    ['code', `${long}\n\n\`\`\`text\n/workspace/designs/choose-a-readable-design.html\n\`\`\``],
    ['list', `${long}\n\n1. Choose A.\n2. Choose B.\n3. Reply with your choice.`],
    ['table', `${long}\n\n| Option | Choice |\n| --- | --- |\n| A | Recommended |\n| B | Alternative |`],
    ['quote', `${long}\n\n> Reply with your choice.`],
  ]
  const seeded = ['needs', 'answered', 'new', 'working', 'pending'].flatMap((state, s) => bodies.flatMap(([kind, text], k) => ['opener', 'answer'].map((via, v) => ({
    id: `th-${(s * 100 + k * 2 + v + 1000).toString(16).padStart(12, '0')}`,
    title: `${state} ${kind} ${via}`, titled: true, state, createdAt: at, updatedAt: at,
    messages: via === 'opener' ? [] : [{ id: `tm-${s}-${k}`, at, text: 'Which option?', via: 'chat', answer: { at: new Date(Date.parse(at) + s * 100 + k + 1).toISOString(), text } }],
    ...(via === 'opener' ? { opener: { at, text, from: 'node', by: 'task:agent' } } : {}),
  }))))
  fs.mkdirSync(`${walnutHome}/org/threads`, { recursive: true })
  fs.writeFileSync(`${walnutHome}/org/threads/${node}.json`, JSON.stringify({ version: 1, taskId: node, threads: seeded }))
  await isolateUiPrefs(page)
  await showInProgress(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(project)}"]`).click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', rowKey(project))
  await page.getByTestId('org-top-threads').click()
  if (await page.getByTestId('org-threads-hidden').getAttribute('aria-expanded') === 'false') await page.getByTestId('org-threads-hidden').click()
  for (const t of seeded) {
    const c = card(page, t.id)
    const body = c.getByTestId('org-thread-answer-body')
    const plainFold = t.state !== 'needs' && / plain(?:-code)? /.test(t.title)
    await expect(body).toHaveCount(1)
    await expect(body).toHaveCSS('mask-image', 'none')
    const toggle = c.getByTestId('org-thread-answer-body-more')
    if (t.state !== 'needs' && !t.title.includes(' short ')) {
      await expect(toggle).toContainText('Expand')
      if (!plainFold) {
        await expect(body).toHaveCSS('overflow-y', 'auto')
        await expect(body).toHaveCSS('max-height', '240px')
      }
      const foldedHeight = await body.evaluate((e) => e.clientHeight)
      await toggle.click()
      await expect(body).toHaveCSS('display', 'block')
      expect(await body.evaluate((e) => e.clientHeight)).toBeGreaterThan(foldedHeight)
      expect(await body.evaluate((e) => e.scrollHeight - e.clientHeight)).toBeLessThanOrEqual(1)
      await toggle.click()
      await expect(toggle).toContainText('Expand')
    } else {
      await expect(toggle).toHaveCount(0)
      if (!t.title.includes(' short ')) {
        await expect(body).toHaveCSS('max-height', 'none')
        expect(await body.evaluate((e) => e.scrollHeight - e.clientHeight)).toBeLessThanOrEqual(1)
      }
    }
  }
  await page.setViewportSize({ width: 1000, height: 900 })
  const needs = seeded.find((t) => t.title === 'needs code opener')!
  const c = card(page, needs.id)
  await expect(c.locator('pre')).toContainText('/workspace/designs/choose-a-readable-design.html')
  await c.getByTestId('org-thread-history').click()
  await expect(c.getByTestId('org-thread-answer-body')).toHaveCSS('max-height', 'none')
  await c.getByTestId('org-thread-history').click()
  await c.getByTestId('org-thread-follow-open').click()
  await c.getByTestId('org-thread-follow-input').fill('My choice is A')
  await expect(c.locator('pre')).toContainText('choose-a-readable-design.html')
  await c.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await page.getByTestId('org-threads').evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1)
  await shot(page, 'readable')
})

test('Pin keeps a thread at the top whatever its state; the node cannot take his pin off; unpinned it goes back to its place', async ({ page, request }) => {
  // 2026-11-03, the user: "have a pin thread feature, like this thread I need to make it pinned".
  const project = `Threads pin ${STAMP} ${test.info().project.name}`
  await createTask(request, `Pin work ${STAMP}`, project)
  await createTask(request, `Pin review ${STAMP}`, project)
  const node = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: project })).task.id
  made.push(node)
  const { walnutHome } = await discoverBrowserFixture(TEST_PORT)
  const t0 = Date.now() - 20 * 60_000
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString()
  const thread = (n: string, title: string, state: string, min: number) => ({
    id: `th-00000000d00${n}`, title, titled: true, state, reply: `${title}: the summary`, createdAt: at(0), updatedAt: at(min),
    messages: [{ id: `tm-00000000d00${n}`, at: at(min - 1), text: `${title}?`, via: 'chat', ...(state === 'answered' ? { answer: { at: at(min), text: `${title}: the answer.` } } : {}) }],
  })
  fs.mkdirSync(`${walnutHome}/org/threads`, { recursive: true })
  fs.writeFileSync(`${walnutHome}/org/threads/${node}.json`, JSON.stringify({ version: 1, taskId: node, threads: [
    thread('1', 'Routing design', 'answered', 9), thread('2', 'Phone view', 'answered', 6), thread('3', 'Watch list context', 'working', 3),
  ] }))
  const stored = async (id: string) => {
    const res = await request.get(`/api/v1/tasks/${node}/threads`)
    return ((await res.json()) as { threads: Array<{ id: string; pinned?: { at: string; by: string }; closed?: unknown }> }).threads.find((t) => t.id === id)
  }

  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(project)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(project))
  await detail.getByTestId('org-top-threads').click()
  const open = page.getByTestId('org-thread-list')
  const ids3 = () => open.locator('[data-testid="org-thread"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-thread-id')))
  await expect.poll(ids3).toEqual(['th-00000000d001', 'th-00000000d002'])
  await expect(page.getByTestId('org-threads-hidden')).toHaveText(/^1 in progress/)
  await expect(open.getByTestId('org-thread-pinned')).toHaveCount(0)

  // Pin the second one: it goes to the top, wears the pin, and the button reads Unpin.
  const c2 = open.locator('[data-thread-id="th-00000000d002"]')
  await c2.getByTestId('org-thread-pin').click()
  await expect.poll(ids3).toEqual(['th-00000000d002', 'th-00000000d001'])
  await expect(c2.getByTestId('org-thread-pinned')).toHaveText(/^Pinned/)
  await expect(c2.getByTestId('org-thread-pin')).toHaveAttribute('aria-pressed', 'true')
  await expect(c2.getByTestId('org-thread-pin')).toHaveAccessibleName('Unpin "Phone view"')
  await expect.poll(async () => (await stored('th-00000000d002'))?.pinned?.by, { timeout: 15_000 }).toBe('human')
  await shot(page, 'pinned')
  // A reload keeps it on top.
  await page.reload()
  await expect(page.getByTestId('org-thread-list')).toBeVisible({ timeout: 30_000 })
  await expect.poll(ids3).toEqual(['th-00000000d002', 'th-00000000d001'])

  // The node may not take his pin off (its session's write).
  const refused = await request.patch(`/api/v1/tasks/${node}/threads/th-00000000d002`, { data: { pin: false }, headers: { 'x-walnut-caller-sid': ids.leadSid } })
  expect(refused.status(), await refused.text()).toBe(409)
  expect(await refused.text()).toContain('pinned_by_user')
  // It pins the working one itself: a thread in progress shows, on top, marked as the node's pin.
  const agentPin = await request.patch(`/api/v1/tasks/${node}/threads/th-00000000d003`, { data: { pin: true }, headers: { 'x-walnut-caller-sid': ids.leadSid } })
  expect(agentPin.ok(), await agentPin.text()).toBe(true)
  const c3 = open.locator('[data-thread-id="th-00000000d003"]')
  await expect(c3).toBeVisible({ timeout: 15_000 })
  await expect.poll(ids3).toEqual(['th-00000000d003', 'th-00000000d002', 'th-00000000d001'])
  await expect(c3.getByTestId('org-thread-pinned')).toHaveText(/^Pinned by /)
  await expect(page.getByTestId('org-threads-hidden')).toHaveCount(0)
  // The Org list's row names a pinned thread with the pin.
  await expect(page.locator(`[data-testid="org-channel"][data-key="${rowKey(project)}"] .org-channel-pin`)).toBeVisible({ timeout: 20_000 })

  // Unpin his: it goes back to its place under the newer change.
  await c2.getByTestId('org-thread-pin').click()
  await expect.poll(ids3).toEqual(['th-00000000d003', 'th-00000000d001', 'th-00000000d002'])
  await expect(c2.getByTestId('org-thread-pinned')).toHaveCount(0)
  await expect.poll(async () => (await stored('th-00000000d002'))?.pinned, { timeout: 15_000 }).toBeUndefined()
  // Acknowledge ends the node's pin with the thread.
  await c3.getByTestId('org-thread-ack').click()
  await expect(c3).toHaveCount(0)
  await expect.poll(async () => { const t = await stored('th-00000000d003'); return !!t?.closed && !t.pinned }, { timeout: 15_000 }).toBe(true)
  await expect.poll(ids3).toEqual(['th-00000000d001', 'th-00000000d002'])
})
