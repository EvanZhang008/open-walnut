/**
 * Action needed in three places, one record (experiment action_needed_everywhere; 2026-11-19, the
 * user: "我点进去之后，如果它有 needs you，它直接就能显示在……title bar，或者在下面", and "thread 里面
 * 也可以加……这些 task 本身的……需要我 make decision 的"): a task's row, the strip under its session's
 * title bar, and its VP's Threads ("From your team"). Each item is answered in one of them and goes
 * from the other two:
 *   - a decision letter answered in the VP's Threads: gone from its row and its session's strip
 *   - an approval approved in the session's strip: gone from its row and the Threads
 *   - the session's own live question: the strip points at its card below, never a second answer;
 *     answered on the row, it leaves the strip and the Threads
 *   - three asks: the strip shows the first two and "1 more"; a snooze in one place reads in the
 *     others, and an unsnooze elsewhere is not held back by a place's own earlier snooze
 *   - a reply typed on the row (the thread card's own words box) answers a letter: its task gets
 *     the words, and the item leaves the strip and the Threads
 *   - the switch off: no strip and no "From your team"
 * Real: the fixture server, the mock CLI's prompt, the approvals and inbox routes, the status sync.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { holdApprovalsLock } from './approvals-lock'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { endRunningTurn, presetPanelDesign, setStatusSectionOpen, showSectionCard, startRunningTurn } from './status-section-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Everywhere ${STAMP}`
const FLAG = 'action_needed_everywhere'
const made: string[] = []
const ids = { lead: '', approval: '', approvalSid: '', question: '', questionSid: '', letter: '', letterSid: '', letterId: '' }
let cwd = ''
let flagsBefore: Record<string, boolean> | null = null

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({ viewport: { width: 1280, height: 900 }, video: process.env.PW_VIDEO ? 'on' : 'off' })
holdApprovalsLock('file')

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

async function setFlag(request: APIRequestContext, on: boolean): Promise<void> {
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  const now = { ...(cfg.config?.experimental ?? {}) }
  if (flagsBefore === null) flagsBefore = { ...now }
  const res = await request.put('/api/config', { data: { experimental: { ...now, [FLAG]: on } } })
  expect(res.ok(), await res.text()).toBe(true)
}

type Status = { state?: string; actions?: Array<{ kind: string; id: string }> }
async function statusOf(request: APIRequestContext, id: string): Promise<Status> {
  return ((await (await request.get(`/api/tasks/${id}`)).json()).task?.user_status ?? {}) as Status
}
const kinds = async (request: APIRequestContext, id: string) => (await statusOf(request, id)).actions?.map((a) => a.kind).join(',') ?? ''

const line = (scope: Locator, kind: string) => scope.locator(`[data-testid="action-item"][data-kind="${kind}"]`)
const panelOf = (page: Page, sid: string) => page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
const stripOf = (page: Page, sid: string) => panelOf(page, sid).getByTestId('session-action-needed')
const teamCard = (page: Page, id: string) => page.locator(`[data-testid="team-actions-task"][data-task-id="${id}"]`)

async function openHome(page: Page, sid: string): Promise<void> {
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await seedColumns(page, [sid])
  await loadHome(page)
  await setStatusSectionOpen(page, 'needs', true)
  await expect(panelOf(page, sid)).toBeVisible({ timeout: 30_000 })
}

async function toThreads(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.getByTestId('org-search').fill(PROJECT)
  await page.locator(`[data-testid="org-channel"][data-key="project:${PROJECT.trim().toLowerCase()}"]`).click()
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${PROJECT} VP`)
  // A lead opens on its Threads.
  if ((await page.getByTestId('org-top-threads').getAttribute('aria-pressed')) !== 'true') await page.getByTestId('org-top-threads').click()
  await expect(page.getByTestId('org-threads')).toBeVisible()
}

async function toHome(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Home', exact: true }).first().click()
  await expect(page.locator('.main-page-session-column').first()).toBeVisible({ timeout: 30_000 })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(420_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks, approvals and settings: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  cwd = `${fixtureRoot}/projects/walnut`
  await setFlag(request, true)
  ids.approval = await createTask(request, `Ship the build ${STAMP}`)
  ids.question = await createTask(request, `Choose a target ${STAMP}`)
  ids.letter = await createTask(request, `Lease terms ${STAMP}`)
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })
  ids.lead = contact.task.id
  made.push(ids.lead)
  ids.approvalSid = await startRunningTurn(request, ids.approval)
  ids.questionSid = await startSession(request, ids.question, 'status-permission-test:AskUserQuestion', 'default')
  ids.letterSid = await startSession(request, ids.letter, `Lease ready ${STAMP}`)
  const sent = await request.post('/api/v1/human-inbox', {
    headers: { 'x-walnut-caller-sid': ids.letterSid },
    data: { subject: `Sign the lease ${STAMP}?`, type: 'action_required', user_kind: 'user_own', user_kind_why: 'The spec plays a decision only the user makes', markdown: 'Pick one.', actions: [{ id: 'sign', label: 'Sign it' }, { id: 'wait', label: 'Not yet' }] },
  })
  expect(sent.status(), await sent.text()).toBe(201)
  ids.letterId = ((await sent.json()) as { id: string }).id
  await expect.poll(() => kinds(request, ids.question), { timeout: 90_000 }).toBe('question')
  await expect.poll(() => kinds(request, ids.letter), { timeout: 60_000 }).toBe('letter')
})

test.afterAll(async ({ request }) => {
  if (flagsBefore) await request.put('/api/config', { data: { experimental: flagsBefore } })
  if (ids.approvalSid) await endRunningTurn(request, ids.approvalSid)
  for (const id of made) {
    const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

test('a letter answered in the VP\'s Threads leaves its row and its session\'s strip', async ({ page, request }) => {
  await openHome(page, ids.letterSid)
  const card = await showSectionCard(page, 'needs', ids.letter)
  await expect(line(card, 'letter').getByRole('button', { name: 'Sign it' })).toBeVisible({ timeout: 30_000 })
  const strip = stripOf(page, ids.letterSid)
  await expect(line(strip, 'letter').getByRole('button', { name: 'Sign it' })).toBeVisible()
  // The strip sits under the title bar, above the chat.
  const header = (await panelOf(page, ids.letterSid).locator('.session-panel-header').boundingBox())!
  const box = (await strip.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height - 1)
  expect(box.y).toBeLessThan(header.y + header.height + 80)

  await toThreads(page)
  const team = teamCard(page, ids.letter)
  await expect(page.getByTestId('team-actions')).toContainText('From your team')
  await expect(team).toContainText(`Lease terms ${STAMP}`)
  await line(team, 'letter').getByRole('button', { name: 'Sign it' }).click()
  await expect(team).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(async () => ((await (await request.get(`/api/v1/human-inbox/${ids.letterId}`)).json()).letter?.answered?.actionId ?? ''), { timeout: 30_000 }).toBe('sign')

  await toHome(page)
  await expect(stripOf(page, ids.letterSid)).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator(`[data-testid="action-needed"][data-action-task="${ids.letter}"]`)).toHaveCount(0)
})

test('an approval approved in the session\'s strip leaves its row and the Threads', async ({ page, request }) => {
  await openHome(page, ids.approvalSid)
  const asked = await post<{ approval: { id: string }; waitToken: string }>(request, '/api/v1/approvals',
    { what: `Deploy build 1182 to staging ${STAMP}`, cwd, command: 'deploy.sh' }, { 'x-walnut-caller-sid': ids.approvalSid })
  await expect.poll(() => kinds(request, ids.approval), { timeout: 30_000 }).toBe('approval')
  const card = await showSectionCard(page, 'needs', ids.approval)
  await expect(line(card, 'approval')).toBeVisible()
  const strip = stripOf(page, ids.approvalSid)
  await expect(line(strip, 'approval').getByTestId('action-summary')).toHaveText(`Deploy build 1182 to staging ${STAMP}`)
  await line(strip, 'approval').getByRole('button', { name: 'Approve' }).click()
  const waited = await post<{ approval: { status: string } }>(request, `/api/v1/approvals/${asked.approval.id}/wait`, { token: asked.waitToken, wait_ms: 10_000 })
  expect(waited.approval.status).toBe('approved')
  await expect(strip).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator(`[data-testid="action-needed"][data-action-task="${ids.approval}"]`)).toHaveCount(0, { timeout: 30_000 })
  await toThreads(page)
  await expect(teamCard(page, ids.question)).toBeVisible({ timeout: 30_000 })
  await expect(teamCard(page, ids.approval)).toHaveCount(0)
})

test('the session\'s own question points at its card below; answered on the row, it leaves the strip and the Threads', async ({ page, request }) => {
  await openHome(page, ids.questionSid)
  const strip = stripOf(page, ids.questionSid)
  const item = line(strip, 'question')
  // One answer per panel: the strip names it and points below, the chat's card answers it.
  await expect(item.getByTestId('action-summary')).toContainText('Which validation target?')
  await expect(item.locator('.nfc-answer-opt')).toHaveCount(0)
  await item.getByTestId('action-answer-below').click()
  const promptCard = panelOf(page, ids.questionSid).locator('[data-prompt-pending="true"]')
  await expect(promptCard).toBeInViewport({ timeout: 10_000 })

  await toThreads(page)
  await expect(teamCard(page, ids.question)).toBeVisible({ timeout: 30_000 })
  await toHome(page)
  const card = await showSectionCard(page, 'needs', ids.question)
  const row = line(card, 'question')
  await row.locator('.nfc-answer-opt', { hasText: 'Local' }).click()
  await row.getByRole('button', { name: 'Submit' }).click()
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${ids.questionSid}`)).json()).session?.pendingPermission ?? null), { timeout: 30_000 }).toBeNull()
  await expect(stripOf(page, ids.questionSid)).toHaveCount(0, { timeout: 30_000 })
  await toThreads(page)
  await expect(teamCard(page, ids.question)).toHaveCount(0, { timeout: 30_000 })
})

async function sendLetter(request: APIRequestContext, subject: string, actions: Array<{ id: string; label: string }>): Promise<string> {
  const sent = await request.post('/api/v1/human-inbox', {
    headers: { 'x-walnut-caller-sid': ids.letterSid },
    data: { subject, type: 'action_required', user_kind: 'user_own', user_kind_why: 'The spec plays a decision only the user makes', markdown: 'Pick one.', actions },
  })
  expect(sent.status(), await sent.text()).toBe(201)
  return ((await sent.json()) as { id: string }).id
}

test('three asks: the strip shows the first two and "1 more"; a snooze in the strip greys the row too, an unsnooze on the row brings the strip back', async ({ page, request }) => {
  const renew = await sendLetter(request, `Renew it ${STAMP}?`, [{ id: 'yes', label: 'Renew' }, { id: 'no', label: 'Let it end' }])
  await sendLetter(request, `Paint the hall ${STAMP}?`, [{ id: 'white', label: 'White' }, { id: 'grey', label: 'Grey' }])
  await sendLetter(request, `Keep the keys ${STAMP}?`, [{ id: 'keep', label: 'Keep' }, { id: 'give', label: 'Give back' }])
  await expect.poll(() => kinds(request, ids.letter), { timeout: 60_000 }).toBe('letter,letter,letter')
  await openHome(page, ids.letterSid)
  const strip = stripOf(page, ids.letterSid)
  await expect(strip.getByTestId('action-item')).toHaveCount(2)
  await expect(strip.getByTestId('action-needed-more')).toHaveText('1 more')
  await strip.getByTestId('action-needed-more').click()
  await expect(strip.getByTestId('action-item')).toHaveCount(3)
  await expect(strip.getByTestId('action-needed-more')).toHaveText('Show fewer')

  // Snooze the first in the strip: the row shows it snoozed as well (the same item).
  const first = strip.getByTestId('action-item').first()
  const firstId = (await first.getAttribute('data-item-id'))!
  await first.getByTestId('action-snooze').click()
  await page.locator('.snooze-row[data-snooze="one-hour"]').click()
  await expect(first.getByTestId('action-snoozed-until')).toContainText('Snoozed until', { timeout: 15_000 })
  const card = await showSectionCard(page, 'needs', ids.letter)
  const onRow = card.locator(`[data-testid="action-item"][data-item-id="${firstId}"]`)
  await expect(onRow.getByTestId('action-snoozed-until')).toContainText('Snoozed until', { timeout: 30_000 })
  // Unsnooze it on the row: the strip's line is back too, not held by its own earlier snooze.
  await onRow.getByTestId('action-unsnooze').click()
  await expect(strip.locator(`[data-testid="action-item"][data-item-id="${firstId}"]`).getByTestId('action-snooze')).toBeVisible({ timeout: 30_000 })
  await expect(strip.locator(`[data-testid="action-item"][data-item-id="${firstId}"]`).getByTestId('action-snoozed-until')).toHaveCount(0)
  expect(renew).toBeTruthy()
})

test('a reply typed on the row answers the letter: its task gets the words, and it leaves the strip and the Threads', async ({ page, request }) => {
  await openHome(page, ids.letterSid)
  const card = await showSectionCard(page, 'needs', ids.letter)
  const item = card.locator('[data-testid="action-item"][data-kind="letter"]', { hasText: `Paint the hall ${STAMP}?` })
  const itemId = (await item.getAttribute('data-item-id'))!
  const strip = stripOf(page, ids.letterSid)
  await strip.getByTestId('action-needed-more').click().catch(() => {})
  await expect(strip.locator(`[data-item-id="${itemId}"]`)).toBeVisible()
  // The same "Reply…" box a thread card answers with.
  await item.getByTestId('org-answer-other').click()
  const words = `Neither: keep it the colour it is now ${STAMP}`
  await item.getByTestId('org-answer-input').fill(words)
  await item.getByTestId('org-answer-send').click()
  await expect(card.locator(`[data-item-id="${itemId}"]`)).toHaveCount(0, { timeout: 30_000 })
  await expect(strip.locator(`[data-item-id="${itemId}"]`)).toHaveCount(0, { timeout: 30_000 })
  // The task's session gets his words, and the letter no longer waits on him.
  await expect.poll(async () => {
    const res = await request.get(`/api/v1/sessions/${ids.letterSid}/history?tail=80`)
    return ((await res.json()) as { messages?: Array<{ text?: string }> }).messages?.map((m) => m.text ?? '').join('\n') ?? ''
  }, { timeout: 60_000 }).toContain(words)
  await expect.poll(async () => ((await statusOf(request, ids.letter)).actions ?? []).some((a) => a.id === itemId), { timeout: 30_000 }).toBe(false)
  await toThreads(page)
  await expect(page.locator(`[data-testid="team-actions-task"][data-task-id="${ids.letter}"] [data-item-id="${itemId}"]`)).toHaveCount(0)
})

test('the switch off: no strip and no "From your team"', async ({ page, request }) => {
  await setFlag(request, false)
  await openHome(page, ids.letterSid)
  const card = await showSectionCard(page, 'needs', ids.letter)
  await expect(card.getByRole('button', { name: 'Renew', exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(stripOf(page, ids.letterSid)).toHaveCount(0)
  await toThreads(page)
  await expect(page.getByTestId('team-actions')).toHaveCount(0)
  await setFlag(request, true)
})
