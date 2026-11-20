/**
 * Action needed on Home's task rows (web/src/components/actions/ActionNeeded.tsx, core/action-needed.ts;
 * 2026-11-19, the user: "会在这个 task 的 panel 上面……显示一个 approval, action needed……我就可以直接
 * 在那里面 approve, make decision", and "这个东西本身 snooze……snooze until"):
 *   - an approval its session asked for: the row is under Needs you, still says Working while its
 *     turn runs, shows "Approval" and what it asks, and Approve there reaches the asker's wait;
 *     Home's one approvals line no longer counts it
 *   - a live AskUserQuestion: its options on the row; a pick answers the session's prompt
 *   - a decision letter: its actions on the row; a pick answers the letter
 *   - Snooze on a line: the line greys out with its time, the task leaves Needs you; Unsnooze brings
 *     it back; a snooze that runs out brings it back by itself
 * Real: the fixture server, the mock CLI's prompt, the approvals and inbox routes, the status sync.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { holdApprovalsLock } from './approvals-lock'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { asksOf, endRunningTurn, presetPanelDesign, setStatusSectionOpen, showSectionCard, startRunningTurn } from './status-section-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Action needed ${STAMP}`
const made: string[] = []
const ids = { approval: '', approvalSid: '', question: '', questionSid: '', letter: '', letterSid: '', letterId: '' }
let cwd = ''

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

type Status = { state?: string; working?: boolean; actions?: Array<{ kind: string; id: string; snoozedUntil?: string }> }
async function statusOf(request: APIRequestContext, id: string): Promise<Status> {
  return ((await (await request.get(`/api/tasks/${id}`)).json()).task?.user_status ?? {}) as Status
}
const kinds = async (request: APIRequestContext, id: string) => (await statusOf(request, id)).actions?.map((a) => a.kind).join(',') ?? ''

async function openHome(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await loadHome(page)
  await setStatusSectionOpen(page, 'needs', true)
}

const block = (card: Locator) => asksOf(card).getByTestId('action-needed')
const line = (card: Locator, kind: string) => asksOf(card).locator(`[data-testid="action-item"][data-kind="${kind}"]`)

test.beforeAll(async ({ request }) => {
  test.setTimeout(420_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks and approvals: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  cwd = `${fixtureRoot}/projects/walnut`
  ids.approval = await createTask(request, `Push the release ${STAMP}`)
  ids.question = await createTask(request, `Pick a target ${STAMP}`)
  ids.letter = await createTask(request, `Bucket policy ${STAMP}`)
  // A turn that runs: the approval is asked while the task works.
  ids.approvalSid = await startRunningTurn(request, ids.approval)
  // A live question in its session (the mock CLI's AskUserQuestion: Staging / Local).
  ids.questionSid = await startSession(request, ids.question, 'status-permission-test:AskUserQuestion', 'default')
  // A decision letter with two actions, from its task's session.
  ids.letterSid = await startSession(request, ids.letter, `Bucket ready ${STAMP}`)
  const sent = await request.post('/api/v1/human-inbox', {
    headers: { 'x-walnut-caller-sid': ids.letterSid },
    data: { subject: `Pick the bucket policy ${STAMP}`, type: 'action_required', user_kind: 'user_own', user_kind_why: 'The spec plays a decision only the user makes', markdown: 'Pick one.', actions: [{ id: 'prefix', label: 'Prefix only' }, { id: 'whole', label: 'Whole bucket' }] },
  })
  expect(sent.status(), await sent.text()).toBe(201)
  ids.letterId = ((await sent.json()) as { id: string }).id
  await expect.poll(() => kinds(request, ids.question), { timeout: 90_000 }).toBe('question')
  await expect.poll(() => kinds(request, ids.letter), { timeout: 60_000 }).toBe('letter')
})

test.afterAll(async ({ request }) => {
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

/** How many approvals Needs you's one line counts (0 when it has none): approvals no row shows. */
async function approvalsLineCount(page: Page): Promise<number> {
  const summary = page.locator('.status-section-block-needs [data-testid="approval-summary"] .approval-row-what')
  if (!(await summary.count())) return 0
  const m = /^(\d+) approvals? waiting$/.exec((await summary.first().textContent())?.trim() ?? '')
  return m ? Number(m[1]) : -1
}

test('an approval asked while the task works: Needs you, still Working, approved from the row', async ({ page, request }) => {
  await openHome(page)
  const asked = await post<{ approval: { id: string }; waitToken: string }>(request, '/api/v1/approvals',
    { what: `Push commit d0f4f51 to origin main ${STAMP}`, cwd, command: 'git push' }, { 'x-walnut-caller-sid': ids.approvalSid })
  await expect.poll(() => kinds(request, ids.approval), { timeout: 30_000 }).toBe('approval')
  expect(await statusOf(request, ids.approval)).toMatchObject({ state: 'needs', working: true })

  const card = await showSectionCard(page, 'needs', ids.approval)
  await expect(block(card)).toBeVisible()
  await expect(card.getByTestId('status-card-also-working')).toHaveText('Working')
  const item = line(card, 'approval')
  await expect(item).toHaveAttribute('data-kind', 'approval')
  await expect(item.getByTestId('action-summary')).toHaveText(`Push commit d0f4f51 to origin main ${STAMP}`)
  // The one approvals line counts only approvals no row shows: those of no task (another spec's
  // may be pending too), never this one.
  const noTask = async () => {
    const list = ((await (await request.get('/api/v1/approvals')).json()) as { approvals?: Array<{ id: string; requester?: { taskId?: string } }> }).approvals ?? []
    return list.filter((a) => a.id !== asked.approval.id && !a.requester?.taskId).length
  }
  await expect.poll(async () => (await approvalsLineCount(page)) === (await noTask()), { timeout: 15_000 }).toBe(true)
  // The row lists it with its buttons: the corner's card keeps its short form, so it never covers the row at full size.
  // In sight, clear of the corner (a row under the corner card is not in sight).
  await item.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await expect(page.locator(`[data-testid="corner-stack"] [data-testid="approval-card"][data-approval-id="${asked.approval.id}"]`)).toHaveClass(/approval-card-line/, { timeout: 15_000 })
  await page.screenshot({ path: `test-results/action-needed-approval-${test.info().project.name}.png`, clip: (await item.boundingBox())! })

  // A click inside the block answers; it never opens the row's task.
  await item.getByRole('button', { name: 'Approve' }).click()
  const waited = await post<{ approval: { status: string } }>(request, `/api/v1/approvals/${asked.approval.id}/wait`, { token: asked.waitToken, wait_ms: 10_000 })
  expect(waited.approval.status).toBe('approved')
  await expect(line(card, 'approval')).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(async () => (await statusOf(request, ids.approval)).state, { timeout: 30_000 }).toBe('working')
})

test('a live question: its options on the row, a pick answers the session', async ({ page, request }) => {
  await openHome(page)
  const card = await showSectionCard(page, 'needs', ids.question)
  const item = line(card, 'question')
  await expect(item).toHaveAttribute('data-kind', 'question')
  // The prompt's own card says its question (no second summary line).
  await expect(item).toContainText('Which validation target?')
  await expect(item.getByTestId('action-summary')).toHaveCount(0)
  await item.locator('.nfc-answer-opt', { hasText: 'Staging' }).click()
  await item.getByRole('button', { name: 'Submit' }).click()
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${ids.questionSid}`)).json()).session?.pendingPermission ?? null), { timeout: 30_000 }).toBeNull()
  await expect.poll(async () => {
    const res = await request.get(`/api/v1/sessions/${ids.questionSid}/history?tail=80`)
    return ((await res.json()) as { messages?: Array<{ text?: string }> }).messages?.map((m) => m.text ?? '').join('\n') ?? ''
  }, { timeout: 60_000 }).toContain('AskUserQuestion decision received: Staging')
  await expect.poll(() => kinds(request, ids.question), { timeout: 30_000 }).not.toContain('question')
})

test('a decision letter: its actions on the row; Snooze takes it off Needs you and back; a pick answers it', async ({ page, request }) => {
  await openHome(page)
  let card = await showSectionCard(page, 'needs', ids.letter)
  const item = line(card, 'letter')
  await expect(item).toHaveAttribute('data-kind', 'letter')
  await expect(item.getByTestId('action-summary')).toHaveText(`Pick the bucket policy ${STAMP}`)
  await expect(item.getByRole('button', { name: 'Prefix only' })).toBeVisible({ timeout: 30_000 })
  await expect(item.getByRole('button', { name: 'Whole bucket' })).toBeVisible()

  // Snooze ▾ → In 1 hour: the line greys out with its time, the task leaves Needs you.
  await item.getByTestId('action-snooze').click()
  await page.locator('.snooze-row[data-snooze="one-hour"]').click()
  await expect(item.getByTestId('action-snoozed-until')).toContainText('Snoozed until', { timeout: 15_000 })
  await expect.poll(async () => (await statusOf(request, ids.letter)).state, { timeout: 30_000 }).toBe('waiting')
  await expect(page.locator(`[data-testid="status-section-needs-rows"] [data-task-id="${ids.letter}"]`)).toHaveCount(0, { timeout: 30_000 })

  // A snooze that runs out brings it back by itself (the API's own snooze, a few seconds long).
  const soon = new Date(Date.now() + 6_000).toISOString()
  const res = await request.put(`/api/v1/tasks/${ids.letter}/actions/${ids.letterId}/snooze`, { data: { until: soon } })
  expect(res.ok(), await res.text()).toBe(true)
  await expect.poll(async () => (await statusOf(request, ids.letter)).state, { timeout: 120_000, intervals: [2_000] }).toBe('needs')
  card = await showSectionCard(page, 'needs', ids.letter)

  // Snooze again and Unsnooze from the row.
  await line(card, 'letter').getByTestId('action-snooze').click()
  await page.locator('.snooze-row[data-snooze="three-hours"]').click()
  await expect.poll(async () => (await statusOf(request, ids.letter)).state, { timeout: 30_000 }).toBe('waiting')
  await setStatusSectionOpen(page, 'waiting', true)
  card = await showSectionCard(page, 'waiting', ids.letter)
  await line(card, 'letter').getByTestId('action-unsnooze').click()
  await expect.poll(async () => (await statusOf(request, ids.letter)).state, { timeout: 30_000 }).toBe('needs')

  // A pick answers the letter.
  card = await showSectionCard(page, 'needs', ids.letter)
  await line(card, 'letter').getByRole('button', { name: 'Prefix only' }).click()
  await expect.poll(async () => ((await (await request.get(`/api/v1/human-inbox/${ids.letterId}`)).json()).letter?.answered?.actionId ?? ''), { timeout: 30_000 }).toBe('prefix')
  await expect.poll(() => kinds(request, ids.letter), { timeout: 30_000 }).not.toContain('letter')
})
