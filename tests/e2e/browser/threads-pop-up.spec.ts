/**
 * A task's thread pops up to its lead, and his reply there wakes the task (experiment
 * threads_pop_up, src/core/org/thread-popup.ts, thread-reply.ts, web/src/components/org/
 * PoppedThreadCard.tsx; 2026-11-20, the user: "if we reply I think it should go directly to that
 * thread, also send a buffer message to the main agent").
 *
 *  1. A subtask of a lead opens a thread that waits on him. On the lead's Threads (Org page) the
 *     same thread shows as the ask card, naming the subtask; the lead's own Threads hold no copy.
 *  2. He answers in the card's reply box: the card says the task has not read it yet, then the
 *     words reach the subtask's own chat (its session runs a turn on them), and the subtask's
 *     thread holds his message.
 *  3. Off (the flag's default), the lead lists only its own threads.
 *  4. A thread below asking him to pick carries its options: the card shows them as buttons (the
 *     recommended one first, marked), no Acknowledge; a click sends its label to the subtask's
 *     thread as his reply (2026-11-20, the user: "if you recommend this, why can I not just click it?").
 *  5. Threads by state: his reply moves a card below to Working, leaving a line in Needs you;
 *     snoozed there with the keyboard it leaves a line holding the focus; in Waiting it
 *     says until when, its box follows the task up, and its menu's Unsnooze brings it back to
 *     Working (2026-11-21, a review: no way back).
 * The fixture is shared: this file makes its own project and tasks, and puts the flag back.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { restoreOneCard, setOneCard } from './one-card-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Popup ${STAMP}`
const made: string[] = []
// Its cards are the one-card experiment's (threads_one_card): on for this spec, put back after it.
let oneCardWas: boolean | null = null
const ids = { lead: '', owner: '', ownerSid: '', thread: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`
const ASK = `Turn the new thread store on in your own settings now, or wait a day? ${STAMP}`
const REPLY = `Turn it on now ${STAMP}`

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ video: 'on', viewport: { width: 1280, height: 800 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function post<T>(request: APIRequestContext, url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request.post(url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
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

async function openLead(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(PROJECT))
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
}

const card = (page: Page) => page.locator(`[data-testid="org-thread"][data-thread-id="${ids.thread}"]`)

async function shot(page: Page, name: string, scope = page.getByTestId('org-rail')): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await scope.screenshot({ path: `${SHOTS}/threads-pop-up-${name}-${test.info().project.name}.png` })
}

async function startSession(request: APIRequestContext, taskId: string, fixtureRoot: string): Promise<string> {
  await post(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId })
  let sid = ''
  await expect.poll(async () => (sid = (await (await request.get(`/api/tasks/${taskId}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  return sid
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  oneCardWas = await setOneCard(request, true)
  // A project with two or more teams gets a lead (org_contact).
  for (const title of [`Side work ${STAMP}`, `More work ${STAMP}`]) {
    made.push((await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  ids.lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Task status foundation ${STAMP}`, project: PROJECT, source: 'local', parent_task_id: ids.lead })
  ids.owner = task.id
  made.push(task.id)
  // Threads on for this task alone: the fixture's task_threads switch stays as it is.
  const on = await request.patch(`/api/tasks/${ids.owner}`, { data: { threads_on: true } })
  expect(on.ok(), await on.text()).toBe(true)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  ids.ownerSid = await startSession(request, ids.owner, fixtureRoot)
  // The subtask opens a thread that waits on him, as its own session does with thread_create.
  const opened = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.owner}/threads/open`, {
    title: `Thread store switch ${STAMP}`, text: ASK, state: 'needs', from: 'node',
    user_kind: 'user_own', user_kind_why: 'It changes his own settings and data store.',
  }, ids.ownerSid)
  ids.thread = opened.thread.id
  const asked = await request.patch(`/api/v1/tasks/${ids.owner}/threads/${ids.thread}`, { data: { reply: ASK, state: 'needs', user_kind: 'user_own', user_kind_why: 'It changes his own settings and data store.' }, headers: { 'x-walnut-caller-sid': ids.ownerSid } })
  expect(asked.ok(), await asked.text()).toBe(true)
})

test.afterAll(async ({ request }) => {
  await restoreOneCard(request, oneCardWas)
  await flag(request, false)
  for (const id of made) await removeTask(request, id)
})

test('off: the lead lists only its own threads', async ({ page, request }) => {
  await flag(request, false)
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  await page.waitForTimeout(1_000)
  await expect(card(page)).toHaveCount(0)
})

test('on: the subtask\'s thread shows on its lead, and his reply there wakes the subtask', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await flag(request, true)
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)

  // 1. The one record, listed on the lead, naming its owner; the lead holds no copy of it.
  const popped = card(page)
  await expect(popped).toBeVisible({ timeout: 20_000 })
  await expect(popped).toHaveAttribute('data-owner', ids.owner)
  await expect(popped.getByTestId('org-thread-owner')).toHaveText(`Task status foundation ${STAMP}`)
  await expect(popped.getByTestId('org-thread-popped')).toContainText(ASK)
  const own = await (await request.get(`/api/v1/tasks/${ids.lead}/threads`)).json() as { threads: Array<{ id: string; owner?: { task_id: string } }> }
  expect(own.threads.filter((t) => t.id === ids.thread).map((t) => t.owner?.task_id)).toEqual([ids.owner])
  await shot(page, '1-popped')

  // 2. He answers in the card, typing as a person does. A send the server refuses keeps his words
  //    in the box with the reason, and reads nothing as sent.
  const input = popped.getByTestId('org-thread-popped-input')
  await input.click()
  await page.keyboard.type(REPLY, { delay: 20 })
  const replies = `**/api/v1/tasks/${ids.lead}/threads`
  await page.route(replies, (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'test: refused once' }) })
    : route.fallback())
  await popped.getByTestId('org-thread-popped-send').click()
  await expect(popped.getByTestId('org-thread-popped-failed')).toBeVisible({ timeout: 5_000 })
  await expect(input).toHaveValue(REPLY)
  await expect(popped.getByTestId('org-thread-popped-sent')).toHaveCount(0)
  await page.unroute(replies)
  // Sent again: the card says at once (within a second of the click) that his words went, echoing
  // them, and that the task has not read them yet; the box is clear.
  await popped.getByTestId('org-thread-popped-send').click()
  const sent = popped.getByTestId('org-thread-popped-sent')
  await expect(sent).toBeVisible({ timeout: 1_000 })
  await expect(sent.getByTestId('org-thread-popped-sent-words')).toHaveText(REPLY)
  await expect(sent.getByTestId('org-thread-unread-by-task')).toHaveText(new RegExp(`^Sent: Task status foundation ${STAMP} has (not read it yet|read it)\\.$`))
  await expect(popped.getByTestId('org-thread-popped-failed')).toHaveCount(0)
  await shot(page, '2-sent')

  // The words land in the subtask's own thread and reach its session, which reads them.
  await expect.poll(async () => {
    const file = await (await request.get(`/api/v1/tasks/${ids.owner}/threads`)).json() as { threads: Array<{ id: string; messages: Array<{ text: string; delivery?: { state: string } }> }> }
    return file.threads.find((t) => t.id === ids.thread)?.messages.find((m) => m.text === REPLY)?.delivery?.state ?? 'none'
  }, { timeout: 60_000 }).toBe('delivered')

  // Once the subtask has his words, the card leaves the lead's list: nothing waits on him there.
  await expect(card(page)).toHaveCount(0, { timeout: 20_000 })
  // He opens the subtask from the lead's Tasks: his words are in its chat.
  // The side bar's views are tabs since the choice controls became one set (18510bbab3, 2026-11-22).
  const side = page.getByRole('tablist', { name: /^Threads(, Tasks or Brief| or Tasks)$/ })
  await side.getByRole('tab', { name: /^Tasks/ }).click()
  const row = page.getByRole('button', { name: new RegExp(`^Task status foundation ${STAMP}`) }).first()
  // Its turn on his words has ended, so it may sit in the folded Waiting group.
  if (!(await row.isVisible())) await page.getByRole('button', { name: /^Waiting\b/ }).last().click()
  await row.click()
  const chat = page.locator('.main-page-session-column, .session-panel').filter({ hasText: REPLY }).first()
  await expect(chat).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_500)
  await page.screenshot({ path: `${SHOTS}/threads-pop-up-3-woken-${test.info().project.name}.png` })
  expect(pageErrors).toEqual([])
})

test('on: a choice on a thread below is clicked on the lead, and goes to the subtask as his reply', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const PICK = `Keep the old store ${STAMP}`
  const opened = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.owner}/threads/open`, {
    title: `Store migration ${STAMP}`, text: `Move the thread store this week or keep the old one? ${STAMP}`, state: 'needs', from: 'node',
    user_kind: 'user_own', user_kind_why: 'It changes his own data store.',
    options: [{ id: 'move', label: `Move it this week ${STAMP}` }, { id: 'keep', label: PICK, detail: 'Nothing to migrate now', recommended: true }],
  }, ids.ownerSid)
  const choice = opened.thread.id
  await flag(request, true)
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  const popped = page.locator(`[data-testid="org-thread"][data-thread-id="${choice}"]`)
  await expect(popped).toBeVisible({ timeout: 20_000 })
  const buttons = popped.getByTestId('org-thread-options').getByTestId('org-answer-option')
  await expect(buttons).toHaveText([PICK, `Move it this week ${STAMP}`])
  await expect(buttons.first()).toHaveAttribute('data-recommended', 'true')
  await expect(popped.getByTestId('org-thread-popped-input')).toBeVisible()
  await expect(popped.getByTestId('org-thread-ack')).toHaveCount(0)
  await shot(page, '4-options')
  await buttons.first().click()
  await expect.poll(async () => {
    const file = await (await request.get(`/api/v1/tasks/${ids.owner}/threads`)).json() as { threads: Array<{ id: string; messages: Array<{ text: string; delivery?: { state: string } }> }> }
    return file.threads.find((t) => t.id === choice)?.messages.find((m) => m.text === PICK)?.delivery?.state ?? 'none'
  }, { timeout: 60_000 }).toBe('delivered')
  await expect(popped).toHaveCount(0, { timeout: 20_000 })
  expect(pageErrors).toEqual([])
})

// 2026-11-20: his reply on a card of a thread below vanished after a redraw while the card stayed
// (the card echoed it from its own memory). His words are read from the thread's record: they stay
// on the card through leaving the page and coming back, until the task has read them.
test('on: his reply stays on the card through a redraw while the task has not read it', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const WORDS = `Paint the fence green, just do it ${STAMP}`
  const opened = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.owner}/threads/open`, {
    title: `Fence colour ${STAMP}`, text: `Green or white for the garden fence? ${STAMP}`, state: 'needs', from: 'node',
    user_kind: 'user_own', user_kind_why: 'It is his own garden.',
  }, ids.ownerSid)
  const id = opened.thread.id
  await flag(request, true)
  // The task is busy in a long turn: his reply waits for its end, so it stays on its way meanwhile.
  const busy = await request.post(`/api/v1/sessions/${ids.ownerSid}/messages`, { data: { text: 'snapshot-long-turn:25000' } })
  expect(busy.ok(), await busy.text()).toBe(true)
  await expect.poll(async () => (await (await request.get(`/api/tasks/${ids.owner}`)).json()).task?.phase, { timeout: 20_000 }).toBe('IN_PROGRESS')
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  const popped = page.locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)
  await expect(popped).toBeVisible({ timeout: 20_000 })
  await popped.getByTestId('org-thread-popped-input').click()
  await page.keyboard.type(WORDS, { delay: 10 })
  await popped.getByTestId('org-thread-popped-send').click()
  const sent = popped.getByTestId('org-thread-popped-sent')
  await expect(sent.getByTestId('org-thread-popped-sent-words')).toHaveText(WORDS, { timeout: 2_000 })
  // He leaves the Org page and comes back: the card is drawn anew, his words are still on it.
  await page.locator('.sidebar-home-group a').first().click()
  await expect(page.getByTestId('org-page')).toHaveCount(0)
  await openLead(page)
  await expect(popped).toBeVisible({ timeout: 20_000 })
  await expect(sent.getByTestId('org-thread-popped-sent-words')).toHaveText(WORDS)
  await expect(sent.getByTestId('org-thread-unread-by-task')).toHaveText(`Sent: Task status foundation ${STAMP} has not read it yet.`)
  await shot(page, '5-redrawn')
  // The long turn ends, the task reads his words, and the card leaves.
  await expect.poll(async () => {
    const file = await (await request.get(`/api/v1/tasks/${ids.owner}/threads`)).json() as { threads: Array<{ id: string; messages: Array<{ text: string; delivery?: { state: string } }> }> }
    return file.threads.find((t) => t.id === id)?.messages.find((m) => m.text === WORDS)?.delivery?.state ?? 'none'
  }, { timeout: 90_000 }).toBe('delivered')
  await expect(popped).toHaveCount(0, { timeout: 20_000 })
  expect(pageErrors).toEqual([])
})

// 2026-11-20, the user, on a card he had answered that stayed in Needs you: "why this even keep
// showing after I replied?". With his Threads by state (brief_off), his reply moves the card out of
// Needs you at once to Working (the task's move), his words on it, before the task reads them.
test('on, Threads by state: his reply moves the card out of Needs you to Working, his words on it', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const WORDS = `Delete the two long notes, just do it ${STAMP}`
  const opened = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.owner}/threads/open`, {
    title: `Long notes ${STAMP}`, text: `The first note is short now; delete the two long ones? ${STAMP}`, state: 'needs', from: 'node',
    user_kind: 'user_own', user_kind_why: 'They are his own notes.',
  }, ids.ownerSid)
  const id = opened.thread.id
  await flag(request, true)
  const briefOff = await request.put('/api/config', { data: { experimental: { brief_off: true } } })
  expect(briefOff.ok(), await briefOff.text()).toBe(true)
  try {
    // The task is busy in a long turn, so his reply is still on its way while the card is read.
    const busy = await request.post(`/api/v1/sessions/${ids.ownerSid}/messages`, { data: { text: 'snapshot-long-turn:25000' } })
    expect(busy.ok(), await busy.text()).toBe(true)
    await isolateUiPrefs(page)
    await loadHome(page)
    await openLead(page)
    const group = (g: string) => page.locator(`[data-testid="org-thread-group"][data-group="${g}"]`)
    const inGroup = (g: string) => group(g).locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)
    await expect(inGroup('needs')).toBeVisible({ timeout: 20_000 })
    await expect(inGroup('needs').getByTestId('org-thread-state')).toHaveText('Needs you')
    // On his data a read of the lead's Threads takes seconds (2026-11-20, on a copy of it: 2 to 4 s,
    // and a read started before his reply could draw the card back): the reads are held 6 s from
    // here, so only the card's own answer can move it.
    await page.route(`**/api/v1/tasks/${ids.lead}/threads*`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      await new Promise((r) => setTimeout(r, 6_000))
      return route.continue().catch(() => {})
    })
    await inGroup('needs').getByTestId('org-thread-popped-input').click()
    await page.keyboard.type(WORDS, { delay: 10 })
    await inGroup('needs').getByTestId('org-thread-popped-send').click()
    // Out of Needs you at once; in Working, with his words and that the task has not read them.
    await expect(inGroup('needs')).toHaveCount(0, { timeout: 1_500 })
    const working = group('working')
    await expect(working).toBeVisible()
    if ((await working.getAttribute('data-open')) !== 'true') await working.getByTestId('org-thread-group-head').click()
    const card = inGroup('working')
    // It reads its group now: Working's green dot and its word, as the node's own cards (ThreadState,
    // 2026-11-21: it sat there with a grey dot and no word), a box that follows the task up, and a
    // line in Needs you saying where it went.
    await expect(card).toHaveAttribute('data-group', 'working')
    await expect(card.getByTestId('org-thread-popped-input')).toHaveAttribute('placeholder', `Follow up with Task status foundation ${STAMP}`)
    const state = card.getByTestId('org-thread-state')
    await expect(state).toHaveText('Working')
    const dot = await state.locator('i').evaluate((el) => getComputedStyle(el).backgroundColor)
    const workingDot = await page.evaluate(() => { const b = document.createElement('b'); b.style.color = 'var(--success, #34C759)'; document.body.append(b); const c = getComputedStyle(b).color; b.remove(); return c })
    expect(dot).toBe(workingDot)
    // Its question keeps no dot of its own beside the state's.
    expect(await card.locator('.ask-card-question').evaluate((el) => getComputedStyle(el, '::before').content)).toBe('none')
    await expect(group('needs').locator(`[data-testid="org-thread-move-note"][data-moved-id="${id}"]`)).toContainText('Moved to Working')
    await expect(card.getByTestId('org-thread-popped-sent-words')).toHaveText(WORDS)
    await expect(card.getByTestId('org-thread-unread-by-task')).toHaveText(`Sent: Task status foundation ${STAMP} has not read it yet.`)
    const file = await (await request.get(`/api/v1/tasks/${ids.owner}/threads`)).json() as { threads: Array<{ id: string; messages: Array<{ text: string; delivery?: { state: string } }> }> }
    expect(file.threads.find((t) => t.id === id)?.messages.find((m) => m.text === WORDS)?.delivery?.state).not.toBe('delivered')
    await shot(page, '6-left-needs')
    expect(pageErrors).toEqual([])
  } finally {
    await request.put('/api/config', { data: { experimental: { brief_off: false } } })
  }
})

// 2026-11-21, a review on his data: a snoozed card below said neither when it comes back nor how to
// bring it back, and a keyboard pick left the focus on the page. A card below stays on the lead
// while his reply on it is on its way (thread-popup.ts), so that is when it is snoozed there.
test('on, Threads by state: a card below snoozed says until when, and its Unsnooze brings it back', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const WORDS = `Order it in January ${STAMP}`
  const opened = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.owner}/threads/open`, {
    title: `Seed catalogue ${STAMP}`, text: `Order the spring seed catalogue now or in January? ${STAMP}`, state: 'needs', from: 'node',
    user_kind: 'user_own', user_kind_why: 'It is his own garden.',
  }, ids.ownerSid)
  const id = opened.thread.id
  await flag(request, true)
  const briefOff = await request.put('/api/config', { data: { experimental: { brief_off: true } } })
  expect(briefOff.ok(), await briefOff.text()).toBe(true)
  try {
    // The task is busy in a long turn, so his reply stays on its way while the card is snoozed.
    const busy = await request.post(`/api/v1/sessions/${ids.ownerSid}/messages`, { data: { text: 'snapshot-long-turn:45000' } })
    expect(busy.ok(), await busy.text()).toBe(true)
    await isolateUiPrefs(page)
    await loadHome(page)
    await openLead(page)
    const group = (g: string) => page.locator(`[data-testid="org-thread-group"][data-group="${g}"]`)
    const inGroup = (g: string) => page.locator(`[data-testid="org-thread-group"][data-group="${g}"] [data-testid="org-thread"][data-thread-id="${id}"]`)
    const line = page.locator(`[data-testid="org-thread-move-note"][data-moved-id="${id}"]`)
    const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? document.activeElement?.tagName ?? null)
    await expect(inGroup('needs')).toBeVisible({ timeout: 20_000 })
    await expect(inGroup('needs').getByTestId('org-thread-popped-input')).toHaveAttribute('placeholder', `Answer Task status foundation ${STAMP}`)
    await inGroup('needs').getByTestId('org-thread-popped-input').click()
    await page.keyboard.type(WORDS, { delay: 10 })
    await inGroup('needs').getByTestId('org-thread-popped-send').click()
    // It left Needs you for Working: a line says so; Show opens Working.
    await expect(line).toContainText('Moved to Working')
    await line.getByTestId('org-thread-move-show').click()
    await expect(group('working')).toHaveAttribute('data-open', 'true')
    await expect(inGroup('working')).toBeVisible()
    // Snoozed with the keyboard: Enter on Snooze, then on 2h.
    await inGroup('working').getByTestId('org-thread-snooze').focus()
    await page.keyboard.press('Enter')
    const menu = page.getByTestId('org-thread-snooze-menu')
    await menu.getByRole('button', { name: '2h', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(inGroup('working')).toHaveCount(0)
    await expect(line).toContainText('Moved to Waiting')
    await expect.poll(focused).toBe('org-thread-move-show')
    await shot(page, '7-snoozed-line')
    // Show: Waiting opens, the card saying until when, Snoozed and Unsnooze on it.
    await page.keyboard.press('Enter')
    await expect(group('waiting')).toHaveAttribute('data-open', 'true')
    const card = inGroup('waiting')
    await expect(card).toHaveAttribute('data-group', 'waiting')
    await expect(card.getByTestId('org-thread-snoozed-until')).toHaveText(/^Snoozed until (today|tomorrow), /)
    await expect(card.getByTestId('org-thread-snooze')).toHaveText(/^Snoozed/)
    await expect(card.getByTestId('org-thread-unsnooze')).toBeVisible()
    await expect(card.getByTestId('org-thread-popped-input')).toHaveAttribute('placeholder', `Follow up with Task status foundation ${STAMP}`)
    await shot(page, '8-snoozed-card')
    await card.getByTestId('org-thread-snooze').click()
    await expect(menu.getByTestId('org-thread-snooze-current')).toHaveText(/^Snoozed until (today|tomorrow), /)
    await shot(page, '8-snoozed-menu')
    await menu.getByTestId('org-thread-snooze-clear').click()
    await expect(card).toHaveCount(0)
    await expect(line).toContainText('Moved to Working')
    await expect.poll(async () => {
      const file = await (await request.get(`/api/v1/tasks/${ids.owner}/threads`)).json() as { threads: Array<{ id: string; snoozed?: unknown }> }
      return file.threads.find((t) => t.id === id)?.snoozed ?? null
    }, { timeout: 15_000 }).toBeNull()
    expect(pageErrors).toEqual([])
  } finally {
    await request.put('/api/config', { data: { experimental: { brief_off: false } } })
  }
})

// 2026-11-21, the user, after answering a task's card in the top of his VP's chat ("2 / 4"): "i send
// it, but the thread don't go away ... I have to manually click next", and on the VP's row, a red
// "1 thread" with no such card in its Threads ("It show 1 but there isn't any"). His reply makes the
// card the task's move at once: it leaves the top (the next card takes its place, no click), the top's
// N, the header and the row's dot count drop by one, and the Threads view keeps it in Working with his words.
test('on, top of the chat: his reply on a card below leaves the top and every count at once, the next card in its place', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const WORDS = `Put each code in the tab it belongs to ${STAMP}`
  // Two asks of one task at once: each says it is a decision of its own (thread-supersede.ts).
  const why = { user_kind: 'user_own', user_kind_why: 'It spends his own garden budget.', separate_reason: 'Each card here is a decision of its own.' }
  const open = async (title: string) => (await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.owner}/threads/open`, {
    title: `${title} ${STAMP}`, text: `${title}? ${STAMP}`, state: 'needs', from: 'node', ...why,
  }, ids.ownerSid)).thread.id
  // Decisions in words: a question about where a button goes, with no picture, is refused by the
  // server's clarity gate (core/org/ask-clarity.ts), so the invented ones ask nothing about a screen.
  const first = await open('Which supplier gets the seed order')
  const second = await open('Should the shed paint wait until spring')
  await flag(request, true)
  const was = (await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }).config?.experimental ?? {}
  const put = await request.put('/api/config', { data: { experimental: { brief_off: true, top_thread: true } } })
  expect(put.ok(), await put.text()).toBe(true)
  try {
    // The task is busy in a long turn, so his reply is still on its way while every count is read.
    const busy = await request.post(`/api/v1/sessions/${ids.ownerSid}/messages`, { data: { text: 'snapshot-long-turn:30000' } })
    expect(busy.ok(), await busy.text()).toBe(true)
    await isolateUiPrefs(page)
    await loadHome(page)
    await openLead(page)
    const top = page.getByTestId('org-chat').getByTestId('top-thread')
    const pill = page.getByTestId('org-pill-threads')
    // The row's red dot (OrgListRow): its label is the count ("2 threads"); n >= 2, so it stays.
    const badge = page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"] [data-testid="org-channel-dot"]`)
    const threads = (k: number) => `${k} thread${k === 1 ? '' : 's'}`
    await expect(page.locator(`[data-testid="org-thread-group"][data-group="needs"] [data-thread-id="${second}"]`)).toBeVisible({ timeout: 20_000 })
    // The Threads beside the chat: the top draws none of them again (2026-11-23, the user: "两处都改").
    await expect(top).toHaveCount(0)
    // The side bar hidden, the top shows them.
    const toggle = page.getByTestId('org-detail').getByTestId('org-rail-toggle')
    await toggle.click()
    await expect(page.getByTestId('org-rail')).toHaveCount(0)
    // Step the top to the newer of the two (newest first): the one he answers.
    const pos = top.getByTestId('top-thread-pos')
    await expect(pos).toHaveText(/^\d+ \/ \d+$/, { timeout: 20_000 })
    const n = Number((await pos.textContent())!.split('/')[1])
    expect(n).toBeGreaterThanOrEqual(2)
    for (let i = 0; i < n && (await top.getAttribute('data-thread-id')) !== second; i++) await top.getByTestId('top-thread-next').click()
    await expect(top).toHaveAttribute('data-thread-id', second)
    const at = Number((await pos.textContent())!.split('/')[0])
    await expect(pill).toHaveAttribute('data-threads', String(n))
    await expect(badge).toHaveAttribute('aria-label', threads(n), { timeout: 20_000 })
    await shot(page, '7-top-before', page.getByTestId('org-detail'))
    const inTop = top.locator(`[data-testid="org-thread"][data-thread-id="${second}"]`)
    await inTop.getByTestId('org-thread-popped-input').click()
    await page.keyboard.type(WORDS, { delay: 10 })
    await inTop.getByTestId('org-thread-popped-send').click()
    // By itself: the next card is on show at the same place, one fewer; the header and the row drop with it.
    await expect(top).not.toHaveAttribute('data-thread-id', second, { timeout: 5_000 })
    await expect(pos).toHaveText(`${Math.min(at, n - 1)} / ${n - 1}`)
    await expect(pill).toHaveAttribute('data-threads', String(n - 1))
    await expect(badge).toHaveAttribute('aria-label', threads(n - 1), { timeout: 20_000 })
    // His reply is still on its way, and the Threads view keeps the card in Working with his words;
    // shown again, the side bar takes the top's place.
    await toggle.click()
    await expect(top).toHaveCount(0, { timeout: 10_000 })
    const file = await (await request.get(`/api/v1/tasks/${ids.owner}/threads`)).json() as { threads: Array<{ id: string; messages: Array<{ text: string; delivery?: { state: string } }> }> }
    expect(file.threads.find((t) => t.id === second)?.messages.find((m) => m.text === WORDS)?.delivery?.state).not.toBe('delivered')
    const working = page.locator('[data-testid="org-thread-group"][data-group="working"]')
    await expect(working).toBeVisible()
    if ((await working.getAttribute('data-open')) !== 'true') await working.getByTestId('org-thread-group-head').click()
    await expect(working.locator(`[data-thread-id="${second}"]`).getByTestId('org-thread-popped-sent-words')).toHaveText(WORDS)
    await expect(page.locator(`[data-testid="org-thread-group"][data-group="needs"] [data-thread-id="${second}"]`)).toHaveCount(0)
    await expect(page.locator(`[data-testid="org-thread-group"][data-group="needs"] [data-thread-id="${first}"]`)).toBeVisible()
    await shot(page, '8-top-after')
    expect(pageErrors).toEqual([])
  } finally {
    await request.put('/api/config', { data: { experimental: { brief_off: was.brief_off === true, top_thread: was.top_thread === true } } })
  }
})
