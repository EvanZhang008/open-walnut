/**
 * The Org page's "Needs you" rows (2026-10-26, the user: "it need to show the task link clickable,
 * just 2 button, quote just quote ... and answer ... answer this button should be rendered
 * differently each time, is it a yes or no, or multiple choice, just render it there"):
 *   - each row is the task's name (a link to it), Quote, Answer and Snooze, nothing else (2026-10-31,
 *     the user: "3 button, quote, answer, and snooze which after click will show snooze until x time")
 *   - Snooze opens the task panel's date picker; a pick writes the task's start date (the task
 *     menu's "Start / Snooze until") and the row reads "Snoozed until <time>" at once
 *   - Answer opens a dropdown shaped by the ask: a live question's options, a decision letter's
 *     actions (two side by side), a Board choice's options, and a line for an ask with no shape
 *   - one pick answers it where it is: the answer reaches the task, and the row stops counting at
 *     once (its session may hand it back a moment later with its next ask: the status is its phase)
 *   - Quote puts the ask in this VP's chat composer, the draft kept after it, never in a Home
 *     column of the same session behind the page
 * The fixture is shared, so this file makes its own project and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Org answers ${STAMP}`
const made: string[] = []
const ids = { lead: '', leadSid: '', q: '', qSid: '', letter: '', choice: '', open: '', words: '', wordsSid: '' }
let cwd = ''

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function post<T>(request: APIRequestContext, url: string, data: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await request.post(url, { data, ...(headers ? { headers } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function createTask(request: APIRequestContext, title: string): Promise<string> {
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })
  made.push(task.id)
  return task.id
}

async function startSession(request: APIRequestContext, taskId: string, message: string, mode?: string): Promise<string> {
  const { sessionId } = await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd, message, taskId, ...(mode ? { mode } : {}) })
  return sessionId
}

/** The task asks the user: its phase says so (the one status counts the phase, src/core/user-status.ts). */
async function needsUser(request: APIRequestContext, id: string): Promise<void> {
  const res = await request.patch(`/api/tasks/${id}`, { data: { phase: 'NEED_ACTION' } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function source(request: APIRequestContext, id: string): Promise<string> {
  return ((await (await request.get(`/api/tasks/${id}`)).json()).task?.user_status?.source ?? '') as string
}

async function historyText(request: APIRequestContext, sid: string): Promise<string> {
  const res = await request.get(`/api/v1/sessions/${sid}/history?tail=80`)
  if (!res.ok()) return ''
  const body = (await res.json()) as { messages?: Array<{ text?: string }> }
  return (body.messages ?? []).map((m) => m.text ?? '').join('\n')
}

async function openTeam(page: Page, homeColumns: readonly string[] = []): Promise<void> {
  await isolateUiPrefs(page)
  if (homeColumns.length) await seedColumns(page, homeColumns)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.getByTestId('org-search').fill(PROJECT)
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${PROJECT} VP`)
}

const alertRow = (page: Page, id: string) => page.locator(`[data-testid="org-alert"][data-task-id="${id}"]`)

/** Watch for the task's row to leave the list on an answer, and what the counts read then. The
 *  session may answer and hand the task back a moment later, which lists it again with its next
 *  ask (the status is the task's phase), so "gone" is checked at the moment it went. */
async function watchRowGone(page: Page, id: string): Promise<() => Promise<{ gone: boolean; counts: string }>> {
  await page.evaluate((taskId) => {
    const w = window as unknown as { __rowGone?: { gone: boolean; counts: string } }
    w.__rowGone = { gone: false, counts: '' }
    const sel = `[data-testid="org-alert"][data-task-id="${taskId}"]`
    const obs = new MutationObserver(() => {
      if (document.querySelector(sel)) return
      w.__rowGone = { gone: true, counts: document.querySelector('[data-testid="org-detail-counts"]')?.textContent ?? '' }
      obs.disconnect()
    })
    obs.observe(document.body, { childList: true, subtree: true })
  }, id)
  return () => page.evaluate(() => (window as unknown as { __rowGone: { gone: boolean; counts: string } }).__rowGone)
}

async function openAnswer(page: Page, id: string, shape: string) {
  const row = alertRow(page, id)
  await expect(row).toBeVisible({ timeout: 60_000 })
  // Three buttons, nothing else.
  await expect(row.locator('button')).toHaveText(['Quote', /^Answer/, /^Snooze/])
  await row.getByTestId('org-alert-answer').click()
  const menu = page.locator(`[data-testid="org-answer-menu"][data-task-id="${id}"]`)
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('data-shape', shape)
  // Inside the window, as every menu is.
  const box = (await menu.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5)
  return menu
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ request }) => {
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  cwd = `${fixtureRoot}/projects/walnut`
  ids.q = await createTask(request, `Pick a stage ${STAMP}`)
  ids.letter = await createTask(request, `Lease ${STAMP}`)
  ids.choice = await createTask(request, `Plan ${STAMP}`)
  ids.open = await createTask(request, `Venue ${STAMP}`)
  ids.words = await createTask(request, `Budget ${STAMP}`)
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })
  ids.lead = contact.task.id
  made.push(ids.lead)
  ids.leadSid = await startSession(request, ids.lead, `Answers lead ready ${STAMP}`)
  // A live question in its session.
  ids.qSid = await startSession(request, ids.q, 'status-permission-test:AskUserQuestion', 'default')
  // A decision letter with two actions.
  const letterSid = await startSession(request, ids.letter, `Lease ready ${STAMP}`)
  const sent = await request.post('/api/v1/human-inbox', {
    headers: { 'x-walnut-caller-sid': letterSid },
    data: { subject: `Sign the lease ${STAMP}?`, type: 'action_required', markdown: 'Pick one.', actions: [{ id: 'sign', label: 'Sign it' }, { id: 'wait', label: 'Not yet' }] },
  })
  expect(sent.status(), await sent.text()).toBe(201)
  // A choice on the VP's Board about one of its project's tasks (not its subtask).
  const board = await request.put(`/api/v1/tasks/${ids.lead}/board`, {
    data: { html: `<h1>Answers</h1><walnut-choice id="plan-${STAMP}" task="${ids.choice}" title="Which plan ${STAMP}?" options="a:Plan A,b:Plan B,c:Plan C" recommended="b"></walnut-choice>`
      + `<walnut-choice id="venue-${STAMP}" task="${ids.open}" title="Where should it be ${STAMP}?"></walnut-choice>` },
  })
  expect(board.ok(), await board.text()).toBe(true)
  // A Board choice says what the task asks; its phase says that it asks (no session moves these two).
  await needsUser(request, ids.choice)
  await needsUser(request, ids.open)
  // An ask in the session's own words (no structure): its session, settled before the page opens.
  ids.wordsSid = await startSession(request, ids.words, `Budget ready ${STAMP}`)
  await expect.poll(() => historyText(request, ids.wordsSid), { timeout: 60_000 }).toContain(`I processed your message: Budget ready ${STAMP}`)
  // The letter's task and this one asked the user when their turn ended.
  await needsUser(request, ids.letter)
  await needsUser(request, ids.words)
  for (const [id, want] of [[ids.letter, 'letter'], [ids.choice, 'choice'], [ids.open, 'choice']] as const) {
    await expect.poll(() => source(request, id), { timeout: 60_000 }).toBe(want)
  }
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${ids.qSid}`)).json()).session?.pendingPermission?.toolName ?? ''),
    { timeout: 90_000 }).toBe('AskUserQuestion')
})

test.afterAll(async ({ request }) => {
  for (const id of made) {
    const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

test('each row is the task\'s name, Quote and Answer; the rows hold still under the pointer; the name opens the task', async ({ page, request }) => {
  await openTeam(page)
  const row = alertRow(page, ids.letter)
  await expect(row.getByTestId('org-alert-link')).toHaveText(`Lease ${STAMP}`, { timeout: 60_000 })
  await expect(row.getByTestId('org-alert-link')).toHaveAttribute('href', `/tasks/${ids.letter}`)
  await expect(row.locator('.org-alert-ask')).toHaveText(`Sign the lease ${STAMP}?`)
  await page.getByTestId('org-alerts').screenshot({ path: `test-results/org-alert-rows-${test.info().project.name}.png` })
  // Under the pointer the rows hold their order: a new ask joins at the end.
  const order = () => page.getByTestId('org-alert').evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id')))
  // Every ask the fixture raised is listed: the letter, two choices, the live question and the
  // task whose turn handed it back (the VP's own is in its chat).
  await expect(page.getByTestId('org-alert')).toHaveCount(5, { timeout: 60_000 })
  await row.getByTestId('org-alert-link').hover()
  const before = await order()
  const late = await createTask(request, `Late ask ${STAMP}`)
  const lateSid = await startSession(request, late, `Late ready ${STAMP}`)
  const sent = await request.post('/api/v1/human-inbox', {
    headers: { 'x-walnut-caller-sid': lateSid },
    data: { subject: `Late question ${STAMP}?`, type: 'action_required', markdown: 'Pick one.', actions: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }] },
  })
  expect(sent.status(), await sent.text()).toBe(201)
  await needsUser(request, late)
  await expect(alertRow(page, late)).toBeVisible({ timeout: 60_000 })
  const after = await order()
  expect(after.slice(0, before.length)).toEqual(before)
  expect(after.indexOf(late)).toBe(before.length)
  await row.getByTestId('org-alert-link').click()
  // A letter's task opens beside the page on its Inbox, the Org page stays.
  await expect(page.getByTestId('org-side')).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/org\?/)
})

test('Snooze opens the date picker; a pick snoozes the task and the row says until when', async ({ page, request }) => {
  const id = await createTask(request, `Snoozable ${STAMP}`)
  await needsUser(request, id)
  await openTeam(page)
  const row = alertRow(page, id)
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.getByTestId('org-alert-snooze').click()
  const menu = page.locator(`[data-testid="org-snooze-menu"][data-task-id="${id}"]`)
  await expect(menu).toBeVisible()
  // Inside the viewport (useMenuPlacement), and the task panel's picker: times, days, a date.
  const box = (await menu.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height)
  await expect(menu.locator('.dp-pill').first()).toBeVisible()
  await expect(menu.locator('input[type="date"]')).toBeVisible()
  const day = menu.locator('.dp-pill[title]').first()
  const date = (await day.getAttribute('title'))!
  await day.click()
  await expect(menu).toHaveCount(0)
  await expect(row.getByTestId('org-alert-snoozed')).toHaveText(/^Snoozed until /)
  await expect(row.locator('button')).toHaveCount(0)
  await expect.poll(async () => (await (await request.get(`/api/tasks/${id}`)).json()).task?.start_date).toBe(date)
  await page.getByTestId('org-alerts').screenshot({ path: `test-results/org-alert-snoozed-${test.info().project.name}.png` })
})

test('a decision letter: its two actions side by side, one click answers it, the row goes at once', async ({ page, request }) => {
  await openTeam(page)
  const counts = page.getByTestId('org-detail-counts')
  await expect(counts).toContainText(/\d+ needs? you/, { timeout: 60_000 })
  const before = Number((await counts.textContent())!.match(/(\d+) needs? you/)![1])
  const menu = await openAnswer(page, ids.letter, 'letter')
  const options = menu.getByTestId('org-answer-letter')
  await expect(options).toHaveClass(/is-pair/)
  await expect(options.getByTestId('org-answer-option')).toHaveText(['Sign it', 'Not yet'])
  await menu.getByTestId('org-answer-note').fill(`Signed ${STAMP}`)
  await page.screenshot({ path: `test-results/org-answer-letter-${test.info().project.name}.png` })
  // The row answers the click, not the server: it goes at once, and a refused answer brings it back
  // with the reason, the dropdown open and the note kept.
  const answerUrl = '**/api/v1/human-inbox/*/answer'
  await page.route(answerUrl, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"refused"}' }))
  const refused = await watchRowGone(page, ids.letter)
  await options.getByTestId('org-answer-option').filter({ hasText: 'Sign it' }).click()
  await expect.poll(async () => (await refused()).gone).toBe(true)
  await expect(menu.getByTestId('org-answer-error')).toHaveText('Not sent. Try again.', { timeout: 15_000 })
  await expect(menu.getByTestId('org-answer-note')).toHaveValue(`Signed ${STAMP}`)
  await page.unroute(answerUrl)
  const gone = await watchRowGone(page, ids.letter)
  await options.getByTestId('org-answer-option').filter({ hasText: 'Sign it' }).click()
  await expect(menu).toHaveCount(0)
  await expect.poll(async () => (await gone()).gone).toBe(true)
  expect((await gone()).counts).not.toContain(`${before} need`)
  // The answer is on record.
  await expect.poll(async () => {
    const res = await request.get('/api/v1/human-inbox')
    const list = ((await res.json()).letters ?? []) as Array<{ subject: string; answered?: { actionId: string; freeText?: string } }>
    return list.find((l) => l.subject === `Sign the lease ${STAMP}?`)?.answered ?? null
  }, { timeout: 30_000 }).toMatchObject({ actionId: 'sign', freeText: `Signed ${STAMP}` })
})

test('a Board choice: its options, the recommended one marked; a pick answers it on that Board', async ({ page, request }) => {
  await openTeam(page)
  const menu = await openAnswer(page, ids.choice, 'choice')
  const options = menu.getByTestId('org-answer-choice')
  await expect(options.getByTestId('org-answer-option')).toHaveText(['Plan A', 'Plan B', 'Plan C'], { timeout: 30_000 })
  await expect(options.locator('[data-value="b"]')).toHaveClass(/btn-primary/)
  // The question shows above its options (a clamped line once collapsed to nothing in WebKit).
  await expect(menu.locator('.org-answer-q')).toHaveText(`Which plan ${STAMP}?`)
  await expect(menu.locator('.org-answer-q')).toBeVisible()
  expect((await menu.locator('.org-answer-q').boundingBox())!.height).toBeGreaterThan(10)
  await page.screenshot({ path: `test-results/org-answer-choice-${test.info().project.name}.png` })
  const gone = await watchRowGone(page, ids.choice)
  await options.locator('[data-value="c"]').click()
  await expect(menu).toHaveCount(0)
  await expect.poll(async () => (await gone()).gone).toBe(true)
  await expect.poll(async () => ((await (await request.get(`/api/v1/tasks/${ids.lead}/board`)).json()).choices?.[`plan-${STAMP}`]?.option ?? ''),
    { timeout: 30_000 }).toBe('c')
})

test('a Board choice with no options: a line, answered on that Board', async ({ page, request }) => {
  await openTeam(page)
  const menu = await openAnswer(page, ids.open, 'choice')
  await expect(menu.locator('.org-answer-q')).toHaveText(`Where should it be ${STAMP}?`, { timeout: 30_000 })
  await expect(menu.getByTestId('org-answer-option')).toHaveCount(0)
  const input = menu.getByTestId('org-answer-input')
  await expect(input).toBeFocused()
  await input.fill(`The river hall ${STAMP}`)
  const gone = await watchRowGone(page, ids.open)
  await input.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect.poll(async () => (await gone()).gone).toBe(true)
  await expect.poll(async () => ((await (await request.get(`/api/v1/tasks/${ids.lead}/board`)).json()).choices?.[`venue-${STAMP}`]?.text ?? ''),
    { timeout: 30_000 }).toBe(`The river hall ${STAMP}`)
})

test('a live question: its own options, answered in place, and the session hears the pick', async ({ page, request }) => {
  await openTeam(page)
  const menu = await openAnswer(page, ids.q, 'prompt')
  await expect(menu.locator('.nfc-answer')).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: `test-results/org-answer-question-${test.info().project.name}.png` })
  await menu.locator('.nfc-answer-opt', { hasText: 'Staging' }).click()
  const gone = await watchRowGone(page, ids.q)
  await menu.getByRole('button', { name: 'Submit' }).click()
  await expect(menu).toHaveCount(0)
  await expect.poll(async () => (await gone()).gone).toBe(true)
  await expect.poll(() => historyText(request, ids.qSid), { timeout: 60_000 }).toContain('AskUserQuestion decision received: Staging')
})

test('an ask with no shape: a line, sent to that task\'s session', async ({ page, request }) => {
  // The session's own words are the one ask the fixture cannot raise for real (the mock CLI
  // reports nothing): the task list the page loads carries them, as a server would after a report.
  await page.route('**/api/tasks?*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const body = await res.json() as { tasks?: Array<Record<string, unknown>> }
    for (const t of body.tasks ?? []) {
      // Only the words: the task's own state stays the server's (its phase), so an answer moves it.
      const st = t.user_status as { state?: string } | undefined
      if (t.id === ids.words && st?.state === 'needs') t.user_status = { ...st, source: 'session', ask: `How much can it spend ${STAMP}?` }
    }
    await route.fulfill({ response: res, json: body })
  })
  await openTeam(page)
  const menu = await openAnswer(page, ids.words, 'words')
  await expect(menu.locator('.org-answer-q')).toHaveText(`How much can it spend ${STAMP}?`)
  const input = menu.getByTestId('org-answer-input')
  await expect(input).toBeFocused()
  await input.fill(`Up to 40 dollars ${STAMP}`)
  await page.screenshot({ path: `test-results/org-answer-words-${test.info().project.name}.png` })
  const gone = await watchRowGone(page, ids.words)
  await input.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect.poll(async () => (await gone()).gone).toBe(true)
  await expect.poll(() => historyText(request, ids.wordsSid), { timeout: 60_000 }).toContain(`Up to 40 dollars ${STAMP}`)
})

test('Quote puts the ask in this VP\'s chat, ahead of what was typed, not in its Home column', async ({ page, request }) => {
  // Answered in the test before: it asks again.
  await needsUser(request, ids.words)
  await expect.poll(async () => ((await (await request.get(`/api/tasks/${ids.words}`)).json()).task?.user_status?.state ?? ''), { timeout: 30_000 }).toBe('needs')
  await page.route('**/api/tasks?*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const body = await res.json() as { tasks?: Array<Record<string, unknown>> }
    for (const t of body.tasks ?? []) {
      // Only the words: the task's own state stays the server's (its phase), so an answer moves it.
      const st = t.user_status as { state?: string } | undefined
      if (t.id === ids.words && st?.state === 'needs') t.user_status = { ...st, source: 'session', ask: `Quote me ${STAMP}` }
    }
    await route.fulfill({ response: res, json: body })
  })
  // The same session is open in a Home column too: it stays mounted behind the Org page.
  await openTeam(page, [ids.leadSid])
  const homeComposer = page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.leadSid}"] .chat-input-textarea`)
  await expect(homeComposer).toHaveCount(1)
  // From another tab: Quote opens the chat first.
  await page.getByTestId('org-tab-team').click()
  const composer = () => page.locator(`[data-testid="org-chat"] .session-panel[data-session-id="${ids.leadSid}"] .chat-input-textarea`)
  await alertRow(page, ids.words).getByTestId('org-alert-quote').click()
  await expect(page.getByTestId('org-tab-chat')).toHaveAttribute('aria-selected', 'true')
  await expect(composer()).toHaveValue(new RegExp(`^> Budget ${STAMP}: Quote me ${STAMP}`), { timeout: 30_000 })
  await expect(homeComposer).toHaveValue('')
  // Typed words stay after a second quote of the same row.
  await composer().press('End')
  await composer().pressSequentially(' and why')
  await alertRow(page, ids.words).getByTestId('org-alert-quote').click()
  await expect(composer()).toHaveValue(/and why$/)
  await expect(composer()).toBeFocused()
})
