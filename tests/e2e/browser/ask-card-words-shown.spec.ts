/**
 * Every kind of thing a task asks shows its words box at once (2026-11-20, the user: "Why the fuck i
 * need to clcik reply, reply is so rugly, Can it jsut show inbox and I can tuype?", and "every one
 * shows that box directly"). One task per kind, each on its row in Needs you: the box to type in is
 * there with no click, and no "Reply…" opener is anywhere in the block. GUARDED names the kinds this
 * spec plays; tests/web/ask-card-words-guard.test.ts fails on a kind it does not.
 *
 * The card's layout is checked here too: a wide column keeps the buttons and Snooze beside the box;
 * a narrow one puts them on the line below (the user: "最后一行就显示……snooze……或者说那个可以和
 * input box 放一行也可以，就说不要显得那么的拥挤").
 * Real: the fixture server, the mock CLI's prompts, the approvals, inbox, Board and report routes.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { holdApprovalsLock } from './approvals-lock'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { endRunningTurn, presetPanelDesign, setStatusSectionOpen, showSectionCard, startRunningTurn } from './status-section-helpers'

/** The kinds this spec plays: every ActionKind (the guard test reads this list). */
export const GUARDED = ['approval', 'question', 'permission', 'letter', 'choice', 'ask'] as const

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Words shown ${STAMP}`
const made: string[] = []
const ids: Record<(typeof GUARDED)[number], string> = { approval: '', question: '', permission: '', letter: '', choice: '', ask: '' }
let approvalSid = ''
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
const kindsOf = async (request: APIRequestContext, id: string) =>
  (((await (await request.get(`/api/tasks/${id}`)).json()).task?.user_status?.actions ?? []) as Array<{ kind: string }>).map((a) => a.kind).join(',')

const itemOf = (card: Locator, kind: string) => card.locator(`[data-testid="action-item"][data-kind="${kind}"]`)
/** The box to type in: the shared words box, or a question card's own "Other…" line. */
const wordsOf = (item: Locator) => item.locator('[data-testid="org-answer-input"], .nfc-answer-input').first()

async function openNeeds(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await loadHome(page)
  await setStatusSectionOpen(page, 'needs', true)
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(420_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks, approvals and letters: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  cwd = `${fixtureRoot}/projects/walnut`
  for (const kind of GUARDED) ids[kind] = await createTask(request, `${kind} ${STAMP}`)
  // An approval its running session asked.
  approvalSid = await startRunningTurn(request, ids.approval)
  await post(request, '/api/v1/approvals', { what: `Deploy build 1182 to staging ${STAMP}`, cwd, command: 'deploy.sh' }, { 'x-walnut-caller-sid': approvalSid })
  // A session's live question and a tool step it waits on (`default`: the fixture's mode would allow it).
  await startSession(request, ids.question, 'status-permission-test:AskUserQuestion', 'default')
  await startSession(request, ids.permission, 'status-permission-test:Bash', 'default')
  // A decision letter.
  const letterSid = await startSession(request, ids.letter, `Lease ready ${STAMP}`)
  const sent = await request.post('/api/v1/human-inbox', {
    headers: { 'x-walnut-caller-sid': letterSid },
    data: { subject: `Sign the lease ${STAMP}?`, type: 'action_required', user_kind: 'user_own', user_kind_why: 'The spec plays a decision only the user makes', markdown: 'The landlord sent the final terms. Rent stays the same.', actions: [{ id: 'sign', label: 'Sign it' }, { id: 'wait', label: 'Not yet' }] },
  })
  expect(sent.status(), await sent.text()).toBe(201)
  // A choice on its VP's Board.
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })
  made.push(contact.task.id)
  const board = await request.put(`/api/v1/tasks/${contact.task.id}/board`, {
    data: { html: `<h1>Answers</h1><walnut-choice id="plan-${STAMP}" task="${ids.choice}" title="Which plan ${STAMP}?" options="a:Plan A,b:Plan B"></walnut-choice>` },
  })
  expect(board.ok(), await board.text()).toBe(true)
  expect((await request.patch(`/api/tasks/${ids.choice}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  // An ask in its session's words, with its yes / no.
  const askSid = await startSession(request, ids.ask, `Budget ready ${STAMP}`)
  expect(askSid).toBeTruthy()
  // Its turn ends first, so its own turn-end report cannot overwrite the ask below.
  await expect.poll(async () => ((await (await request.get(`/api/v1/sessions/${askSid}/history?tail=80`)).json()) as { messages?: Array<{ text?: string }> }).messages?.map((m) => m.text ?? '').join('\n') ?? '', { timeout: 90_000 }).toContain(`Budget ready ${STAMP}`)
  expect((await request.patch(`/api/tasks/${ids.ask}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  const asked = await request.put(`/api/v1/tasks/${ids.ask}/report`, { data: { state: 'needs', ask: `Raise the budget to 400 ${STAMP}?`, ask_kind: 'yes_no', ask_more: 'The venue costs 380 now; 400 leaves a little room.' } })
  expect(asked.ok(), await asked.text()).toBe(true)
  for (const kind of GUARDED) await expect.poll(() => kindsOf(request, ids[kind]), { timeout: 90_000, message: kind }).toContain(kind)
})

test.afterAll(async ({ request }) => {
  if (approvalSid) await endRunningTurn(request, approvalSid)
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

test('every kind shows its box to type in, with no click and no "Reply…"', async ({ page }) => {
  await openNeeds(page)
  for (const kind of GUARDED) {
    const card = await showSectionCard(page, 'needs', ids[kind])
    const item = itemOf(card, kind)
    await expect(item, kind).toBeVisible({ timeout: 30_000 })
    await expect(wordsOf(item), `${kind}: its words box`).toBeVisible({ timeout: 30_000 })
    await expect(item.getByTestId('org-answer-other'), `${kind}: no opener`).toHaveCount(0)
    await expect(item.getByRole('button', { name: /^(Reply|Other)…$/ }), `${kind}: no opener`).toHaveCount(0)
    // No heading, kind word or age on it: what it asks, a line of why, the box and its buttons.
    // The block's heading is for a screen reader only.
    expect((await card.locator('.action-needed-title').boundingBox())?.width ?? 0).toBeLessThanOrEqual(1)
    await expect(item.getByTestId('action-kind')).toHaveCount(0)
    await expect(item.getByTestId('action-snooze')).toBeVisible()
  }
  // A line of why under what it asks, when it has one.
  const ask = itemOf(await showSectionCard(page, 'needs', ids.ask), 'ask')
  await expect(ask.getByTestId('action-detail')).toHaveText('The venue costs 380 now; 400 leaves a little room.')
  // A letter's line of why is its own words, never the kind words Walnut leads it with.
  const letter = itemOf(await showSectionCard(page, 'needs', ids.letter), 'letter')
  await expect(letter.getByTestId('action-detail')).toBeVisible()
  await expect(letter.getByTestId('action-detail')).not.toContainText('Yours to decide')
  // An approval still needs its Approve: the box only talks to its session.
  const approval = itemOf(await showSectionCard(page, 'needs', ids.approval), 'approval')
  await expect(approval.getByRole('button', { name: 'Approve' })).toBeVisible()
  await expect(approval.getByTestId('org-answer-input')).toHaveAttribute('placeholder', /Approve still needed/)
})

test('a reply that fails keeps its words in the box, and the box is its own', async ({ page }) => {
  await openNeeds(page)
  // The server refuses the letter's reply once: the row comes back with the reason and the words.
  let refused = 0
  await page.route('**/api/v1/human-inbox/*/human-reply', async (route) => {
    if (refused++ === 0) await route.fulfill({ status: 500, body: '{"error":"down"}', contentType: 'application/json' })
    else await route.continue()
  })
  const letter = () => itemOf(page.locator('body'), 'letter').first()
  const box = () => letter().getByTestId('org-answer-input')
  await showSectionCard(page, 'needs', ids.letter)
  await box().fill(`Sign it on Friday ${STAMP}`)
  await box().press('Enter')
  await expect(letter().getByTestId('org-answer-error')).toBeVisible({ timeout: 30_000 })
  await expect(box()).toHaveValue(`Sign it on Friday ${STAMP}`)
  // Its words live under the card's own key: the task's session composer never shows them.
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => localStorage.getItem(k)?.includes('Sign it on Friday')))
  expect(keys.every((k) => k.startsWith('draft:letter-reply:')), keys.join(',')).toBe(true)
  await page.unroute('**/api/v1/human-inbox/*/human-reply')
  await box().fill('')
})

test('wide: the buttons and Snooze beside the box; narrow: on the line under it', async ({ page }) => {
  await openNeeds(page)
  const item = itemOf(await showSectionCard(page, 'needs', ids.ask), 'ask')
  const box = () => item.locator('.org-answer-words').first()
  const yes = () => item.getByTestId('org-answer-option').first()
  const snooze = () => item.getByTestId('action-snooze')
  const mid = async (l: Locator) => { const b = (await l.boundingBox())!; return b.y + b.height / 2 }
  await expect(box()).toBeVisible({ timeout: 30_000 })
  const wide = (await item.boundingBox())!.width
  if (wide >= 600) {
    expect(Math.abs((await mid(yes())) - (await mid(box()))), 'Yes beside the box').toBeLessThan(10)
    expect(Math.abs((await mid(snooze())) - (await mid(box()))), 'Snooze beside the box').toBeLessThan(10)
  }
  await page.screenshot({ path: `test-results/ask-card-wide-${test.info().project.name}.png`, clip: (await item.boundingBox())! })
  // A narrow window: the list's column is under 600 px.
  await page.setViewportSize({ width: 820, height: 900 })
  await expect.poll(async () => (await item.boundingBox())?.width ?? 0).toBeLessThan(600)
  const b = (await box().boundingBox())!
  expect((await yes().boundingBox())!.y, 'Yes under the box').toBeGreaterThanOrEqual(b.y + b.height - 1)
  expect((await snooze().boundingBox())!.y, 'Snooze under the box').toBeGreaterThanOrEqual(b.y + b.height - 1)
  await page.screenshot({ path: `test-results/ask-card-narrow-${test.info().project.name}.png`, clip: (await item.boundingBox())! })
})
